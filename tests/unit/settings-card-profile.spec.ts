/**
 * Task 13 剖面与布局契约：`docs/ui/settings-card-profile.md` 必须是一张从
 * `.stack` 顶部到卡片底的完整图（含条件块、Task 14 账号区/Qoder 端点行位置
 * 和全部 padding 归属），CSS 必须实现同一套间距、补偿与自有控件几何。
 *
 * 这里只检查源码/DOM 契约；真实浏览器计算样式、主题与 CSS 隔离由 Task 16 验收。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PROFILE_PATH = 'docs/ui/settings-card-profile.md'
const CSS_PATH = 'src/client/styles/settings-card.module.css'

/** 读取仓库相对路径的 UTF-8 文件。 */
function readText(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8')
}

/** 转义正则元字符。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 取一个简单选择器的声明块。
 * @param css - 样式表原文。
 * @param selector - 精确选择器。
 * @returns 花括号内的声明。
 */
function cssBlock(css: string, selector: string): string {
  const pattern = new RegExp(`(?:^|\\n)\\s*${escapeRegExp(selector)}\\s*\\{([^{}]*)\\}`, 'm')
  const match = css.match(pattern)
  expect(match, `CSS 缺少规则 ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

/**
 * 判断选择器是否出现在规则列表中（允许与其它选择器并列）。
 * @param css - 样式表原文。
 * @param selector - 精确选择器。
 * @returns 是否存在。
 */
function hasSelector(css: string, selector: string): boolean {
  return new RegExp(`(?:^|[,\\n])\\s*${escapeRegExp(selector)}\\s*(?:,|\\{)`, 'm').test(css)
}

describe('完整设置卡剖面', () => {
  const profileSource = readText(PROFILE_PATH)

  /** 所有包含 `.stack` 与卡片底的 fenced 图。 */
  const profileBlocks = [...profileSource.matchAll(/```(?:text)?\r?\n([\s\S]*?)```/g)]
    .map(match => match[1] ?? '')
    .filter(block => block.includes('.stack') && block.includes('卡片底'))

  it('只有一张从 .stack 顶到底、没有省略或拆段的完整剖面', () => {
    expect(profileBlocks).toHaveLength(1)
    const profile = profileBlocks[0] ?? ''
    expect(profile.trim().startsWith('.stack') || profile.includes('.stack')).toBe(true)
    expect(profile).toContain('卡片底')
    expect(profile).not.toMatch(/（略）|同上|其余部分略|省略|代表性/)
    expect(profile).toContain('data-search-section')
    expect(profile).toContain('role="separator"')
    expect(profile).toContain('data-channel-config-host')
    expect(profile).toContain('data-account-config-slot')
    expect(profile).toContain('data-qoder-endpoint-slot')
    expect(profile).toContain('hintRow')
    expect(profile).toContain('fieldSlot ▸ padding')
    expect(profile).toContain('卡片底')
  })

  it('剖面顺序是搜索区、独立分隔线、动态渠道配置、账号区、卡片底', () => {
    const profile = profileBlocks[0] ?? ''
    const order = [
      'data-search-section',
      'role="separator"',
      'data-channel-config-host',
      'data-qoder-endpoint-slot',
      'data-account-config-slot',
      '卡片底',
    ]
    let cursor = -1
    for (const token of order) {
      const next = profile.indexOf(token, cursor + 1)
      expect(next, `剖面顺序缺少或错位：${token}`).toBeGreaterThan(cursor)
      cursor = next
    }
    expect(profile.indexOf('data-search-section')).toBeLessThan(profile.indexOf('role="separator"'))
  })

  it('四个渠道共用唯一 search.channel 条件，Qoder 端点行与新账号区是 Task 14 的未来层', () => {
    for (const channel of ['buddy', 'workbuddy', 'qoder', 'qodercn']) {
      expect(profileSource).toContain(channel)
    }
    expect(profileSource).toContain('search.channel')
    expect(profileSource).toMatch(/同一时刻只渲染\s*一个|唯一/)
    expect(profileSource).toMatch(/AccountChannelConfig（Task 14）/)
    expect(profileSource).toMatch(/QoderEndpointRow（Task 14）/)
    expect(profileSource).toMatch(/不.*第二.*选择器|不得.*第二.*选择器/)
    expect(profileSource).toMatch(/不.*提前.*实现|不要.*提前.*实现/)
  })

  it('剖面写明 h3、fieldSlot、field、hintRow 的 padding 归属与两类 hintRow 选择器', () => {
    const profile = profileBlocks[0] ?? ''
    expect(profile).toContain('h3')
    expect(profile).toContain('margin: 0')
    expect(profile).toMatch(/fieldSlot ▸ padding[^\n]*0px/)
    expect(profile).toMatch(/field ▸ padding[^\n]*12px 0/)
    expect(profile).toMatch(/field ▸ gap[^\n]*6px/)
    expect(profile).toMatch(/hintRow ▸ margin-top[^\n]*−6px/)
    expect(profile).toMatch(/hintRow ▸ margin-bottom[^\n]*12px/)
    expect(profile).toMatch(/section ▸ 末块补偿[^\n]*−12px/)
    expect(profileSource).toContain('.section > .fieldSlot:last-child')
    expect(profileSource).toContain('.section > .hintRow:last-child')
    expect(profile).toContain('34px')
    expect(profile).toContain('36 × 20')
    expect(profile).toContain('0.5px')
  })
})

describe('设置卡 CSS 契约', () => {
  const css = readText(CSS_PATH)

  it('.stack 不依赖容器 gap，section/row/field 使用规范间距', () => {
    expect(cssBlock(css, '.stack')).toMatch(/display:\s*flex;/)
    expect(cssBlock(css, '.stack')).toMatch(/flex-direction:\s*column;/)
    expect(cssBlock(css, '.stack')).toMatch(/gap:\s*0;/)
    expect(cssBlock(css, '.section')).toMatch(/padding:\s*16px 0;/)
    expect(cssBlock(css, '.row')).toMatch(/padding:\s*12px 0;/)
    expect(cssBlock(css, '.row')).toMatch(/gap:\s*8px;/)
    expect(cssBlock(css, '.fieldSlot')).toMatch(/padding:\s*0;/)
    expect(cssBlock(css, '.fieldSlot')).not.toMatch(/padding-(top|bottom|left|right)/)
    expect(cssBlock(css, '.field')).toMatch(/padding:\s*12px 0;/)
    expect(cssBlock(css, '.field')).toMatch(/gap:\s*6px;/)
    expect(cssBlock(css, '.hintRow')).toMatch(/margin:\s*-6px 0 12px;/)
    expect(cssBlock(css, '.rule')).toMatch(/margin:\s*0;/)
    expect(cssBlock(css, '.rule')).toMatch(/border-top:\s*0\.5px solid/)
  })

  it('首末补偿只按块类型命中，h3 与空分组不会被负 margin 拖动', () => {
    for (const selector of [
      '.section > .row:first-child',
      '.section > .fieldSlot:first-child',
      '.section > .group:first-child',
      '.section > .row:last-child',
      '.section > .fieldSlot:last-child',
      '.section > .group:last-child',
      '.section > .hintRow:last-child',
    ]) {
      expect(hasSelector(css, selector), `缺少补偿选择器 ${selector}`).toBe(true)
    }
    expect(css).not.toMatch(/\.section\s*>\s*:first-child/)
    expect(css).not.toMatch(/\.section\s*>\s*:last-child/)
    expect(css).not.toMatch(/\.heading[^{]*\{[^}]*margin-(top|bottom):\s*-/m)
  })

  it('自有 Switch 复制 rc3 几何、动画、禁用与 focus ring', () => {
    expect(cssBlock(css, '.switch')).toMatch(/width:\s*36px;/)
    expect(cssBlock(css, '.switch')).toMatch(/height:\s*20px;/)
    expect(cssBlock(css, '.switch')).toMatch(/padding:\s*2px;/)
    expect(cssBlock(css, '.switch')).toMatch(/border-radius:\s*999px;/)
    expect(cssBlock(css, '.thumb')).toMatch(/width:\s*16px;/)
    expect(cssBlock(css, '.thumb')).toMatch(/height:\s*16px;/)
    expect(cssBlock(css, '.thumb')).toMatch(/transition:\s*transform 120ms ease;/)
    expect(cssBlock(css, ".switch[aria-checked='true'] .thumb")).toMatch(/translateX\(16px\)/)
    expect(cssBlock(css, '.switch:disabled')).toMatch(/opacity:\s*0\.5;/)
    expect(cssBlock(css, '.switch:focus-visible')).toMatch(/outline:/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.thumb\s*\{[\s\S]*?transition:\s*none;/)
  })

  it('自有 Dropdown 锚点 34px/0 12px，Menu 4px/34px/6 8/gap6/13 20', () => {
    expect(cssBlock(css, '.selector')).toMatch(/height:\s*34px;/)
    expect(cssBlock(css, '.selector')).toMatch(/padding:\s*0 12px;/)
    expect(cssBlock(css, '.menu')).toMatch(/padding:\s*4px;/)
    expect(cssBlock(css, '.menuItem')).toMatch(/min-height:\s*34px;/)
    expect(cssBlock(css, '.menuItem')).toMatch(/padding:\s*6px 8px;/)
    expect(cssBlock(css, '.menuItem')).toMatch(/gap:\s*6px;/)
    expect(cssBlock(css, '.menuItem')).toMatch(/font-size:\s*13px;/)
    expect(cssBlock(css, '.menuItem')).toMatch(/line-height:\s*20px;/)
    expect(cssBlock(css, '.menu')).toMatch(/border-radius:\s*var\(--dsw-radius-md, 12px\);/)
    expect(cssBlock(css, '.menuItem')).toMatch(/border-radius:\s*var\(--dsw-radius-md, 12px\);/)
    expect(css).toMatch(/\.menu\s*\{[^}]*position:\s*fixed;/)
  })

  it('门控只灰化文本/选择器，错误红字不被覆盖', () => {
    expect(cssBlock(css, '.rowGated .rowTitle')).toMatch(/label-dimmed/)
    expect(cssBlock(css, '.rowGated .rowDescription')).toMatch(/label-dimmed/)
    expect(cssBlock(css, '.rowGated .selector')).toMatch(/opacity:\s*0\.5;/)
    expect(cssBlock(css, '.error')).toMatch(/color:\s*var\(--dsw-alias-state-error-primary/)
    expect(css).not.toMatch(/\.rowGated[^{]*\.error/)
    expect(css).not.toMatch(/(?:disabled|gated)[^{]*\.error/)
  })

  it('保持既有构建约束：CSS Modules 子集、无第二套样式与 font 简写', () => {
    expect(css).not.toMatch(/:global|composes|@keyframes|url\(/)
    expect(css).not.toMatch(/\bfont:\s*inherit/)
    expect(css).toContain('--dsw-alias-label-primary')
    expect(css).toContain('--dsw-alias-border-l4')
    expect(css).toContain('--dsw-alias-state-error-primary')
  })
})
