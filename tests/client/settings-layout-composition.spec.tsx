// @vitest-environment jsdom
/** R53：真实账号 DOM 与真实 CSS 共同决定“当前账号 row”到首个账号的 24px，不能只检查单个类。 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { AccountChannelConfig } from '../../src/client/AccountChannelConfig.tsx'
import { SettingsCard } from '../../src/client/SettingsCard.tsx'
import type { SearchSettingsSnapshot } from '../../src/shared/contracts.ts'
import type { RpcResult } from '../../src/shared/rpc.ts'
import { accountSummary, routeAccounts } from './support/accounts-harness.ts'
import {
  buttonByText,
  click,
  createConfigFormsDouble,
  createConnectionDouble,
  deferred,
  flush,
  makeSnapshot,
  mount,
  query,
  translator,
  type MountedRoot,
} from './support/settings-harness.ts'

const ROOT = path.resolve(process.cwd())
const CSS = readFileSync(path.join(ROOT, 'src/client/styles/settings-card.module.css'), 'utf8')
const mounted: MountedRoot[] = []
const failure = {
  ok: false as const,
  error: { code: 'settings/internal', message: 'settings operation failed', details: {} },
}

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
      ?.querySelector('[data-account-actions]')?.children).toHaveLength(3)
    expect(accountList.querySelector('[data-account-row][data-account-id="account-a"]')
      ?.querySelector('[data-action="test-account"]')).not.toBeNull()

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

  it('账号列表容器有上下 0.5px hairline；OFF rowGated 不覆盖 border，内部行结构不变', async () => {
    const current = accountSummary('buddy', 'account-a', { displayName: 'Account A' })
    const rpc = createConnectionDouble(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [current] }),
      'accounts.current': () => ({ ok: true, value: current }),
    }))
    const root = mount(createElement(AccountChannelConfig, {
      channel: 'buddy',
      connection: rpc.connection,
      t: translator('zh'),
      writable: true,
      gated: true,
    }))
    mounted.push(root)
    await flush()

    const list = query<HTMLElement>(root.container, '[data-account-list]')
    const region = query<HTMLElement>(root.container, '[data-account-list-region]')
    expect(list.parentElement).toBe(region)
    expect(region.className).toContain('rowGated')
    expect(region.getAttribute('data-off-gated')).toBe('true')
    expect(list.querySelectorAll('[data-account-row]')).toHaveLength(1)
    expect(list.querySelector('[data-account-row]')?.querySelector('[data-account-actions]'))
      .not.toBeNull()

    expect(block('.accountList')).toMatch(/border-top:\s*0\.5px solid var\(--dsw-alias-border-l2\);/)
    expect(block('.accountList')).toMatch(/border-bottom:\s*0\.5px solid var\(--dsw-alias-border-l2\);/)
    expect(block('.accountList')).toMatch(/padding-top:\s*12px;/)
    // 灰化只作用于文本/控件，不能改写列表容器的上下 border。
    expect(CSS).not.toMatch(/\.rowGated\s+\.accountList\s*\{[^}]*border/)
    expect(CSS).not.toMatch(/\.fieldGated\s+\.accountList\s*\{[^}]*border/)
  })

  it('Qoder endpoint error 在 hintRow 内；hintRow 后直接是账号 fieldSlot，error→下一字段 24px', async () => {
    const snapshot = makeSnapshot({ enabled: true, channel: 'qoder', endpointPreference: 'auto' })
    const forms = createConfigFormsDouble(snapshot)
    const accounts = routeAccounts({})
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const rpc = createConnectionDouble((call) => {
      if (call.method === 'settings.update') return response.promise
      if (call.method.startsWith('accounts.') || call.method.startsWith('auth.')) {
        return accounts(call)
      }
      return { ok: true, value: snapshot }
    })
    const root = mount(createElement(SettingsCard, {
      view: 'page',
      t: translator('zh'),
      configForms: forms.configForms,
      connection: rpc.connection,
    }))
    mounted.push(root)
    await flush()

    const endpointSlot = query<HTMLElement>(root.container, '[data-qoder-endpoint-slot]')
    const hintRow = query<HTMLElement>(endpointSlot, '[data-hint-row]')
    const trigger = query<HTMLButtonElement>(endpointSlot, '[data-dropdown-trigger]')
    await click(trigger)
    await click(buttonByText(query(document, '[data-dropdown-menu]'), 'center.qoder.sh'))
    response.resolve(failure)
    await flush()

    const status = query<HTMLElement>(hintRow, '[data-endpoint-status]')
    const description = query<HTMLElement>(hintRow, '[data-endpoint-description]')
    const error = query<HTMLElement>(hintRow, '[data-endpoint-error]')
    const accountSlot = query<HTMLElement>(root.container, '[data-account-config-slot]')

    // error 是 hintRow 内的最后一个独立元素，不是 hintRow 的兄弟。
    expect([...hintRow.children]).toEqual([status, description, error])
    expect(hintRow.lastElementChild).toBe(error)
    expect(hintRow.nextElementSibling).toBeNull()
    expect(endpointSlot.nextElementSibling).toBe(accountSlot)
    expect(query<HTMLElement>(accountSlot, '[data-field="accounts"]')).toBeTruthy()
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.id).not.toBe('')
    expect(trigger.getAttribute('aria-describedby')?.split(' ')).toContain(error.id)

    // error 后仍有 hintRow 的 margin-bottom 12；再与账号 field padding-top 12 合成 24px。
    expect(block('.hintRow')).toMatch(/margin:\s*-6px 0 12px;/)
    const hintRowBottom = Number(block('.hintRow').match(/margin:\s*-?\d+px\s+0\s+(-?\d+)px;/)?.[1])
    expect(hintRowBottom).toBe(12)
    expect(verticalPadding('.field', 'top')).toBe(12)
    expect(hintRowBottom + verticalPadding('.field', 'top'), 'error → 账号 field').toBe(24)
    expect(block('.error')).toMatch(/margin:\s*0;/)
  })
})
