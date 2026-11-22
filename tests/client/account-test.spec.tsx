// @vitest-environment jsdom
/** 每行真实“测试”按钮：测试中/完成、队列/取消、OFF 禁用与当前账号稳定。 */
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { AccountChannelConfig } from '../../src/client/AccountChannelConfig.tsx'
import type { AccountSummary } from '../../src/shared/accounts.ts'
import type { RpcResult } from '../../src/shared/rpc.ts'
import { accountSummary, routeAccounts, type AccountHandlers } from './support/accounts-harness.ts'
import {
  click,
  createConnectionDouble,
  deferred,
  flush,
  mount,
  query,
  translator,
  type MountedRoot,
  type TestLocale,
} from './support/settings-harness.ts'

const mounted: MountedRoot[] = []

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

async function renderAccount(options: {
  handlers: AccountHandlers
  gated?: boolean
  writable?: boolean
  locale?: TestLocale
}) {
  const rpc = createConnectionDouble(routeAccounts(options.handlers))
  const t = translator(options.locale ?? 'zh')
  const root = mount(createElement(AccountChannelConfig, {
    channel: 'buddy',
    connection: rpc.connection,
    t,
    writable: options.writable ?? true,
    gated: options.gated ?? false,
  }))
  mounted.push(root)
  await flush()
  return { ...root, ...rpc, t }
}

describe('AccountChannelConfig 每账号测试按钮', () => {
  it('每行都有独立测试按钮，显示测试中/最终状态，非当前账号测试不切换当前', async () => {
    const current = accountSummary('buddy', 'account-a', { displayName: 'Current A' })
    const alternative = accountSummary('buddy', 'account-b', { displayName: 'Alternative B' })
    const result = deferred<RpcResult<AccountSummary>>()
    const { container, calls } = await renderAccount({ handlers: {
      'accounts.list': () => ({ ok: true, value: [current, alternative] }),
      'accounts.current': () => ({ ok: true, value: current }),
      'accounts.test': () => result.promise,
      'accounts.setCurrent': () => { throw new Error('must not set current') },
    } })

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-action="test-account"]')]
    expect(buttons).toHaveLength(2)
    expect(buttons.map(button => button.getAttribute('data-account-id'))).toEqual(['account-a', 'account-b'])
    expect(buttons.every(button => button.textContent === '测试')).toBe(true)

    await click(buttons[1]!)
    const row = query<HTMLElement>(container, '[data-account-row][data-account-id="account-b"]')
    expect(query<HTMLElement>(row, '[data-account-status]').getAttribute('data-account-status')).toBe('checking')
    expect(row.textContent).toContain('测试中')
    expect(query<HTMLButtonElement>(row, '[data-action="cancel-test"]').disabled).toBe(false)
    expect(query<HTMLButtonElement>(row, '[data-action="reauth-account"]').disabled).toBe(true)
    expect(calls.filter(call => call.method === 'accounts.test')).toEqual([{
      method: 'accounts.test', payload: { channel: 'buddy', accountId: 'account-b' },
    }])

    result.resolve({
      ok: true,
      value: accountSummary('buddy', 'account-b', { status: 'temporarily_unavailable' }),
    })
    await flush()
    expect(query<HTMLElement>(row, '[data-account-status]').getAttribute('data-account-status'))
      .toBe('temporarily_unavailable')
    expect(row.textContent).toContain('暂时不可用')
    expect(query<HTMLElement>(container, '[data-account-row][data-account-id="account-a"]')
      .getAttribute('data-current')).toBe('true')
    expect(query<HTMLElement>(container, '[data-account-row][data-account-id="account-b"]')
      .getAttribute('data-current')).toBe('false')
    expect(calls.filter(call => call.method === 'accounts.setCurrent')).toEqual([])
  })

  it('测试进入同一行队列，排队与活动测试都可取消', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const setting = deferred<RpcResult<AccountSummary | null>>()
    const testing = deferred<RpcResult<AccountSummary>>()
    let setCalls = 0
    const { container, calls } = await renderAccount({ handlers: {
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.setCurrent': () => { setCalls += 1; return setting.promise },
      'accounts.test': () => testing.promise,
    } })

    await click(query(container, '[data-action="set-current"][data-account-id="account-b"]'))
    await click(query(container, '[data-action="test-account"][data-account-id="account-a"]'))
    const rowA = query<HTMLElement>(container, '[data-account-row][data-account-id="account-a"]')
    expect(rowA.getAttribute('data-row-queued')).toBe('true')
    const cancelQueued = query<HTMLButtonElement>(rowA, '[data-action="cancel-test"]')
    expect(cancelQueued.disabled).toBe(false)
    await click(cancelQueued)
    expect(calls.filter(call => call.method === 'accounts.test')).toEqual([])

    setting.resolve({ ok: true, value: b })
    await flush()
    await click(query(container, '[data-action="test-account"][data-account-id="account-a"]'))
    const activeCancel = query<HTMLButtonElement>(rowA, '[data-action="cancel-test"]')
    expect(activeCancel.textContent).toBe('取消测试')
    await click(activeCancel)
    testing.resolve({ ok: true, value: accountSummary('buddy', 'account-a', { status: 'reauth_required' }) })
    await flush()
    expect(query<HTMLElement>(rowA, '[data-account-status]').getAttribute('data-account-status')).toBe('ready')
    expect(setCalls).toBe(1)
  })

  it('OFF 时测试禁用且点击不发 RPC，仅清除全部保留可用；ON 后恢复', async () => {
    const account = accountSummary('buddy', 'account-a')
    const rendered = await renderAccount({ gated: true, handlers: {
      'accounts.list': () => ({ ok: true, value: [account] }),
      'accounts.current': () => ({ ok: true, value: account }),
    } })
    const test = query<HTMLButtonElement>(rendered.container, '[data-action="test-account"]')
    expect(test.disabled).toBe(true)
    expect(query<HTMLButtonElement>(rendered.container, '[data-action="clear-all"]').disabled).toBe(false)
    await click(test)
    expect(rendered.calls.filter(call => call.method === 'accounts.test')).toEqual([])

    await rendered.rerender(createElement(AccountChannelConfig, {
      channel: 'buddy', connection: rendered.connection, t: rendered.t, writable: true, gated: false,
    }))
    expect(query<HTMLButtonElement>(rendered.container, '[data-action="test-account"]').disabled).toBe(false)
  })

  it('只读禁用测试；英文提供 Test/Cancel test 且不含中文', async () => {
    const account = accountSummary('buddy', 'account-a')
    const readOnly = await renderAccount({ writable: false, handlers: {
      'accounts.list': () => ({ ok: true, value: [account] }),
      'accounts.current': () => ({ ok: true, value: account }),
    } })
    expect(query<HTMLButtonElement>(readOnly.container, '[data-action="test-account"]').disabled).toBe(true)

    const pending = deferred<RpcResult<AccountSummary>>()
    const english = await renderAccount({ locale: 'en', handlers: {
      'accounts.list': () => ({ ok: true, value: [account] }),
      'accounts.current': () => ({ ok: true, value: account }),
      'accounts.test': () => pending.promise,
    } })
      const button = query<HTMLButtonElement>(english.container, '[data-action="test-account"]')
    expect(button.textContent).toBe('Test')
    await click(button)
    expect(query<HTMLButtonElement>(english.container, '[data-action="cancel-test"]').textContent)
      .toBe('Cancel test')
    expect(english.container.textContent).toContain('Testing')
    expect(english.container.textContent).not.toMatch(/[\u4e00-\u9fff]/)
  })
})
