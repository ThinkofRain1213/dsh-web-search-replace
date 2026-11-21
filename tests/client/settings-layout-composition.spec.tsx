// @vitest-environment jsdom
/** I-1：真实账号 DOM 与真实 CSS 共同决定首末空白，不能只检查单个类。 */
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
  const source = own === '' ? block('.accountRow') : own
  const explicit = source.match(new RegExp(`padding-${edge}:\\s*(-?\\d+)(?:px)?`))
  if (explicit !== null) return Number(explicit[1])
  const shorthand = source.match(/padding:\s*(-?\d+)(?:px)?(?:\s+|$)/)
  return shorthand === null ? Number.NaN : Number(shorthand[1])
}

/** 读取 field gap 与 field 的垂直 padding。 */
function numberDeclaration(selector: string, property: 'gap' | 'padding-top' | 'padding-bottom'): number {
  if (property !== 'gap') return verticalPadding(selector, property === 'padding-top' ? 'top' : 'bottom')
  return Number(block(selector).match(/gap:\s*(-?\d+)px/)?.[1])
}

describe('账号列表首末组合间距（I-1 RED）', () => {
  it('首账号前为 6px，末账号到清除 head 为 24px，而不是 18/36px', async () => {
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
    const accountList = query<HTMLElement>(accountsField, '[data-account-list]')
    const stateHint = query<HTMLElement>(accountsField, '[data-account-state]')
    const clearField = query<HTMLElement>(root.container, '[data-field="clear-accounts"]')
    expect(stateHint.compareDocumentPosition(accountList) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(accountList.nextElementSibling).toBeNull()
    expect(accountsField.nextElementSibling).toBe(clearField)
    expect(root.container.querySelector('[data-delete-confirmation]')).toBeNull()
    expect(accountList.querySelectorAll('[data-account-row]')).toHaveLength(2)

    const firstGap = numberDeclaration('.field', 'gap') + verticalPadding('.accountRow:first-child', 'top')
    const lastGap = verticalPadding('.accountRow:last-child', 'bottom')
      + verticalPadding('.field', 'bottom') + verticalPadding('.field', 'top')
    expect(firstGap, 'state hint → accountList gap 6 + 首 accountRow padding-top').toBe(6)
    expect(lastGap, '末 accountRow bottom + 账号 field bottom + 清除 field top').toBe(24)
  })
})
