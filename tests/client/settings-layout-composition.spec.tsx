// @vitest-environment jsdom
/** R53：真实账号 DOM 与真实 CSS 共同决定“当前账号 row”到首个账号的 24px，不能只检查单个类。 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { AccountChannelConfig } from '../../src/client/AccountChannelConfig.tsx'
import { accountSummary, routeAccounts } from './support/accounts-harness.ts'
import {
  createConnectionDouble,
  flush,
  mount,
  query,
  translator,
  type MountedRoot,
} from './support/settings-harness.ts'

const ROOT = path.resolve(process.cwd())
const CSS = readFileSync(path.join(ROOT, 'src/client/styles/settings-card.module.css'), 'utf8')
const mounted: MountedRoot[] = []

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

/** 读取一个选择器的声明块；不存在时返回空串，由调用方回退到基础类。 */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return CSS.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^{}]*)\\}`, 'm'))?.[1] ?? ''
}

/** 读取垂直 padding；首末专用规则不存在时回退到 accountRow 基础规则。 */
function verticalPadding(selector: string, edge: 'top' | 'bottom'): number {
  const own = block(selector)
  const source = own === '' && selector.startsWith('.accountRow') ? block('.accountRow') : own
  const explicit = source.match(new RegExp(`padding-${edge}:\\s*(-?\\d+)(?:px)?`))
  if (explicit !== null) return Number(explicit[1])
  const shorthand = source.match(/padding:\s*(-?\d+)(?:px)?(?:\s+|$)/)
  return shorthand === null ? Number.NaN : Number(shorthand[1])
}

describe('账号列表首末组合间距（R53）', () => {
  it('当前账号 row 底部 12 + accountList padding-top 12 = 24；末账号到清除 head 仍为 24', async () => {
    const current = accountSummary('buddy', 'account-a', { displayName: 'Account A' })
    const alternative = accountSummary('buddy', 'account-b', { displayName: 'Account B' })
    const rpc = createConnectionDouble(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [current, alternative] }),
      'accounts.current': () => ({ ok: true, value: current }),
    }))
    const root = mount(createElement(AccountChannelConfig, {
      channel: 'buddy', connection: rpc.connection, t: translator('zh'), writable: true,
    }))
    mounted.push(root)
    await flush()

    const accountsField = query<HTMLElement>(root.container, '[data-field="accounts"]')
    const stateRow = query<HTMLElement>(root.container, '[data-account-state]')
    const listRegion = query<HTMLElement>(root.container, '[data-account-list-region]')
    const accountList = query<HTMLElement>(listRegion, '[data-account-list]')
    const clearField = query<HTMLElement>(root.container, '[data-field="clear-accounts"]')

    // 状态不是字段尾部 hint，也不在账号 field 内；列表内部结构保持原样。
    expect(stateRow.closest('[data-field]')).toBeNull()
    expect(stateRow.className).toContain('row')
    expect(stateRow.querySelector('[class*="rowDescription"]')?.textContent)
      .toContain('当前账号: Account A')
    expect(stateRow.compareDocumentPosition(listRegion) & Node.DOCUMENT_POSITION_FOLLOWING)
      .not.toBe(0)
    expect(stateRow.nextElementSibling).toBe(listRegion)
    expect(listRegion.firstElementChild).toBe(accountList)
    expect(accountsField.contains(accountList)).toBe(false)
    expect(listRegion.nextElementSibling).toBe(clearField)
    expect(accountList.nextElementSibling).toBeNull()
    expect(root.container.querySelector('[data-delete-confirmation]')).toBeNull()
    expect(accountList.querySelectorAll('[data-account-row]')).toHaveLength(2)
    expect(accountList.querySelector('[data-account-row][data-account-id="account-a"]')
      ?.querySelector('[data-account-actions]')?.children).toHaveLength(2)

    const firstGap = verticalPadding('.row', 'bottom') + verticalPadding('.accountList', 'top')
    const lastGap = verticalPadding('.accountRow:last-child', 'bottom')
      + verticalPadding('.accountListRegion', 'bottom') + verticalPadding('.field', 'top')
    expect(firstGap, 'state row padding-bottom 12 + accountList padding-top 12').toBe(24)
    expect(lastGap, '末 accountRow bottom + list region bottom + 清除 field top').toBe(24)
    expect(verticalPadding('.accountList', 'top')).toBe(12)
    expect(verticalPadding('.accountListRegion', 'bottom')).toBe(12)
    // 列表行间分隔线仍冻结。
    expect(CSS).toMatch(/\.accountRow \+ \.accountRow\s*\{[^}]*border-top:\s*0\.5px solid/)
  })
})