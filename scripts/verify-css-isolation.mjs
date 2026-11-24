#!/usr/bin/env node
/**
 * 跨插件 CSS 隔离门禁（0.1.0 发布静态阶段）。
 *
 * 1. 从本包最终产物 `lib/client.js` 提取全部注入样式表；样式表数量必须与
 *    `styleId` 声明数量一致，防止漏扫（portal 菜单沿用同一 CSS Modules 表）。
 * 2. 从同级**现有只读构建产物** `dsh-project-groups/lib/client.js`、
 *    `dsh-auto-expand/lib/client.js` 提取全部最终样式表与类名。
 * 3. 双方类名交集必须为空；否则列出冲突类名并以非零码退出。
 * 4. `--reverse-control` 在系统临时目录写副本，分别/同时还原双方旧哈希，
 *    用同一交集函数证明“双方旧哈希同时还原”时必然检出冲突，而单边还原不会。
 *    临时副本用完即删；不修改、不重建、不启用/停用任何其他插件产物。
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SELF_PATH = path.join(ROOT, 'lib', 'client.js')

/** 同级插件的候选路径：兼容主工作区与 `.agents/worktrees` 两种位置。 */
const SIBLINGS = [
  {
    name: 'dsh-project-groups',
    candidates: [
      process.env.DSH_CSS_PROJECT_GROUPS,
      path.resolve(ROOT, '..', '..', '..', '..', 'dsh-project-groups', 'lib', 'client.js'),
      path.resolve(ROOT, '..', 'dsh-project-groups', 'lib', 'client.js'),
    ],
  },
  {
    name: 'dsh-auto-expand',
    candidates: [
      process.env.DSH_CSS_AUTO_EXPAND,
      path.resolve(ROOT, '..', '..', '..', '..', 'dsh-auto-expand', 'lib', 'client.js'),
      path.resolve(ROOT, '..', 'dsh-auto-expand', 'lib', 'client.js'),
    ],
  },
]

const CSS_LITERAL = /(?:const\s+css(?:\$\w+)?\s*=\s*|style\.textContent\s*=\s*)("(?:[^"\\]|\\.)*")/g
const STYLE_ID = /(?:tagId|styleId)(?:\$\w+|\d+)?\s*=\s*"([^"]+)"/g
const MAPPING_OBJECT = /var\s+([A-Za-z0-9_$]+_default)\s*=\s*(\{(?:\s*"(?:[^"\\]|\\.)*"\s*:\s*"(?:[^"\\]|\\.)*"\s*,?)*\}\s*);/g
const CSS_CLASS = /\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g

/** 求值由构建产物内联的字符串字面量（只允许纯字符串，不执行任意代码）。 */
function evalStringLiteral(literal) {
  const value = vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 })
  if (typeof value !== 'string') throw new TypeError('样式表字面量不是字符串')
  return value
}

/**
 * 从单个最终产物中提取样式表、样式表标识与类名映射。
 * @param {string} text 产物文本。
 * @param {string} label 诊断标签。
 */
function analyze(text, label) {
  const payloads = []
  for (const match of text.matchAll(CSS_LITERAL)) {
    const literal = match[1]
    if (literal === undefined) continue
    payloads.push(evalStringLiteral(literal))
  }
  const styleIds = [...text.matchAll(STYLE_ID)].map(match => match[1])

  const restore = new Map()
  const conflicts = []
  for (const match of text.matchAll(MAPPING_OBJECT)) {
    const objectText = match[2]
    if (objectText === undefined) continue
    let mapping
    try {
      mapping = JSON.parse(objectText)
    } catch {
      continue
    }
    const keys = Object.keys(mapping)
    // locale 字典等对象也使用字符串键值；类名映射的键不含点、斜杠或空格。
    if (keys.length === 0 || keys.some(key => /[./\s]/.test(key))) continue
    for (const [original, hashed] of Object.entries(mapping)) {
      if (typeof hashed !== 'string' || !/^[A-Za-z0-9_-]+$/.test(hashed)) continue
      const existing = restore.get(hashed)
      if (existing !== undefined && existing !== original) {
        conflicts.push(`${hashed}: ${existing} / ${original}`)
        continue
      }
      restore.set(hashed, original)
    }
  }

  if (styleIds.length !== payloads.length) {
    throw new Error(
      `${label} 样式表清点不一致：styleId=${styleIds.length} 样式表=${payloads.length}` +
        '（可能有最终样式表未被扫描）',
    )
  }
  if (payloads.length === 0) throw new Error(`${label} 未找到任何最终样式表`)

  const classes = new Set()
  for (const payload of payloads) {
    const withoutComments = payload.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const match of withoutComments.matchAll(CSS_CLASS)) {
      const name = match[1]
      if (name !== undefined) classes.add(name)
    }
  }
  if (classes.size === 0) throw new Error(`${label} 样式表中没有类名`)
  return { payloads, styleIds, restore, classes, conflicts }
}

/** 求两个类名集合的交集（排序后输出）。 */
function intersect(left, right) {
  return [...left].filter(name => right.has(name)).sort()
}

/** 还原样式表中的旧哈希（用于反向对照；只改临时副本）。 */
function restoreClasses(css, restore) {
  if (restore.size === 0) return css
  return css.replace(CSS_CLASS, (full, name) => {
    const original = restore.get(name)
    return original === undefined ? full : `.${original}`
  })
}

/** 还原产物内全部样式表类名；至少命中一次才算有效。 */
function restoreClient(text, restore) {
  let changed = 0
  const rewritten = text.replace(CSS_LITERAL, (full, literal) => {
    const css = evalStringLiteral(literal)
    const restored = restoreClasses(css, restore)
    if (restored === css) return full
    changed += 1
    return full.slice(0, full.length - literal.length) + JSON.stringify(restored)
  })
  if (changed === 0) throw new Error('反向对照未能还原任何样式表类名')
  return rewritten
}

/** 解析一个同级插件的只读产物。 */
function resolveSibling(sibling) {
  for (const candidate of sibling.candidates) {
    if (candidate !== undefined && existsSync(candidate)) return candidate
  }
  const tried = sibling.candidates.filter(Boolean).join(', ')
  throw new Error(`缺少同级已构建产物 ${sibling.name}，已尝试：${tried}`)
}

/** 打印单个产物的清点结果。 */
function printInventory(role, name, info) {
  console.log(
    `verify-css-isolation: ${role} ${name} stylesheets=${info.payloads.length} classes=${info.classes.size}`,
  )
}

/** 正常门禁：读取真实产物并检查交集为空。 */
async function verifyReal() {
  if (!existsSync(SELF_PATH)) throw new Error(`缺少本包最终产物 ${SELF_PATH}（请先 pnpm build）`)
  const self = analyze(await readFile(SELF_PATH, 'utf8'), 'self')
  printInventory('self', 'dsh-web-search-replace', self)
  for (const styleId of self.styleIds) console.log(`verify-css-isolation:   stylesheet ${styleId}`)

  let totalIntersection = 0
  for (const sibling of SIBLINGS) {
    const file = resolveSibling(sibling)
    const info = analyze(await readFile(file, 'utf8'), sibling.name)
    printInventory('sibling', sibling.name, info)
    const collisions = intersect(self.classes, info.classes)
    totalIntersection += collisions.length
    if (collisions.length > 0) {
      console.error(`verify-css-isolation: 与 ${sibling.name} 类名冲突：${collisions.join(', ')}`)
    }
  }
  console.log(`verify-css-isolation: 类名交集：${totalIntersection}`)
  if (totalIntersection !== 0) throw new Error(`跨插件类名交集为 ${totalIntersection}，CSS 隔离失败`)
}

/** 在临时目录中写入副本并返回交集，用于证明检查本身有效。 */
async function measureTempPair(dir, selfText, siblingText, tag) {
  const selfFile = path.join(dir, `self-${tag}.client.js`)
  const siblingFile = path.join(dir, `sibling-${tag}.client.js`)
  await writeFile(selfFile, selfText, 'utf8')
  await writeFile(siblingFile, siblingText, 'utf8')
  const self = analyze(await readFile(selfFile, 'utf8'), `temp self ${tag}`)
  const sibling = analyze(await readFile(siblingFile, 'utf8'), `temp sibling ${tag}`)
  return intersect(self.classes, sibling.classes)
}

/** 反向对照：只在临时副本中分别/同时还原双方旧哈希。 */
async function reverseControl() {
  if (!existsSync(SELF_PATH)) throw new Error(`缺少本包最终产物 ${SELF_PATH}（请先 pnpm build）`)
  const selfText = await readFile(SELF_PATH, 'utf8')
  const self = analyze(selfText, 'self')
  if (self.restore.size === 0) throw new Error('self 产物没有可还原的类名映射')

  for (const sibling of SIBLINGS) {
    const siblingPath = resolveSibling(sibling)
    const siblingText = await readFile(siblingPath, 'utf8')
    const info = analyze(siblingText, sibling.name)
    if (info.restore.size === 0) throw new Error(`${sibling.name} 产物没有可还原的类名映射`)

    const selfOld = restoreClient(selfText, self.restore)
    const siblingOld = restoreClient(siblingText, info.restore)
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-css-isolation-'))
    try {
      const selfOldOnly = await measureTempPair(dir, selfOld, siblingText, 'self-old')
      const siblingOldOnly = await measureTempPair(dir, selfText, siblingOld, 'sibling-old')
      const bothRestored = await measureTempPair(dir, selfOld, siblingOld, 'both-old')
      console.log(
        `reverse-control ${sibling.name} selfOldOnly=${selfOldOnly.length}` +
          ` siblingOldOnly=${siblingOldOnly.length} bothRestored=${bothRestored.length}`,
      )
      if (selfOldOnly.length !== 0) {
        throw new Error(`${sibling.name} 单边还原 self 旧哈希就出现交集，反向对照无效`)
      }
      if (siblingOldOnly.length !== 0) {
        throw new Error(`${sibling.name} 单边还原 sibling 旧哈希就出现交集，反向对照无效`)
      }
      if (bothRestored.length === 0) {
        throw new Error(`${sibling.name} 双方旧哈希同时还原后交集仍为空，门禁无法证明冲突会被识别`)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  console.log('reverse-control: 预期失败被检出（双方旧哈希同时还原后交集非空）')
}

async function main() {
  const args = new Set(process.argv.slice(2))
  if (args.has('--help') || args.has('-h')) {
    console.log('用法：node scripts/verify-css-isolation.mjs [--reverse-control]')
    return
  }
  if (args.has('--reverse-control')) {
    await reverseControl()
    console.log('verify-css-isolation: PASS（反向对照）')
    return
  }
  await verifyReal()
  console.log('verify-css-isolation: PASS（全部最终样式表参与、类名交集为空）')
}

try {
  await main()
} catch (error) {
  console.error(`verify-css-isolation: FAIL ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
