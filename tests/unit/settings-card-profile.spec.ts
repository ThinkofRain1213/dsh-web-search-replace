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
const MENU_CSS_PATHS = [
  'src/client/components/Menu.module.css',
  'src/client/components/MenuSurface.module.css',
  'src/client/components/Tooltip.module.css',
  'src/client/components/ShortcutKeys.module.css',
]

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
  const pattern = new RegExp(`(?:^|\\n)\\s*${escapeRegExp(selector)}\\s*(?:,\\s*[^,{]+)?\\s*\\{([^{}]*)\\}`, 'gm')
  const blocks = [...css.matchAll(pattern)].map(match => match[1] ?? '').join('\n')
  expect(blocks, `CSS 缺少规则 ${selector}`).not.toBe('')
  return blocks
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

/**
 * 取包含指定选择器的整条规则声明块，允许选择器列表。
 * @param css - 样式表原文。
 * @param selector - 规则中的选择器。
 * @returns 花括号内的声明。
 */
function ruleBlock(css: string, selector: string): string {
  const pattern = new RegExp(
    `(?:^|\\})\\s*([^{}]*?${escapeRegExp(selector)}(?=[,\\s{])[^{}]*?)\\{([^{}]*)\\}`,
    'g',
  )
  const blocks = [...css.matchAll(pattern)].map(match => match[2] ?? '')
  expect(blocks.length, `CSS 缺少规则 ${selector}`).toBeGreaterThan(0)
  return blocks.join('\n')
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
    expect(profile).toContain('data-menu-backing')
    expect(profile).toContain('.accountRow + .accountRow')
  })

  it('R52：OFF 说明替换与下方配置区灰化只写进剖面', () => {
    const profile = profileBlocks[0] ?? ''
    expect(profileSource).toContain('lockedHint')
    expect(profileSource).toMatch(/lockedHint[^\n]*替换|替换[^\n]*lockedHint/)
    expect(profile).toContain('data-off-gated')
    expect(profile).toContain('data-field="clear-accounts"')
    expect(profileSource).toMatch(/清除全部账号数据[^\n]*可用|仅[^\n]*清除全部账号数据/)
    expect(profileSource).toMatch(/禁用[^\n]*端点|端点[^\n]*禁用/)
    expect(profileSource).toMatch(/账号[^\n]*禁用|禁用[^\n]*账号/)
  })
})

describe('设置卡 CSS 契约', () => {
  const layoutCss = readText(CSS_PATH)
  const css = [CSS_PATH, ...MENU_CSS_PATHS].map(readText).join('\n')

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
    expect(cssBlock(css, '.rowText')).toMatch(/gap:\s*6px;/)
    expect(cssBlock(css, '.rowText')).toMatch(/padding-right:\s*48px;/)
    expect(cssBlock(css, '.head')).toMatch(/gap:\s*8px;/)
    expect(cssBlock(css, '.labelGroup')).toMatch(/flex:\s*1;/)
    expect(cssBlock(css, '.labelGroup > .label')).toMatch(/flex:\s*0 1 auto;/)
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

  it('自有 Switch 复制 rc5 几何、动画、禁用与 focus ring', () => {
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

  it('自有 Dropdown/Menu 同构复制 rc5 锚点、surface、row、check 与 CSS anchor', () => {
    expect(cssBlock(css, '.selector')).toMatch(/height:\s*34px;/)
    expect(cssBlock(css, '.selector')).toMatch(/padding:\s*0 12px;/)
    expect(cssBlock(css, '.selector')).toMatch(/border:\s*none;/)
    expect(cssBlock(css, '.selector')).toMatch(/background:\s*var\(--dsw-alias-bg-module-platform\)/)
    expect(cssBlock(css, '.selector')).not.toMatch(/border-l4|bg-layer-3/)
    expect(cssBlock(css, '.selector')).toMatch(/border-radius:\s*var\(--dsw-radius-md\)/)
    expect(cssBlock(css, '.selector:focus-visible')).toMatch(/outline:\s*none;/)
    expect(cssBlock(css, '.menu')).toMatch(/padding:\s*4px;/)
    expect(cssBlock(css, '.menu')).toMatch(/border:\s*0;/)
    expect(cssBlock(css, '.menu')).toMatch(/box-shadow:\s*var\(--dsw-elevation-prominent\)/)
    expect(css).toMatch(/\.menu\s*\{[^}]*min-width:\s*min\(144px, calc\(100vw - 24px\)\);/)
    expect(css).toMatch(/\.menu\s*\{[^}]*max-width:\s*min\(360px, calc\(100vw - 24px\)\);/)
    expect(cssBlock(css, '.menuPortal')).toMatch(/position:\s*fixed;/)
    expect(cssBlock(css, '.menuPortal')).toMatch(/width:\s*max-content;/)
    expect(cssBlock(css, '.menuPortal')).toMatch(/z-index:\s*1100;/)
    expect(cssBlock(css, '.menuPortal')).toMatch(/position-try-fallbacks:/)
    expect(cssBlock(css, '.menuPortal[data-match-anchor-width]')).toMatch(/min-width:\s*min\(anchor-size\(width\), calc\(100vw - 24px\)\);/)
    expect(css).toMatch(/\.menuSurface,\s*\.menuBacking\s*\{[^}]*border-radius:\s*var\(--dsw-radius-lg\)/)
    expect(cssBlock(css, '.menuScrollable .menuViewport')).toMatch(/overflow-y:\s*auto;/)
    expect(cssBlock(css, '.menuItem')).toMatch(/min-height:\s*34px;/)
    expect(cssBlock(css, '.menuItem')).toMatch(/padding:\s*6px 8px;/)
    expect(cssBlock(css, '.menuItem')).toMatch(/gap:\s*6px;/)
    expect(cssBlock(css, '.menuItem')).toMatch(/font-size:\s*13px;/)
    expect(cssBlock(css, '.menuItem')).toMatch(/line-height:\s*20px;/)
    expect(cssBlock(css, '.menuItem')).toMatch(/border-radius:\s*var\(--dsw-radius-md\)/)
    expect(cssBlock(css, '.menuItem:focus-visible:not(:disabled)')).toMatch(/outline:\s*none;/)
    expect(cssBlock(css, '.menuItemLabel')).toMatch(/flex:\s*1;/)
    expect(cssBlock(css, '.menuCheck')).toMatch(/width:\s*14px;/)
    expect(cssBlock(css, '.menuCheck')).toMatch(/height:\s*14px;/)
    expect(cssBlock(css, '.menuCheck')).toMatch(/color:\s*var\(--dsw-alias-label-primary\)/)
    expect(cssBlock(css, '.menuSelected')).toMatch(/background:\s*transparent;/)
    expect(cssBlock(css, '.menuSelectedFill')).toMatch(/background:\s*var\(--dsw-alias-interactive-bg-hover\);/)
    expect(cssBlock(css, '.menuSurface[data-menu-phase] > *, .menuBacking[data-menu-phase]')).toMatch(/animation-duration:\s*0ms;/)
    expect(css).toMatch(/\.menuItem:disabled,\s*\.menuItem\[aria-disabled='true'\]\s*\{[^}]*opacity:\s*0\.4;/)
    expect(css).toContain('@position-try --dsh-web-search-channels-menu-above')
    expect(css).toContain('@position-try --dsh-web-search-channels-menu-wide-window')
  })

  it('门控只灰化文本/选择器，错误红字不被覆盖', () => {
    expect(cssBlock(css, '.rowGated .rowTitle')).toMatch(/label-dimmed/)
    expect(cssBlock(css, '.rowGated .rowDescription')).toMatch(/label-dimmed/)
    expect(cssBlock(css, '.rowGated .selector')).toMatch(/opacity:\s*0\.5;/)
    expect(cssBlock(css, '.error')).toMatch(/color:\s*var\(--dsw-alias-state-error-primary/)
    expect(css).not.toMatch(/\.rowGated[^{]*\.error/)
    expect(css).not.toMatch(/(?:disabled|gated)[^{]*\.error/)
  })

  it('R52 OFF gating 只灰化文本与各自 disabled 控件，clear-all 与错误红字不受影响', () => {
    for (const selector of [
      '.channelGated > .heading',
      '.channelGated > .row .rowTitle',
      '.channelGated > .row .rowDescription',
      '.fieldGated .label',
      '.fieldGated .fieldValue',
      '.fieldGated .hint',
      '.fieldGated .hintText',
      '.fieldGated .accountName',
      '.fieldGated .accountMasked',
      '.fieldGated .accountStatus',
    ]) {
      expect(ruleBlock(css, selector), `${selector} 必须用 label-dimmed`)
        .toMatch(/color:\s*var\(--dsw-alias-label-dimmed/)
    }
    expect(ruleBlock(css, '.channelGated .selector:disabled')).toMatch(/opacity:\s*0\.5;/)
    expect(css).not.toMatch(/\.fieldGated[^{]*\.error/)
    expect(css).not.toMatch(/\.channelGated[^{]*\.error/)
    expect(css).not.toMatch(/\.fieldGated\s*\{[^}]*opacity:/)
    expect(css).not.toMatch(/\.channelGated\s*\{[^}]*opacity:/)
    expect(css).not.toMatch(/clear-accounts[^{]*label-dimmed/)
  })

  it('账号/条件块包装层、警告、展示框与 rc5 Button/Tag 保持统一契约', () => {
    for (const selector of ['.accountConfig', '.accountList', '.authFlow', '.confirmBox', '.choiceList', '.fieldControl', '.menuRoot']) {
      expect(cssBlock(css, selector), `${selector} 必须 padding:0`).toMatch(/padding:\s*0;/)
    }
    expect(cssBlock(css, '.accountRow')).toMatch(/padding:\s*12px 0;/)
    expect(cssBlock(css, '.accountRow')).not.toMatch(/justify-content:/)
    expect(cssBlock(css, '.accountRow:first-child')).toMatch(/padding-top:\s*0;/)
    expect(cssBlock(css, '.accountRow:last-child')).toMatch(/padding-bottom:\s*0;/)
    expect(cssBlock(css, '.accountRowText')).toMatch(/flex:\s*1 1 auto;/)
    expect(cssBlock(css, '.accountRowText')).toMatch(/gap:\s*6px;/)
    expect(cssBlock(css, '.accountActions')).toMatch(/flex:\s*0 0 auto;/)
    expect(cssBlock(css, '.accountActions')).not.toMatch(/justify-content:/)
    expect(cssBlock(css, '.warning')).toMatch(/color:\s*var\(--dsw-alias-state-warn-primary/)
    expect(cssBlock(css, '.authUrl')).toMatch(/padding:\s*12px;/)
    expect(cssBlock(css, '.authUrl')).toMatch(/border:\s*0\.5px solid var\(--dsw-alias-border-l2/)
    expect(cssBlock(css, '.authUrl')).toMatch(/border-radius:\s*var\(--dsw-radius-lg\)/)
    expect(cssBlock(css, '.authUrl')).toMatch(/background:\s*var\(--dsw-alias-bg-base\)/)
    expect(cssBlock(css, '.authUrl')).toMatch(/font-family:\s*var\(--ds-font-family-code/)
    expect(cssBlock(css, '.authUrl')).toMatch(/white-space:\s*pre-wrap;/)
    expect(cssBlock(css, '.authUrl')).toMatch(/overflow-wrap:\s*anywhere;/)
    expect(cssBlock(css, '.actionButton:disabled')).toMatch(/opacity:\s*0\.4;/)
    expect(cssBlock(css, '.accountBadge')).toMatch(/border-radius:\s*999px;/)
    expect(cssBlock(css, '.accountBadge')).toMatch(/padding:\s*1px 8px;/)
  })

  it('disabledReason 所需官方 Tooltip/ShortcutKeys 样式也保持同构与 reduced-motion', () => {
    expect(cssBlock(css, '.bubble')).toMatch(/position:\s*fixed;/)
    expect(cssBlock(css, '.bubble')).toMatch(/border-radius:\s*var\(--dsw-radius-sm\)/)
    expect(cssBlock(css, '.bubble')).toMatch(/background:\s*var\(--dsw-alias-tooltip-bg\)/)
    expect(cssBlock(css, '.bubble')).toMatch(/animation:\s*dsh-web-search-channels-tooltip-in 150ms var\(--ds-ease-in-out\)/)
    expect(cssBlock(css, '.bubble[data-portal]')).toMatch(/z-index:\s*1100;/)
    expect(cssBlock(css, '.keys')).toMatch(/display:\s*inline-flex;/)
    expect(cssBlock(css, '.keys')).toMatch(/font-size:\s*12px;/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.bubble\s*\{[\s\S]*?animation:\s*none;/)
  })

  it('保持既有构建约束：CSS Modules 子集、无第二套样式与 font 简写', () => {
    expect(css).not.toMatch(/:global|composes|url\(/)
    expect(css).not.toMatch(/@keyframes\s+(?!dsh-web-search-channels-(?:menu-(?:in|out)|tooltip-in)\b)/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration:\s*0ms;/)
    expect(layoutCss).not.toMatch(/\bfont:\s*inherit/)
    expect(css).toContain('--dsw-alias-label-primary')
    expect(css).toContain('--dsw-alias-bg-module-platform')
    expect(css).toContain('--dsw-alias-state-error-primary')
  })
})
