#!/usr/bin/env node
/**
 * 发布门禁的异步子进程工具：
 *
 * - 永远 `shell: false`，不拼接命令字符串（消除 Windows DEP0190 与注入面）；
 * - POSIX 以独立进程组启动，超时向整个进程组发 SIGKILL；
 * - Windows 超时使用 `taskkill /pid <pid> /T /F` 终止完整进程树；
 * - 返回 `timedOut`、退出码、stdout/stderr 与启动错误，便于调用方归因。
 *
 * 另提供 `--self-test`：启动一个会再派生孙进程的短命令，用 800ms deadline
 * 触发取消，证明父子进程都被终止且没有 DEP0190 警告。该模式只用于发布门禁
 * 自证，不参与打包（scripts/ 不在 package files 中）。
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 终止子进程及其整棵进程树。
 * @param {import('node:child_process').ChildProcess} child 已启动的子进程。
 */
export async function killProcessTree(child) {
  if (child.pid === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      })
      killer.on('exit', () => resolve())
      killer.on('error', () => resolve())
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // 进程组已退出时忽略。
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // 已退出时忽略。
  }
}

/**
 * 运行命令并返回可归因结果；超时后终止完整进程树。
 * @param {string} command 可执行文件。
 * @param {string[]} args 参数数组（绝不经过 shell）。
 * @param {{ cwd?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv }} options 选项。
 * @returns {Promise<{ status: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string, timedOut: boolean, error?: Error }>}
 */
export function runWithTimeout(command, args, options = {}) {
  const { cwd = process.cwd(), timeoutMs = 60_000, env = process.env } = options
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    const finish = (status, signal, error) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({
        status,
        signal,
        stdout,
        stderr,
        timedOut,
        ...error === undefined ? {} : { error },
      })
    }
    const timerHandle = setTimeout(async () => {
      timedOut = true
      await killProcessTree(child)
      finish(null, null, undefined)
    }, timeoutMs)
    timer = timerHandle
    child.stdout?.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('error', error => finish(null, null, error))
    child.on('close', (status, signal) => finish(status, signal, undefined))
  })
}

/** 进程是否仍可被 signal 0 探测到。 */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 等待条件成立或超时（支持异步条件）。 */
async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return await check()
}

/** 读取 PID 文件，容忍尚未写入。 */
async function readPid(file) {
  try {
    const text = (await readFile(file, 'utf8')).trim()
    return /^\d+$/.test(text) ? Number(text) : null
  } catch {
    return null
  }
}

/** 自证：超时可终止完整进程树（含孙进程）。 */
async function selfTest() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-process-tree-'))
  const grandchildScript = path.join(dir, 'grandchild.mjs')
  const childScript = path.join(dir, 'child.mjs')
  const childPidFile = path.join(dir, 'child.pid')
  const grandchildPidFile = path.join(dir, 'grandchild.pid')
  let childPid = null
  let grandchildPid = null
  let ok = false
  try {
    await writeFile(
      grandchildScript,
      [
        "import { writeFileSync } from 'node:fs'",
        'writeFileSync(process.argv[2], String(process.pid))',
        'setInterval(() => {}, 1000)',
        '',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      childScript,
      [
        "import { spawn } from 'node:child_process'",
        "import { writeFileSync } from 'node:fs'",
        'const [grandchildScript, childPidFile, grandchildPidFile] = process.argv.slice(2)',
        'spawn(process.execPath, [grandchildScript, grandchildPidFile], { stdio: "ignore" })',
        'writeFileSync(childPidFile, String(process.pid))',
        'setInterval(() => {}, 1000)',
        '',
      ].join('\n'),
      'utf8',
    )

    const result = await runWithTimeout(
      process.execPath,
      [childScript, grandchildScript, childPidFile, grandchildPidFile],
      { timeoutMs: 800 },
    )
    const pidsReady = await waitFor(
      async () => (await readPid(childPidFile)) !== null && (await readPid(grandchildPidFile)) !== null,
      5000,
    )
    childPid = await readPid(childPidFile)
    grandchildPid = await readPid(grandchildPidFile)
    const killed = await waitFor(
      () => childPid !== null && grandchildPid !== null && !isAlive(childPid) && !isAlive(grandchildPid),
      5000,
    )
    const dep0190 = `${result.stderr}\n${result.stdout}`.includes('DEP0190')
    console.log(
      `process-tree-self-test: timedOut=${result.timedOut ? 1 : 0} pidsRecorded=${pidsReady ? 1 : 0}` +
        ` childAlive=${childPid !== null && isAlive(childPid) ? 1 : 0}` +
        ` grandchildAlive=${grandchildPid !== null && isAlive(grandchildPid) ? 1 : 0}` +
        ` dep0190=${dep0190 ? 1 : 0} shell=false`,
    )
    ok = result.timedOut && pidsReady && killed && !dep0190
  } catch (error) {
    console.error(`process-tree-self-test: FAIL ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    // 兜底清理，避免自证失败留下进程。
    for (const pid of [childPid, grandchildPid]) {
      if (pid !== null && isAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // 忽略。
        }
      }
    }
    await rm(dir, { recursive: true, force: true })
  }
  if (!ok) {
    console.error('process-tree-self-test: FAIL 未能证明超时终止完整进程树且无 DEP0190')
    process.exit(1)
  }
  console.log('process-tree-self-test: PASS（deadline 终止父子进程、无 DEP0190）')
}

const isCli = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isCli) {
  if (process.argv.includes('--self-test')) {
    await selfTest()
  } else if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('用法：node scripts/process-tree.mjs --self-test')
  } else {
    console.error('用法：node scripts/process-tree.mjs --self-test')
    process.exit(1)
  }
}
