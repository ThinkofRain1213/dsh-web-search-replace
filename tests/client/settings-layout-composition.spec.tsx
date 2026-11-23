// @vitest-environment jsdom
/** R53 收尾：账号字段头 row 与真实 accountList DOM 共同决定首末 24px，不能只检查单个类。 */
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
  const shorthand = source.match(/padding:\s*(-?\d+)(?:px)?(?=\s|;|$)/)
  return shorthand === null ? Number.NaN : Number(shorthand[1])
}

describe('账号字段头与列表首末组合间距（R53 收尾）', () => {
  it('字段头 row 底部 12 + accountList padding-top 12 = 24；末账号到清除 field 仍为 24', async () => {
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
    const headRow = query<HTMLElement>(accountsField, '[data-field-head]')
    const listRegion = query<HTMLElement>(root.container, '[data-account-list-region]')
    const accountList = query<HTMLElement>(listRegion, '[data-account-list]')
    const clearField = query<HTMLElement>(root.container, '[data-field="clear-accounts"]')

    // 当前账号是字段头说明，不是独立 row；账号 field 之后直接是列表区域。
    expect(headRow.getAttribute('data-account-state')).toBe('selected')
    expect(headRow.className).toContain('row')
    expect(query<HTMLElement>(headRow, '[data-field-label]').className).toContain('rowTitle')
    expect(query<HTMLElement>(headRow, '[data-field-label]').textContent).toBe('账号')
    expect(query<HTMLElement>(headRow, '[data-account-hint]').className)
      .toContain('rowDescription')
    expect(query<HTMLElement>(headRow, '[data-account-hint]').textContent)
      .toContain('当前账号: Account A')
    expect(root.container.querySelectorAll('[data-account-state]')).toHaveLength(1)
    expect(accountsField.nextElementSibling).toBe(listRegion)
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

    // 字段包装 .accountField 不再重复 field 的上下 12px，也不在首行前另加间距。
    expect(block('.accountField')).toMatch(/padding:\s*0;/)
    expect(block('.accountField')).toMatch(/gap:\s*6px;/)
    const firstGap = verticalPadding('.row', 'bottom')
      + verticalPadding('.accountField', 'bottom')
      + verticalPadding('.accountList', 'top')
    const lastGap = verticalPadding('.accountRow:last-child', 'bottom')
      + verticalPadding('.accountListRegion', 'bottom') + verticalPadding('.field', 'top')
    expect(firstGap, '字段头 row padding-bottom 12 + accountField bottom 0 + accountList top 12').toBe(24)
    expect(lastGap, '末 accountRow bottom + list region bottom + 清除 field top').toBe(24)
    expect(verticalPadding('.accountList', 'top')).toBe(12)
    expect(verticalPadding('.accountListRegion', 'bottom')).toBe(12)
    // 列表行间分隔线仍冻结。
    expect(CSS).toMatch(/\.accountRow \+ \.accountRow\s*\{[^}]*border-top:\s*0\.5px solid/)
  })

  it('读取失败时没有空白状态 row：字段头 data-account-state=error，无描述，后接 errorRow', async () => {
    const rpc = createConnectionDouble(routeAccounts({
      'accounts.list': () => failure,
    }))
    const root = mount(createElement(AccountChannelConfig, {
      channel: 'buddy', connection: rpc.connection, t: translator('zh'), writable: true,
    }))
    mounted.push(root)
    await flush()

    const accountsField = query<HTMLElement>(root.container, '[data-field="accounts"]')
    const headRow = query<HTMLElement>(accountsField, '[data-field-head]')
    const errorRow = query<HTMLElement>(accountsField, '[class*="errorRow"]')

    expect(headRow.getAttribute('data-account-state')).toBe('error')
    expect(headRow.querySelector('[data-account-hint]')).toBeNull()
    expect(headRow.nextElementSibling).toBe(errorRow)
    expect(query<HTMLElement>(errorRow, '[data-account-error]').getAttribute('role')).toBe('alert')
    // 字段包装 padding 0，不再叠加独立状态 row 的 12+12 空白。
    expect(block('.accountField')).toMatch(/padding:\s*0;/)
    expect(verticalPadding('.accountField', 'top'), '账号字段头由 row padding-top 12 接续').toBe(0)
  })

  it('账号列表首/末行各持首尾 hairline；容器无 border；OFF rowGated 不覆盖行线，内部行结构不变', async () => {
    const current = accountSummary('buddy', 'account-a', { displayName: 'Account A' })
    const alternative = accountSummary('buddy', 'account-b', { displayName: 'Account B' })
    const rpc = createConnectionDouble(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [current, alternative] }),
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
    const rows = [...list.querySelectorAll<HTMLElement>('[data-account-row]')]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.className).toContain('accountRow')
    expect(rows[1]?.className).toContain('accountRow')
    // 首末账号行就是列表的首末孩子，没有额外容器分隔层。
    expect([...list.children]).toEqual(rows)
    expect(list.firstElementChild).toBe(rows[0])
    expect(list.lastElementChild).toBe(rows[1])
    expect(rows[0]?.querySelector('[data-account-actions]')).not.toBeNull()
    expect(rows[1]?.querySelector('[data-account-actions]')).not.toBeNull()

    // 首尾线归首/末 accountRow 自己：容器不再画线，避免底线与 region/clear field 的 padding 叠加。
    expect(block('.accountList')).not.toMatch(/border-(top|bottom):/)
    expect(block('.accountList')).toMatch(/padding-top:\s*12px;/)
    expect(block('.accountRow:first-child'))
      .toMatch(/border-top:\s*0\.5px solid var\(--dsw-alias-border-l2\);/)
    expect(block('.accountRow:first-child')).not.toMatch(/border-bottom:/)
    expect(block('.accountRow:last-child'))
      .toMatch(/border-bottom:\s*0\.5px solid var\(--dsw-alias-border-l2\);/)
    expect(block('.accountRow:last-child')).not.toMatch(/border-top:/)
    // 内部线只在相邻行之间出现一次，基础行不带 border，首/末行不再重复画线。
    expect(block('.accountRow')).not.toMatch(/border-(top|bottom):/)
    expect(CSS).toMatch(/\.accountRow \+ \.accountRow\s*\{[^}]*border-top:\s*0\.5px solid/)
    // 首行 top 0、末行 bottom 0；末账号 → 清除 field 仍为 24px。
    expect(verticalPadding('.accountRow:first-child', 'top')).toBe(0)
    expect(verticalPadding('.accountRow:last-child', 'bottom')).toBe(0)
    expect(verticalPadding('.accountRow:last-child', 'bottom')
      + verticalPadding('.accountListRegion', 'bottom')
      + verticalPadding('.field', 'top'), '末 accountRow bottom + list region bottom + 清除 field top').toBe(24)
    // 灰化只作用于文本/控件，不能改写首/末行或内部行线。
    expect(CSS).not.toMatch(/\.rowGated\s+\.accountRow[^{]*\{[^}]*border/)
    expect(CSS).not.toMatch(/\.fieldGated\s+\.accountRow[^{]*\{[^}]*border/)
  })

  it('Qoder endpoint error 在 hintRow 内；hintRow 后直接是账号字段Slot，error→账号字段头 24px', async () => {
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
    const accountHead = query<HTMLElement>(accountSlot, '[data-field="accounts"] [data-field-head]')

    // error 是 hintRow 内的最后一个独立元素，不是 hintRow 的兄弟。
    expect([...hintRow.children]).toEqual([status, description, error])
    expect(hintRow.lastElementChild).toBe(error)
    expect(hintRow.nextElementSibling).toBeNull()
    expect(endpointSlot.nextElementSibling).toBe(accountSlot)
    expect(accountHead).toBeTruthy()
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.id).not.toBe('')
    expect(trigger.getAttribute('aria-describedby')?.split(' ')).toContain(error.id)

    // error 后仍有 hintRow 的 margin-bottom 12；再与账号字段头 row padding-top 12 合成 24px。
    expect(block('.hintRow')).toMatch(/margin:\s*-6px 0 12px;/)
    const hintRowBottom = Number(block('.hintRow').match(/margin:\s*-?\d+px\s+0\s+(-?\d+)px;/)?.[1])
    expect(hintRowBottom).toBe(12)
    expect(verticalPadding('.row', 'top')).toBe(12)
    expect(verticalPadding('.accountField', 'top')).toBe(0)
    expect(hintRowBottom + verticalPadding('.row', 'top'), 'error → 账号字段头').toBe(24)
    expect(block('.error')).toMatch(/margin:\s*0;/)
  })
})
