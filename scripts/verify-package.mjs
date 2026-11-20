#!/usr/bin/env node
/**
 * package 发布门禁（0.1.0 静态阶段）。
 *
 * 用真实 `pack --dry-run` 校验将要发布的内容，而不是只看 package.json：
 * 1. 清单：exports 包含 `./cordis.patch.yml`，files 覆盖 Host/Client/locale/
 *    icon/WASM/README/patch，`pnpm verify` 聚合全部静态步骤；
 * 2. 真实 dry-run pack 文件清单与大小，既不能缺少必需产物，也不能夹带源码/
 *    测试/文档/锁文件；
 * 3. Host 产物导出 `apply(ctx, config)`，Client 产物以包名注册 lazy factory、
 *    无 Host Client 值导入、无第二份 React/ReactDOM、保留 external react；
 * 4. 产物与 locale 中不存在 `web_fetch`、Fetch 配置键或 Fetch UI（0.1.0 不实现
 *    Fetch）；
 * 5. 全部待发布文本中不存在凭据/秘密；
 * 6. README/locale 如实披露数据发送对象、OFF 行为、自动端点第二次请求/配额、
 *    最近成功域持久化、JetHub 互斥、0.1.0 不含 Fetch，且不再保留骨架旧文案。
 *
 * 用法：node scripts/verify-package.mjs [--root <dir>]
 * `--root` 只服务于门禁自身的变异测试（临时副本），默认当前仓库根。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const SELF_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 解析 `--root`。 */
function parseRoot(argv) {
  const index = argv.indexOf('--root')
  if (index === -1) return SELF_ROOT
  const value = argv[index + 1]
  if (value === undefined || value === '') throw new Error('--root 缺少目录参数')
  return path.resolve(value)
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('用法：node scripts/verify-package.mjs [--root <dir>]')
  process.exit(0)
}

const ROOT = parseRoot(process.argv.slice(2))
const manifestPath = path.join(ROOT, 'package.json')

/** 必须出现在 package.json `files` 中的发布内容。 */
const REQUIRED_FILES = [
  'lib/index.js',
  'lib/client.js',
  'locale/*.json',
  'icon.svg',
  'assets/qoder/qoder-auth-wasm.wasm',
  'README.md',
  'cordis.patch.yml',
]

/** 真实 dry-run pack 的精确文件集合。 */
const EXPECTED_PACK = [
  'README.md',
  'assets/qoder/qoder-auth-wasm.wasm',
  'cordis.patch.yml',
  'icon.svg',
  'lib/client.js',
  'lib/index.js',
  'locale/en.json',
  'locale/zh.json',
  'package.json',
]

/** 不允许进入发布包的前缀。 */
const FORBIDDEN_PACK_PREFIXES = [
  'src/',
  'tests/',
  'scripts/',
  'docs/',
  'node_modules/',
  '.agents/',
  '.superpowers/',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'vitest.config.ts',
]

/** Fetch 接管/配置键/UI 标记；`0.1.0` 只实现 Search，不允许出现。 */
const FETCH_MARKERS = /web_fetch|fetchProvider|fetchEnabled|fetch_provider|fetchSettings|fetch\.enabled/gi

/** 待发布文本中的疑似凭据/秘密。 */
const SECRET_PATTERNS = [
  { name: '私钥', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: 'sk/pk 密钥', pattern: /\b(?:sk|pk)-[A-Za-z0-9]{16,}\b/ },
  { name: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  {
    name: 'token/secret 赋值',
    pattern:
      /\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|app[_-]?secret)\s*[:=]\s*["'][A-Za-z0-9._~+/-]{20,}["']/i,
  },
]

/** README 必须披露的内容。 */
const README_TOKENS = [
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
]

/** README/locale 中不允许残留的 Task 1 骨架文案。 */
const STALE_TOKENS = ['Task 1 骨架', '骨架当前', '尚未接管搜索', 'skeleton']

/** zh locale 必须披露的内容。 */
const ZH_TOKENS = ['web_search', '接管', '厂商', 'OFF', '第二次', '配额', '最近成功域', '持久', 'JetHub', 'Fetch']

/** en locale 必须披露的内容。 */
const EN_TOKENS = [
  'web_search',
  'vendor',
  'OFF',
  'second request',
  'quota',
  'last successful host',
  'persisted',
  'JetHub',
  'Fetch',
]

/** 断言。 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** 读取文本。 */
async function readText(relativePath) {
  return readFile(path.join(ROOT, relativePath), 'utf8')
}

/** 运行真实 dry-run pack。 */
function runDryRunPack() {
  const isWindows = process.platform === 'win32'
  const npm = isWindows ? 'npm.cmd' : 'npm'
  const first = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    shell: isWindows,
  })
  if (first.error === undefined) return first
  const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm'
  return spawnSync(pnpm, ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    shell: isWindows,
  })
}

/** 从 pack 输出中解析文件清单（兼容 npm/pnpm 两种 JSON 形状）。 */
function parsePackOutput(stdout) {
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  assert(start !== -1 && end > start, 'pack --json 未返回 JSON 数组')
  const parsed = JSON.parse(stdout.slice(start, end + 1))
  assert(Array.isArray(parsed) && parsed.length > 0, 'pack --json 返回空结果')
  const entry = parsed[0]
  const files = Array.isArray(entry.files) ? entry.files : []
  return files.map(file => {
    if (typeof file === 'string') return { path: file, size: 0 }
    return { path: String(file.path ?? ''), size: Number(file.size ?? 0) }
  })
}

/** 各项检查；每个检查失败都会被收集，最后统一以非零码退出。 */
const checks = [
  ['package.json 清单与验证聚合', async () => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert(manifest.name === 'dsh-web-search-channels', `包名应为 dsh-web-search-channels，实际 ${manifest.name}`)
    assert(manifest.version === '0.1.0', `版本应为 0.1.0，实际 ${manifest.version}`)
    assert(manifest.exports?.['.'] === './lib/index.js', 'exports["."] 必须指向 Host 产物')
    assert(manifest.exports?.['./client'] === './lib/client.js', 'exports["./client"] 必须指向 Client 产物')
    assert(
      manifest.exports?.['./cordis.patch.yml'] === './cordis.patch.yml',
      'exports 缺少 "./cordis.patch.yml"',
    )
    assert(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch 必须指向 cordis.patch.yml')
    assert(manifest.dsh?.client?.platform === 'web', 'dsh.client.platform 必须为 web')
    for (const required of REQUIRED_FILES) {
      assert(
        Array.isArray(manifest.files) && manifest.files.includes(required),
        `package.json files 缺少必需文件：${required}`,
      )
    }
    const verify = manifest.scripts?.verify
    assert(typeof verify === 'string', 'package.json 缺少 verify 脚本')
    for (const step of [
      'typecheck',
      'build',
      'test',
      'test:integration',
      'verify-build.mjs',
      'verify-css-isolation.mjs',
      'verify-package.mjs',
    ]) {
      assert(verify.includes(step), `pnpm verify 未聚合 ${step}`)
    }
    assert(
      typeof manifest.scripts?.['test:integration'] === 'string' &&
        manifest.scripts['test:integration'].includes('tests/integration'),
      'package.json 缺少覆盖 tests/integration 的 test:integration 脚本',
    )
  }],
  ['cordis.patch.yml 与 dsh 声明', async () => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const patch = YAML.parse(await readText('cordis.patch.yml'))
    const patchLayer = Array.isArray(patch) ? patch[0] : patch
    assert(Array.isArray(patchLayer?.insert) && patchLayer.insert.length > 0, 'cordis.patch.yml 缺少 insert 行')
    const row = patchLayer.insert[0]
    assert(row?.id === manifest.name, `patch 行 id 应为 ${manifest.name}，实际 ${row?.id}`)
    assert(row?.name === manifest.name, `patch 行 name 应为 ${manifest.name}，实际 ${row?.name}`)
  }],
  ['Host 产物契约', async () => {
    const host = await readText('lib/index.js')
    assert(host.trim() !== '', 'lib/index.js 为空')
    assert(/function\s+apply\s*\(\s*ctx\s*,\s*config\s*\)/.test(host), 'Host 产物未导出 apply(ctx, config)')
    assert(/export\s*\{[^}]*\bapply\b[^}]*\}/.test(host), 'Host 产物未导出 apply 符号')
    assert(!host.includes('@deepseek-ai/dsh-client-'), 'Host 产物引用了 Harness Client 包')
  }],
  ['Client 产物纯度', async () => {
    const client = await readText('lib/client.js')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert(client.includes('window.__ModuleLoader__.load('), 'Client 产物缺少 ModuleLoader 包装')
    assert(client.includes(`id: ${JSON.stringify(manifest.name)}`), 'Client factory id 不等于包名')
    assert(/factory\s*\(\s*require\s*\)/.test(client), 'Client factory 未接收 require')
    assert(/return\s+module\.exports/.test(client), 'Client factory 未返回 module.exports')
    const forbidden = [
      ...client.matchAll(/require\(\s*['"]@deepseek-ai\/[^'"]+['"]\s*\)/g),
      ...client.matchAll(/from\s*['"]@deepseek-ai\/[^'"]+['"]/g),
    ].map(match => match[0])
    assert(forbidden.length === 0, `Client 产物含 Harness Client 值导入：${forbidden.join(', ')}`)
    const reactMarkers = [
      '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED',
      'react.production.min',
      'react.development.js',
      'ReactDOM',
    ].filter(marker => client.includes(marker))
    assert(reactMarkers.length === 0, `Client 产物含第二份 React/ReactDOM 标记：${reactMarkers.join(', ')}`)
    assert(/require\(\s*['"]react['"]\s*\)/.test(client), 'react 未保持 external 运行时依赖')
    assert(client.includes('data-plugin-css'), 'Client 产物未包含样式表注入')
    assert(client.includes(`${manifest.name}/src/`), 'CSS Modules 样式标识未包含包名/相对路径')
  }],
  ['最终样式表已注入', async () => {
    const client = await readText('lib/client.js')
    const stylesheets = (client.match(/style\.textContent\s*=/g) ?? []).length
    assert(stylesheets > 0, 'Client 产物没有最终样式表')
  }],
  ['无 Fetch 配置键或 UI', async () => {
    const texts = [
      ['lib/index.js', await readText('lib/index.js')],
      ['lib/client.js', await readText('lib/client.js')],
      ['locale/zh.json', await readText('locale/zh.json')],
      ['locale/en.json', await readText('locale/en.json')],
    ]
    for (const [file, text] of texts) {
      const found = [...new Set([...text.matchAll(FETCH_MARKERS)].map(match => match[0]))]
      assert(found.length === 0, `产物含 Fetch 配置键或 UI 标记：${file} → ${found.join(', ')}`)
    }
  }],
  ['待发布文本无凭据/秘密', async () => {
    const files = [
      'README.md',
      'cordis.patch.yml',
      'locale/zh.json',
      'locale/en.json',
      'lib/index.js',
      'lib/client.js',
    ]
    for (const file of files) {
      const text = await readText(file)
      for (const { name, pattern } of SECRET_PATTERNS) {
        const match = pattern.exec(text)
        assert(match === null, `发现疑似秘密（${name}）：${file}`)
      }
    }
  }],
  ['README 披露真实功能与未验证边界', async () => {
    const readme = await readText('README.md')
    for (const token of README_TOKENS) {
      assert(readme.includes(token), `README 缺少披露项：${token}`)
    }
    for (const stale of STALE_TOKENS) {
      assert(!readme.includes(stale), `README 仍保留骨架旧文案：${stale}`)
    }
  }],
  ['locale 披露真实功能与边界', async () => {
    const zh = JSON.parse(await readText('locale/zh.json'))
    const en = JSON.parse(await readText('locale/en.json'))
    assert(typeof zh.meta?.title === 'string' && zh.meta.title !== '', 'zh.json 缺少 meta.title')
    assert(typeof en.meta?.title === 'string' && en.meta.title !== '', 'en.json 缺少 meta.title')
    assert(typeof zh.meta?.description === 'string', 'zh.json 缺少 meta.description')
    assert(typeof en.meta?.description === 'string', 'en.json 缺少 meta.description')
    for (const token of ZH_TOKENS) {
      assert(zh.meta.description.includes(token), `zh locale 缺少披露项：${token}`)
    }
    for (const token of EN_TOKENS) {
      assert(en.meta.description.includes(token), `en locale 缺少披露项：${token}`)
    }
    for (const stale of STALE_TOKENS) {
      assert(!zh.meta.description.includes(stale), `zh locale 仍保留骨架旧文案：${stale}`)
      assert(!en.meta.description.includes(stale), `en locale 仍保留骨架旧文案：${stale}`)
    }
  }],
  ['展示资源与 WASM 存在且非空', async () => {
    assert(existsSync(path.join(ROOT, 'icon.svg')), '缺少 icon.svg')
    const icon = await readText('icon.svg')
    assert(icon.includes('<svg'), 'icon.svg 不是 SVG')
    const wasm = await readFile(path.join(ROOT, 'assets', 'qoder', 'qoder-auth-wasm.wasm'))
    assert(wasm.byteLength > 100_000, `Qoder WASM 体积异常：${wasm.byteLength}`)
    const readme = await readText('README.md')
    assert(readme.trim().length > 500, 'README 内容过短')
  }],
  ['真实 dry-run pack 内容', async () => {
    const result = runDryRunPack()
    assert(result.error === undefined, `无法运行 pack：${result.error?.message ?? ''}`)
    assert(result.status === 0, `pack --dry-run 失败：${(result.stderr ?? '').trim()}`)
    const files = parsePackOutput(result.stdout ?? '')
    const paths = files.map(file => file.path).sort()
    for (const expected of EXPECTED_PACK) {
      const file = files.find(entry => entry.path === expected)
      assert(file !== undefined, `dry-run pack 缺少必需产物：${expected}`)
      assert(file.size > 0, `dry-run pack 产物为空：${expected}`)
      console.log(`  pack  ${expected} (${file.size} bytes)`)
    }
    for (const entry of paths) {
      assert(!FORBIDDEN_PACK_PREFIXES.some(prefix => entry.startsWith(prefix)), `发布包夹带禁止内容：${entry}`)
    }
    const unexpected = paths.filter(entry => !EXPECTED_PACK.includes(entry))
    assert(unexpected.length === 0, `发布包出现未登记文件：${unexpected.join(', ')}`)
    console.log(`  pack  文件数=${files.length}`)
  }],
]

const failures = []
for (const [name, run] of checks) {
  try {
    await run()
    console.log(`  ok  ${name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failures.push({ name, message })
    console.error(`  FAIL ${name}: ${message}`)
  }
}

if (failures.length > 0) {
  console.error(`\nverify-package: ${failures.length}/${checks.length} 项失败`)
  process.exit(1)
}

console.log(`\nverify-package: ${checks.length}/${checks.length} 项通过`)
