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
 *    README/patch，并抓住非法打包、Host Client 值导入、第二份 React、Fetch
 *    配置键/UI 与凭据秘密；
 * 4. README 与 locale 如实披露功能、数据发送对象、OFF 行为、自动端点第二次
 *    请求/配额、最近成功域持久化、JetHub 互斥与 `0.1.0` 不含 Fetch，且不再
 *    保留 Task 1 骨架文案。
 */
import { spawnSync } from 'node:child_process'
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
const DOC = path.join(ROOT, 'docs', 'verification', '2026-11-18-0.1.0.md')

const tempDirs: string[] = []

afterAll(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

interface CommandResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: Error | undefined
}

/** 以当前 Node 运行仓库内脚本，返回完整输出。 */
function runNodeScript(script: string, args: string[] = [], cwd = ROOT): CommandResult {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...result.error === undefined ? {} : { error: result.error },
  }
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
function discoverVitestFiles(): string[] {
  const bin = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
  expect(existsSync(bin), `缺少 Vitest CLI：${bin}`).toBe(true)
  const result = spawnSync(process.execPath, [bin, 'list'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
  })
  expect(result.status, `vitest list 失败：${result.stderr ?? ''}`).toBe(0)
  const seen = new Set<string>()
  for (const rawLine of (result.stdout ?? '').split(/\r?\n/)) {
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

/** 断言 package 门禁对临时变异根失败，并给出可归因信息。 */
function expectPackageGateFailure(fixture: string, expected: RegExp): void {
  const result = runNodeScript(VERIFY_PACKAGE, ['--root', fixture])
  const output = `${result.stdout}\n${result.stderr}`
  expect(result.status, `门禁应失败但通过了：\n${output}`).not.toBe(0)
  expect(output).toMatch(expected)
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
  it('验证脚本、证据文档与 package 聚合声明存在', async () => {
    expect(existsSync(VERIFY_CSS), '缺少 scripts/verify-css-isolation.mjs').toBe(true)
    expect(existsSync(VERIFY_PACKAGE), '缺少 scripts/verify-package.mjs').toBe(true)
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

    const discovered = discoverVitestFiles()
    expect(discovered, 'Vitest 发现清单与磁盘测试文件不一致').toEqual(disk)

    const config = await readFile(path.join(ROOT, 'vitest.config.ts'), 'utf8')
    expect(config, 'vitest 配置不得排除任何测试目录').not.toMatch(/\bexclude\s*:/)
    const manifest = await readJson<Manifest>(path.join(ROOT, 'package.json'))
    expect(manifest.scripts.test).toBe('vitest run')
  })

  it('CSS 隔离门禁扫描全部最终样式表且跨插件类名交集为空', async () => {
    expect(existsSync(VERIFY_CSS)).toBe(true)
    const result = runNodeScript(VERIFY_CSS)
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)

    const client = await readFile(path.join(ROOT, 'lib', 'client.js'), 'utf8')
    const selfStylesheets = (client.match(/style\.textContent\s*=/g) ?? []).length
    expect(selfStylesheets).toBeGreaterThan(0)
    expect(result.stdout).toContain(`stylesheets=${selfStylesheets}`)
    expect(result.stdout).toContain('dsh-project-groups')
    expect(result.stdout).toContain('dsh-auto-expand')
    expect(result.stdout).toMatch(/交集[：:]\s*0\b/)
  }, 30_000)

  it('CSS 反向对照：双方旧哈希同时还原时门禁按预期失败', () => {
    expect(existsSync(VERIFY_CSS)).toBe(true)
    const result = runNodeScript(VERIFY_CSS, ['--reverse-control'])
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    for (const sibling of ['dsh-project-groups', 'dsh-auto-expand']) {
      const match = new RegExp(`reverse-control ${sibling} .*bothRestored=(\\d+)`).exec(result.stdout)
      expect(match, `缺少 ${sibling} 的反向对照结果`).not.toBeNull()
      expect(Number(match?.[1])).toBeGreaterThan(0)
    }
    expect(result.stdout).toContain('预期失败')
  }, 60_000)

  it('真实 dry-run package 门禁通过并覆盖全部必需产物', () => {
    expect(existsSync(VERIFY_PACKAGE)).toBe(true)
    const result = runNodeScript(VERIFY_PACKAGE)
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toMatch(/dry-run pack/)
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
  }, 60_000)

  it('非法打包（从 files 移除 Client）会被 package 门禁抓住', async () => {
    const fixture = await createPackageFixture()
    await patchManifestFiles(fixture, files => files.filter(file => file !== 'lib/client.js'))
    expectPackageGateFailure(fixture, /缺少必需文件.*lib\/client\.js|lib\/client\.js.*缺少/)
  }, 60_000)

  it('Host/Client 值导入与第二份 React 会被抓住', async () => {
    const importFixture = await createPackageFixture()
    const importClient = path.join(importFixture, 'lib', 'client.js')
    await writeFile(
      importClient,
      `${await readFile(importClient, 'utf8')}\nrequire("@deepseek-ai/dsh-client-ui-settings");\n`,
      'utf8',
    )
    expectPackageGateFailure(importFixture, /Harness Client/)

    const reactFixture = await createPackageFixture()
    const reactClient = path.join(reactFixture, 'lib', 'client.js')
    await writeFile(
      reactClient,
      `${await readFile(reactClient, 'utf8')}\nvar marker = "__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED";\n`,
      'utf8',
    )
    expectPackageGateFailure(reactFixture, /React/)
  }, 90_000)

  it('Fetch 配置键或 UI 会被抓住', async () => {
    const fixture = await createPackageFixture()
    const client = path.join(fixture, 'lib', 'client.js')
    await writeFile(
      client,
      `${await readFile(client, 'utf8')}\nvar fetchConfig = { web_fetch: true, fetchEnabled: true };\n`,
      'utf8',
    )
    expectPackageGateFailure(fixture, /Fetch/)
  }, 60_000)

  it('README 中的凭据秘密会被抓住', async () => {
    const fixture = await createPackageFixture()
    const readme = path.join(fixture, 'README.md')
    await writeFile(
      readme,
      `${await readFile(readme, 'utf8')}\nAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXRlc3Q\n`,
      'utf8',
    )
    expectPackageGateFailure(fixture, /秘密|secret/i)
  }, 60_000)

  it('README 缺失数据发送披露会被 package 门禁抓住', async () => {
    const fixture = await createPackageFixture()
    const readme = path.join(fixture, 'README.md')
    const text = await readFile(readme, 'utf8')
    expect(text).toContain('发送')
    await writeFile(readme, text.replaceAll('发送', '处理'), 'utf8')
    expectPackageGateFailure(fixture, /披露/)
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
      '第二次',
      '配额',
      '最近成功域',
      '持久',
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
