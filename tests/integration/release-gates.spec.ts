/**
 * 发布门禁（静态阶段）：
 *
 * 证明以下检查不是靠代码审查口头声明，而是由真实脚本/真实产物执行：
 * 1. Vitest 实际发现 `tests/unit`、`tests/client`、`tests/integration` 中全部
 *    `*.spec.ts(x)` 文件，不是硬编码测试数；
 * 2. CSS 隔离脚本扫描全部最终样式表，并与同级已构建的 `dsh-project-groups`、
 *    `dsh-auto-expand` 做类名交集；反向对照在临时副本中同时还原双方旧哈希时
 *    必须被识别为冲突（证明哈希确实在承担隔离作用）；
 * 3. package 门禁执行真实 `pack --dry-run`，覆盖 Host/Client/locale/icon/WASM/
 *    README/patch；秘密扫描从真实 pack 清单派生（含 package.json、icon.svg，
 *    WASM 走可打印 ASCII 序列策略）；静态已失败的非 pack 变异确认跳过真实 pack，
 *    非法打包变异用 `--force-pack` 保留真实 pack；
 * 4. pack 调用为异步、无 shell、可取消的进程树模型，并有进程树 deadline 自证；
 * 5. README 与 locale 如实披露功能、数据发送对象、OFF 行为、自动端点第二次
 *    请求/配额、最近成功域持久化与换网后旧域一次失败自动纠正、JetHub 互斥与
 *    `0.1.0` 不含 Fetch，且不再保留 Task 1 骨架文案。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SCRIPTS = path.join(ROOT, 'scripts')
const README = path.join(ROOT, 'README.md')
const LOCALE_ZH = path.join(ROOT, 'locale', 'zh.json')
const LOCALE_EN = path.join(ROOT, 'locale', 'en.json')
const VERIFY_CSS = path.join(SCRIPTS, 'verify-css-isolation.mjs')
const VERIFY_PACKAGE = path.join(SCRIPTS, 'verify-package.mjs')
const PROCESS_TREE = path.join(SCRIPTS, 'process-tree.mjs')
const DOC = path.join(ROOT, 'docs', 'verification', '2026-11-18-0.1.0.md')

const tempDirs: string[] = []

afterAll(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

interface CommandResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly error?: Error | undefined
}

/** 终止子进程及其进程树；测试 deadline 必须能真正取消被测门禁。 */
async function killProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
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
}

/** 异步运行命令（shell=false）；超时终止完整进程树并标记 timedOut。 */
function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const { cwd = ROOT, timeoutMs = 90_000 } = options
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (status: number | null, error?: Error): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({
        status,
        stdout,
        stderr,
        timedOut,
        ...error === undefined ? {} : { error },
      })
    }
    timer = setTimeout(async () => {
      timedOut = true
      await killProcessTree(child)
      finish(null, new Error(`测试命令超时（${timeoutMs}ms），已终止完整进程树`))
    }, timeoutMs)
    child.stdout?.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('error', error => finish(null, error))
    child.on('close', status => finish(status))
  })
}

/** 以当前 Node 运行仓库内脚本，返回完整输出。 */
function runNodeScript(
  script: string,
  args: string[] = [],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return runProcess(process.execPath, [script, ...args], options)
}

/** 递归收集磁盘上的测试文件（相对路径，统一正斜杠）。 */
async function collectSpecFiles(): Promise<string[]> {
  const entries = await readdir(path.join(ROOT, 'tests'), { recursive: true })
  return entries
    .map(entry => entry.split(path.sep).join('/'))
    .filter(entry => /\.spec\.tsx?$/.test(entry))
    .map(entry => `tests/${entry}`)
    .sort()
}

/** 让 Vitest 自己报告发现到的测试文件。 */
async function discoverVitestFiles(): Promise<string[]> {
  const bin = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
  expect(existsSync(bin), `缺少 Vitest CLI：${bin}`).toBe(true)
  const result = await runProcess(process.execPath, [bin, 'list'], { timeoutMs: 60_000 })
  expect(result.status, `vitest list 失败：${result.stderr}`).toBe(0)
  const seen = new Set<string>()
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    // eslint-disable-next-line no-control-regex
    const line = rawLine.replace(/\u001B\[[0-9;]*m/g, '')
    const match = /^(.+?\.spec\.tsx?)\s+>/.exec(line)
    if (match?.[1] !== undefined) seen.add(match[1].split(path.sep).join('/'))
  }
  return [...seen].sort()
}

/** 读取 JSON 文件。 */
async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T
}

interface Manifest {
  readonly name: string
  readonly version: string
  readonly exports: Readonly<Record<string, string>>
  readonly files: readonly string[]
  readonly scripts: Readonly<Record<string, string>>
  readonly dsh: {
    readonly bundle: { readonly patch: string }
    readonly client: { readonly platform: string; readonly inject: readonly string[] }
  }
}

/** 复制真实发布内容到一个临时 package 根，供变异测试使用。 */
async function createPackageFixture(): Promise<string> {
  const fixture = await mkdtemp(path.join(tmpdir(), 'dsh-wsc-pkg-'))
  tempDirs.push(fixture)
  for (const file of ['package.json', 'README.md', 'cordis.patch.yml', 'icon.svg']) {
    await cp(path.join(ROOT, file), path.join(fixture, file))
  }
  for (const directory of ['lib', 'locale', 'assets']) {
    await cp(path.join(ROOT, directory), path.join(fixture, directory), { recursive: true })
  }
  return fixture
}

/** 运行 package 门禁（临时根）。 */
function runPackageGate(fixture: string, args: string[] = []): Promise<CommandResult> {
  return runNodeScript(VERIFY_PACKAGE, ['--root', fixture, ...args])
}

/** 断言 package 门禁对临时变异根失败，并给出可归因信息。 */
async function expectPackageGateFailure(
  fixture: string,
  expected: RegExp,
  args: string[] = [],
): Promise<CommandResult> {
  const result = await runPackageGate(fixture, args)
  const output = `${result.stdout}\n${result.stderr}`
  expect(result.status, `门禁应失败但通过了：\n${output}`).not.toBe(0)
  expect(output).toMatch(expected)
  return result
}

/** 静态阶段已知失败的非 pack 变异：必须跳过真实 pack。 */
async function expectGateFailureWithoutPack(
  fixture: string,
  expected: RegExp,
): Promise<CommandResult> {
  const result = await expectPackageGateFailure(fixture, expected)
  expect(result.stdout, '静态检查已失败时不应再执行真实 pack').toContain('pack 调用：0 次')
  expect(result.stdout).toContain('skip 真实 dry-run pack')
  return result
}

/** 修改 package.json 的 files 数组。 */
async function patchManifestFiles(
  fixture: string,
  mutate: (files: string[]) => string[],
): Promise<void> {
  const file = path.join(fixture, 'package.json')
  const manifest = await readJson<Manifest & { files: string[] }>(file)
  manifest.files.splice(0, manifest.files.length, ...mutate([...manifest.files]))
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

describe('发布门禁静态验证', () => {
  it('验证脚本、进程树工具、证据文档与 package 聚合声明存在', async () => {
    expect(existsSync(VERIFY_CSS), '缺少 scripts/verify-css-isolation.mjs').toBe(true)
    expect(existsSync(VERIFY_PACKAGE), '缺少 scripts/verify-package.mjs').toBe(true)
    expect(existsSync(PROCESS_TREE), '缺少 scripts/process-tree.mjs').toBe(true)
    expect(existsSync(DOC), '缺少 docs/verification/2026-11-18-0.1.0.md').toBe(true)

    const manifest = await readJson<Manifest>(path.join(ROOT, 'package.json'))
    expect(manifest.name).toBe('dsh-web-search-channels')
    expect(manifest.version).toBe('0.1.0')
    expect(manifest.exports['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    expect(manifest.exports['.']).toBe('./lib/index.js')
    expect(manifest.exports['./client']).toBe('./lib/client.js')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')

    for (const required of [
      'lib/index.js',
      'lib/client.js',
      'locale/*.json',
      'icon.svg',
      'assets/qoder/qoder-auth-wasm.wasm',
      'README.md',
      'cordis.patch.yml',
    ]) {
      expect(manifest.files, `package.json files 缺少 ${required}`).toContain(required)
    }

    expect(manifest.scripts['test:integration']).toContain('tests/integration')
    const verify = manifest.scripts.verify ?? ''
    for (const step of [
      'typecheck',
      'build',
      'test',
      'test:integration',
      'verify-build.mjs',
      'verify-css-isolation.mjs',
      'verify-package.mjs',
    ]) {
      expect(verify, `pnpm verify 未聚合 ${step}`).toContain(step)
    }
  })

  it('Vitest 发现 unit/client/integration 的全部测试文件', async () => {
    const disk = await collectSpecFiles()
    for (const directory of ['tests/unit/', 'tests/client/', 'tests/integration/']) {
      expect(disk.some(file => file.startsWith(directory)), `${directory} 没有测试文件`).toBe(true)
    }
    expect(disk).toContain('tests/integration/release-gates.spec.ts')
    expect(disk).toContain('tests/integration/required-runtime-matrix.spec.ts')

    const discovered = await discoverVitestFiles()
    expect(discovered, 'Vitest 发现清单与磁盘测试文件不一致').toEqual(disk)

    const config = await readFile(path.join(ROOT, 'vitest.config.ts'), 'utf8')
    expect(config, 'vitest 配置不得排除任何测试目录').not.toMatch(/\bexclude\s*:/)
    const manifest = await readJson<Manifest>(path.join(ROOT, 'package.json'))
    expect(manifest.scripts.test).toBe('vitest run')
  })

  it('CSS 隔离门禁扫描全部最终样式表且跨插件类名交集为空', async () => {
    expect(existsSync(VERIFY_CSS)).toBe(true)
    const result = await runNodeScript(VERIFY_CSS, [], { timeoutMs: 60_000 })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)

    const client = await readFile(path.join(ROOT, 'lib', 'client.js'), 'utf8')
    const selfStylesheets = (client.match(/style\.textContent\s*=/g) ?? []).length
    expect(selfStylesheets).toBeGreaterThan(0)
    expect(result.stdout).toContain(`stylesheets=${selfStylesheets}`)
    expect(result.stdout).toContain('dsh-project-groups')
    expect(result.stdout).toContain('dsh-auto-expand')
    expect(result.stdout).toMatch(/交集[：:]\s*0\b/)
  }, 30_000)

  it('CSS 反向对照：双方旧哈希同时还原时门禁按预期失败', async () => {
    expect(existsSync(VERIFY_CSS)).toBe(true)
    const result = await runNodeScript(VERIFY_CSS, ['--reverse-control'], { timeoutMs: 60_000 })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    for (const sibling of ['dsh-project-groups', 'dsh-auto-expand']) {
      const match = new RegExp(`reverse-control ${sibling} .*bothRestored=(\\d+)`).exec(result.stdout)
      expect(match, `缺少 ${sibling} 的反向对照结果`).not.toBeNull()
      expect(Number(match?.[1])).toBeGreaterThan(0)
    }
    expect(result.stdout).toContain('预期失败')
  }, 30_000)

  it('真实 dry-run package 门禁通过，秘密扫描从 pack 清单派生且无 DEP0190', async () => {
    expect(existsSync(VERIFY_PACKAGE)).toBe(true)
    const result = await runNodeScript(VERIFY_PACKAGE, [], { timeoutMs: 90_000 })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stderr, '不得再出现 shell:true 的 DEP0190').not.toContain('DEP0190')
    expect(result.stdout).toMatch(/dry-run pack/)
    expect(result.stdout).toContain('pack 调用：1 次')
    for (const file of [
      'lib/index.js',
      'lib/client.js',
      'locale/zh.json',
      'locale/en.json',
      'icon.svg',
      'assets/qoder/qoder-auth-wasm.wasm',
      'README.md',
      'cordis.patch.yml',
      'package.json',
    ]) {
      expect(result.stdout, `pack 输出缺少 ${file}`).toContain(file)
    }
    const scanLine = result.stdout.split(/\r?\n/).find(line => line.includes(' scan '))
    expect(scanLine, '缺少 pack 清单派生扫描证据').toBeDefined()
    expect(scanLine).toContain('package.json')
    expect(scanLine).toContain('icon.svg')
    expect(scanLine).toContain('可打印 ASCII')
  }, 60_000)

  it('进程树 deadline 可终止完整进程树且零 DEP0190', async () => {
    expect(existsSync(PROCESS_TREE)).toBe(true)
    const result = await runNodeScript(PROCESS_TREE, ['--self-test'], { timeoutMs: 30_000 })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('timedOut=1')
    expect(result.stdout).toContain('childAlive=0')
    expect(result.stdout).toContain('grandchildAlive=0')
    expect(result.stdout).toContain('dep0190=0')
    expect(result.stdout).toContain('shell=false')
    expect(result.stderr).not.toContain('DEP0190')
  }, 40_000)

  it('非法打包（从 files 移除 Client）会保留真实 pack 并被抓住', async () => {
    const fixture = await createPackageFixture()
    await patchManifestFiles(fixture, files => files.filter(file => file !== 'lib/client.js'))
    const result = await expectPackageGateFailure(
      fixture,
      /缺少必需文件.*lib\/client\.js|lib\/client\.js.*缺少/,
      ['--force-pack'],
    )
    expect(result.stdout).toContain('pack 调用：1 次')
    expect(`${result.stdout}\n${result.stderr}`).toContain('dry-run pack 缺少必需产物：lib/client.js')
  }, 60_000)

  it('Host/Client 全形态值导入与第二份 React 会被抓住且不执行真实 pack', async () => {
    const forbiddenForms = [
      'require("@deepseek-ai/dsh-client-ui-settings");',
      'import value from "@deepseek-ai/dsh-client-ui-settings";',
      'import "@deepseek-ai/dsh-client-ui-settings";',
      'await import("@deepseek-ai/dsh-client-ui-settings");',
      'export * from "@deepseek-ai/dsh-client-ui-settings";',
    ]
    for (const form of forbiddenForms) {
      const importFixture = await createPackageFixture()
      const importClient = path.join(importFixture, 'lib', 'client.js')
      await writeFile(importClient, `${await readFile(importClient, 'utf8')}\n${form}\n`, 'utf8')
      await expectGateFailureWithoutPack(importFixture, /Harness Client/)
    }

    const reactFixture = await createPackageFixture()
    const reactClient = path.join(reactFixture, 'lib', 'client.js')
    await writeFile(
      reactClient,
      `${await readFile(reactClient, 'utf8')}\nvar marker = "__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED";\n`,
      'utf8',
    )
    await expectGateFailureWithoutPack(reactFixture, /React/)
  }, 60_000)

  it('Fetch 配置键或 UI 会被抓住且不执行真实 pack', async () => {
    const fixture = await createPackageFixture()
    const client = path.join(fixture, 'lib', 'client.js')
    await writeFile(
      client,
      `${await readFile(client, 'utf8')}\nvar fetchConfig = { web_fetch: true, fetchEnabled: true };\n`,
      'utf8',
    )
    await expectGateFailureWithoutPack(fixture, /Fetch/)
  }, 60_000)

  it('README 中的凭据秘密会被 pack 清单派生扫描抓住', async () => {
    const fixture = await createPackageFixture()
    const readme = path.join(fixture, 'README.md')
    await writeFile(
      readme,
      `${await readFile(readme, 'utf8')}\nAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXRlc3Q\n`,
      'utf8',
    )
    const result = await expectPackageGateFailure(fixture, /发现疑似秘密（JWT）：README\.md/)
    expect(result.stdout).toContain('pack 调用：1 次')
  }, 60_000)

  it('package.json 与 icon.svg 中的秘密会被 pack 清单派生扫描抓住', async () => {
    const packageFixture = await createPackageFixture()
    const packageFile = path.join(packageFixture, 'package.json')
    const manifest = await readJson<Record<string, unknown>>(packageFile)
    manifest.fixtureSecret =
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXRlc3Q'
    await writeFile(packageFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    const packageResult = await expectPackageGateFailure(
      packageFixture,
      /发现疑似秘密（JWT）：package\.json/,
    )
    expect(packageResult.stdout).toContain('pack 调用：1 次')

    const iconFixture = await createPackageFixture()
    const iconFile = path.join(iconFixture, 'icon.svg')
    await writeFile(
      iconFile,
      `${await readFile(iconFile, 'utf8')}\n<!-- -----BEGIN PRIVATE KEY----- -->\n`,
      'utf8',
    )
    const iconResult = await expectPackageGateFailure(
      iconFixture,
      /发现疑似秘密（私钥）：icon\.svg/,
    )
    expect(iconResult.stdout).toContain('pack 调用：1 次')
  }, 90_000)

  it('README 缺失数据发送披露会被抓住且不执行真实 pack', async () => {
    const fixture = await createPackageFixture()
    const readme = path.join(fixture, 'README.md')
    const text = await readFile(readme, 'utf8')
    expect(text).toContain('发送')
    await writeFile(readme, text.replaceAll('发送', '处理'), 'utf8')
    await expectGateFailureWithoutPack(fixture, /披露/)
  }, 60_000)

  it('zh/en locale 缺失换网后旧优选域披露会被抓住且不执行真实 pack', async () => {
    const zhFixture = await createPackageFixture()
    const zhFile = path.join(zhFixture, 'locale', 'zh.json')
    const zh = await readJson<{ meta: { description: string } }>(zhFile)
    await writeFile(
      zhFile,
      `${JSON.stringify(
        {
          meta: {
            ...zh.meta,
            description: zh.meta.description.replace('换网络后旧优选域可能先失败一次再自动纠正', '换网络行为未说明'),
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await expectGateFailureWithoutPack(zhFixture, /locale 缺少披露项：换网络后旧优选域可能先失败一次再自动纠正/)

    const enFixture = await createPackageFixture()
    const enFile = path.join(enFixture, 'locale', 'en.json')
    const en = await readJson<{ meta: { description: string } }>(enFile)
    await writeFile(
      enFile,
      `${JSON.stringify(
        {
          meta: {
            ...en.meta,
            description: en.meta.description.replace(
              'after a network change the old preferred host may fail once before auto-correction',
              'network change behaviour is unspecified',
            ),
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await expectGateFailureWithoutPack(
      enFixture,
      /locale 缺少披露项：after a network change the old preferred host may fail once before auto-correction/,
    )
  }, 60_000)

  it('README 与 zh/en locale 准确披露 0.1.0 功能与边界', async () => {
    const readme = await readFile(README, 'utf8')
    for (const token of [
      'web_search',
      'CodeBuddy',
      'WorkBuddy',
      'Qoder 国际版',
      'Qoder 中国版',
      'OFF',
      '发送',
      '厂商',
      '第二次',
      '配额',
      '最近成功域',
      'JetHub',
      'web_fetch',
      'NOT RUN',
      'PENDING',
      '0.1.0 尚未完成发布验收',
    ]) {
      expect(readme, `README 缺少披露项：${token}`).toContain(token)
    }
    for (const stale of ['Task 1 骨架', '骨架当前', '尚未接管搜索', 'skeleton']) {
      expect(readme, `README 仍保留骨架旧文案：${stale}`).not.toContain(stale)
    }

    const zh = await readJson<{ meta: { title: string; description: string } }>(LOCALE_ZH)
    const en = await readJson<{ meta: { title: string; description: string } }>(LOCALE_EN)
    for (const token of [
      'web_search',
      '接管',
      '厂商',
      'OFF',
      '第二次请求',
      '配额',
      '最近成功域',
      '持久',
      '换网络后旧优选域可能先失败一次再自动纠正',
      'JetHub',
      'Fetch',
    ]) {
      expect(zh.meta.description, `zh locale 缺少披露项：${token}`).toContain(token)
    }
    for (const token of [
      'web_search',
      'vendor',
      'OFF',
      'second request',
      'quota',
      'last successful host',
      'persisted',
      'after a network change the old preferred host may fail once before auto-correction',
      'JetHub',
      'Fetch',
    ]) {
      expect(en.meta.description, `en locale 缺少披露项：${token}`).toContain(token)
    }
    for (const stale of ['骨架', '尚未接管', 'skeleton', 'does not take over search']) {
      expect(zh.meta.description).not.toContain(stale)
      expect(en.meta.description).not.toContain(stale)
    }
  })
})