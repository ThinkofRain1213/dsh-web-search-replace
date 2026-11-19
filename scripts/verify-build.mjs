#!/usr/bin/env node
/**
 * 校验构建产物满足安装契约（`pnpm build` 之后运行）：
 *
 * 1. `lib/index.js` 导出 `apply(ctx, config)`；
 * 2. `lib/client.js` 以包名为 id 注册 lazy factory，且 factory 接收 `require`；
 * 3. `lib/client.js` 没有 Harness Client 包的值导入；
 * 4. `lib/client.js` 没有打包第二份 React/ReactDOM，只保留 external 的 `require("react")`；
 * 5. CSS Modules 类名确实按「包名 + 相对路径 + 类名」哈希，且样式表标识包含包名；
 * 6. 安装所需的展示资源存在；
 * 7. Qoder 真实签名 WASM 进入 package files，且二进制 SHA256 未被改写。
 *
 * 任何一项失败都以非零码退出，并打印全部失败项。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
const packageName = manifest.name

/** 读取产物文本。 */
async function readLib(file) {
  return readFile(path.join(ROOT, 'lib', file), 'utf8')
}

/** 断言。 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** 各项检查。 */
const checks = [
  ['lib/index.js 导出 apply(ctx, config)', async () => {
    const host = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
    assert(typeof host.apply === 'function', 'lib/index.js 未导出 apply 函数')
    assert(host.apply.length === 2, `apply 期望 (ctx, config) 两个参数，实际 ${host.apply.length}`)
  }],
  ['lib/client.js 以包名注册 lazy factory', async () => {
    const code = await readLib('client.js')
    assert(code.includes('window.__ModuleLoader__.load('), '缺少 window.__ModuleLoader__.load 包装')
    assert(code.includes(`id: ${JSON.stringify(packageName)}`), `factory id 不等于包名 ${packageName}`)
    assert(/factory\s*\(\s*require\s*\)/.test(code), 'factory 未接收 require')
    assert(/return\s+module\.exports/.test(code), 'factory 未返回 module.exports')
  }],
  ['lib/client.js 不含 Harness Client 值导入', async () => {
    const code = await readLib('client.js')
    const requires = [...code.matchAll(/require\(\s*['"]@deepseek-ai\/[^'"]+['"]\s*\)/g)].map((match) => match[0])
    assert(requires.length === 0, `存在 Harness Client 包值导入：${requires.join(', ')}`)
    const imports = [...code.matchAll(/from\s*['"]@deepseek-ai\/[^'"]+['"]/g)].map((match) => match[0])
    assert(imports.length === 0, `存在 Harness Client 包 import 语句：${imports.join(', ')}`)
  }],
  ['lib/client.js 不打包第二份 React', async () => {
    const code = await readLib('client.js')
    const markers = [
      '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED',
      'react.production.min',
      'react.development.js',
      'ReactDOM',
    ]
    const found = markers.filter((marker) => code.includes(marker))
    assert(found.length === 0, `产物包含 React/ReactDOM 实现标记：${found.join(', ')}`)
    assert(/require\(\s*['"]react['"]\s*\)/.test(code), 'react 未被保留为 external 运行时依赖')
  }],
  ['CSS Modules 类名哈希输入包含包名', async () => {
    const code = await readLib('client.js')
    const relativePath = 'src/client/styles/settings-card.module.css'
    const expected = `stack_${createHash('sha256')
      .update(`${packageName}/${relativePath}#stack`)
      .digest('hex')
      .slice(0, 8)}`
    assert(code.includes(expected), `未出现按包名哈希的 .stack 类名 ${expected}`)
    assert(code.includes(`${packageName}/${relativePath}`), '样式表标识未包含包名与相对路径')
  }],
  ['展示资源齐全', async () => {
    for (const file of ['locale/zh.json', 'locale/en.json', 'icon.svg', 'README.md', 'cordis.patch.yml']) {
      const text = await readFile(path.join(ROOT, file), 'utf8')
      assert(text.trim() !== '', `${file} 为空`)
    }
    const zh = JSON.parse(await readFile(path.join(ROOT, 'locale/zh.json'), 'utf8'))
    const en = JSON.parse(await readFile(path.join(ROOT, 'locale/en.json'), 'utf8'))
    assert(typeof zh.meta?.title === 'string' && zh.meta.title !== '', 'zh.json 缺少 meta.title')
    assert(typeof en.meta?.title === 'string' && en.meta.title !== '', 'en.json 缺少 meta.title')
    assert(typeof zh.meta?.description === 'string' && zh.meta.description !== '', 'zh.json 缺少 meta.description')
    assert(typeof en.meta?.description === 'string' && en.meta.description !== '', 'en.json 缺少 meta.description')
  }],
  ['Qoder 签名 WASM 已打包且未被改写', async () => {
    const asset = 'assets/qoder/qoder-auth-wasm.wasm'
    assert(
      Array.isArray(manifest.files) && manifest.files.includes(asset),
      `package.json files 缺少 ${asset}`,
    )
    const bytes = await readFile(path.join(ROOT, asset))
    assert(bytes.byteLength > 0, `${asset} 为空`)
    const hash = createHash('sha256').update(bytes).digest('hex').toUpperCase()
    assert(
      hash === '6419471EFFA631519DEF7797D76D7EDE38B9FCFA9A83C2148C8EF5D43355B43D',
      `${asset} SHA256 与批准基线不一致：${hash}`,
    )
  }],
]

const failures = []
for (const [name, run] of checks) {
  try {
    await run()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, message: error instanceof Error ? error.message : String(error) })
    console.error(`  FAIL ${name}: ${failures.at(-1).message}`)
  }
}

if (failures.length > 0) {
  console.error(`\nverify-build: ${failures.length}/${checks.length} 项失败`)
  process.exit(1)
}

console.log(`\nverify-build: ${checks.length}/${checks.length} 项通过（${packageName}@${manifest.version}）`)
