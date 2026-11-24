#!/usr/bin/env node
/**
 * 构建本 bundle 的两个半体：
 *
 * - Host：`src/host/index.ts` → `lib/index.js`（ESM；Harness 运行时提供依赖）
 * - Client：`src/client/index.ts` → `lib/client.js`。esbuild 先产 CJS，再包成
 *   `window.__ModuleLoader__.load({ id: package.name, factory })`；React/ReactDOM
 *   是 external，因此产物里只有 `require("react")`，不会打入第二份 React。
 *
 * CSS Modules 的类名哈希输入是「包名 + 包内相对路径 + 原始类名」，产物类名
 * 因此不会与其他插件或宿主冲突；样式表以 `data-plugin-css` 幂等注入。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const LIB = path.join(ROOT, 'lib')

const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
if (typeof manifest.name !== 'string' || manifest.name === '') {
  throw new Error('package.json 缺少包名，无法生成 ModuleLoader id 与 CSS 类名哈希')
}

/**
 * 计算 CSS Modules 类名：哈希输入包含包名。
 * @param {string} relativePath 包内相对路径（正斜杠）。
 * @param {string} className 原始类名。
 * @returns {string} 带 8 位十六进制后缀的类名。
 */
function hashClassName(relativePath, className) {
  return createHash('sha256')
    .update(`${manifest.name}/${relativePath}#${className}`)
    .digest('hex')
    .slice(0, 8)
}

/** esbuild 插件：把 `.module.css` 编译成「注入样式 + 导出类名映射」的 JS 模块。 */
const cssModules = {
  name: 'dsh-web-search-replace-css-modules',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /\.module\.css$/ }, async (args) => {
      const relativePath = path.relative(ROOT, args.path).split(path.sep).join('/')
      const source = await readFile(args.path, 'utf8')
      const classNames = [...new Set(
        [...source.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)].map((match) => match[1]),
      )]
      const mapping = Object.fromEntries(
        classNames.map((className) => [className, `${className}_${hashClassName(relativePath, className)}`]),
      )
      const scoped = source.replace(
        /\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g,
        (match, className) => `.${mapping[className] ?? className}`,
      )
      const styleId = `${manifest.name}/${relativePath}`
      const contents = [
        `const styleId = ${JSON.stringify(styleId)};`,
        `const selector = 'style[data-plugin-css=' + JSON.stringify(styleId) + ']';`,
        `if (typeof document < 'u' && document.querySelector(selector) === null) {`,
        `  const style = document.createElement('style');`,
        `  style.dataset.plugin = ${JSON.stringify(manifest.name)};`,
        `  style.dataset.pluginCss = styleId;`,
        `  style.textContent = ${JSON.stringify(scoped)};`,
        `  document.head.append(style);`,
        `}`,
        `export default ${JSON.stringify(mapping)};`,
        '',
      ].join('\n')
      return { contents, loader: 'js', resolveDir: path.dirname(args.path) }
    })
  },
}

await mkdir(LIB, { recursive: true })

// Host 半体：ESM 插件模块，Harness 包由运行时提供。
await build({
  absWorkingDir: ROOT,
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  logLevel: 'info',
})

// Client 半体：先产 CJS，再包成 ModuleLoader 的 lazy factory。
const client = await build({
  absWorkingDir: ROOT,
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  external: ['react', 'react-dom'],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [cssModules],
  logLevel: 'info',
})

const [output] = client.outputFiles
if (output === undefined) throw new Error('esbuild 未产出 Client 代码')

const wrapped = [
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(manifest.name)},`,
  '  factory(require) {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  output.text.trimEnd(),
  '    return module.exports;',
  '  },',
  '});',
  '',
].join('\n')

await writeFile(path.join(LIB, 'client.js'), wrapped, 'utf8')

console.log(`built lib/index.js and lib/client.js for ${manifest.name}@${manifest.version}`)
