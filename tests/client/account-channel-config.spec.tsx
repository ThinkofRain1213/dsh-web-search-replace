// @vitest-environment jsdom
/**
 * Task 14 四渠道账号区：只显示当前渠道账号；当前/备选、显式设当前、添加/重登/
 * 删除就地展开、删除不自动递补、清除全部四渠道数据确认、秘密边界与 zh/en。
 *
 * 这里挂载真实 `AccountChannelConfig`，只替换 Connection RPC 与 locale 字典。
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AccountChannelConfig } from '../../src/client/AccountChannelConfig.tsx'
import { CHANNEL_IDS, type ChannelId } from '../../src/shared/channels.ts'
import type { AccountSummary } from '../../src/shared/accounts.ts'
import type { RpcResult } from '../../src/shared/rpc.ts'
import {
  AUTH_URLS,
  accountCollection,
  accountSummary,
  authStatus,
  routeAccounts,
  type AccountHandlers,
} from './support/accounts-harness.ts'
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
const failure = {
  ok: false as const,
  error: { code: 'accounts/internal', message: 'accounts operation failed', details: {} },
}

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

interface RenderOptions {
  readonly handlers: AccountHandlers
  readonly locale?: TestLocale
  readonly writable?: boolean
}

/**
 * 挂载真实账号配置区，并等待首次账号读取完成。
 * @param channel - 当前渠道。
 * @param options - RPC 处理器、locale 与可写性。
 * @returns 容器、调用记录、翻译与 auth busy 回调。
 */
async function renderAccount(channel: ChannelId, options: RenderOptions) {
  const t = translator(options.locale ?? 'zh')
  const rpc = createConnectionDouble(routeAccounts(options.handlers))
  const onAuthBusyChange = vi.fn()
  const root = mount(createElement(AccountChannelConfig, {
    channel,
    connection: rpc.connection,
    t,
    writable: options.writable ?? true,
    onAuthBusyChange,
  }))
  mounted.push(root)
  await flush()
  return { ...rpc, t, onAuthBusyChange, ...root }
}

/** 读取全部账号行的名字。 */
function accountNames(container: ParentNode): string[] {
  return [...container.querySelectorAll('[data-account-row]')]
    .map(row => row.getAttribute('data-account-id') ?? '')
}

describe('AccountChannelConfig（真实 DOM）', () => {
  it.each(CHANNEL_IDS)('渠道 %s 只读取并显示本渠道合法账号，不串用其他渠道', async (channel) => {
    const own = accountSummary(channel, 'own-account', { displayName: 'Own Account' })
    const foreign = accountSummary(
      CHANNEL_IDS.find(id => id !== channel) ?? 'buddy',
      'foreign-account',
      { displayName: 'Foreign Account' },
    )
    const { container, calls } = await renderAccount(channel, {
      handlers: {
        'accounts.list': () => ({ ok: true, value: [own] }),
        'accounts.current': () => ({ ok: true, value: own }),
      },
    })

    expect(accountNames(container)).toEqual(['own-account'])
    expect(container.textContent).toContain('Own Account')
    expect(container.textContent).not.toContain('Foreign Account')
    expect(container.textContent).toContain('当前使用')
    expect(container.querySelector('[data-account-state]')?.getAttribute('data-account-state'))
      .toBe('selected')
    expect(calls.every(call => (
      (call.payload as { channel?: string }).channel === channel
    ))).toBe(true)
    expect(calls.map(call => call.method)).toEqual(['accounts.list', 'accounts.current'])
    expect(foreign.channelId).not.toBe(channel)
  })

  it('跨渠道/畸形 list 或 current 整次读取失败，不显示需要账号或部分列表', async () => {
    const own = accountSummary('buddy', 'own-account')
    const foreign = accountSummary('qoder', 'foreign-account')
    const { container } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => ({ ok: true, value: [own, foreign] }),
        'accounts.current': () => ({ ok: true, value: own }),
      },
    })

    expect(accountNames(container)).toEqual([])
    expect(container.textContent).not.toContain('需要账号')
    expect(container.textContent).not.toContain('Foreign Account')
    expect(container.querySelector('[data-account-state]')?.getAttribute('data-account-state'))
      .toBe('error')
    const error = query<HTMLElement>(container, '[data-account-error]')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toContain('读取账号失败')
  })

  it('读取中不假装没有账号；失败可重试，错误红字保持 class=error', async () => {
    let fail = true
    const list = deferred<RpcResult<readonly AccountSummary[]>>()
    const current = deferred<RpcResult<AccountSummary | null>>()
    const { container, calls } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => (fail ? list.promise : { ok: true, value: [] }),
        'accounts.current': () => (fail ? current.promise : { ok: true, value: null }),
      },
    })

    expect(container.querySelector('[data-account-state]')?.getAttribute('data-account-state'))
      .toBe('loading')
    expect(container.textContent).toContain('正在读取账号')
    expect(container.textContent).not.toContain('需要账号')

    list.resolve(failure)
    await flush()
    const error = query<HTMLElement>(container, '[data-account-error]')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.className).toContain('error')
    expect(error.textContent).toContain('读取账号失败')
    expect(error.closest('[data-gated], [inert], [aria-disabled="true"]')).toBeNull()
    expect(container.textContent).not.toContain('需要账号')

    fail = false
    await click(query(container, '[data-action="retry-accounts"]'))
    await flush()
    expect(container.querySelector('[data-account-error]')).toBeNull()
    expect(container.querySelector('[data-account-state]')?.getAttribute('data-account-state'))
      .toBe('required')
    expect(container.textContent).toContain('需要账号')
    expect(calls.filter(call => call.method === 'accounts.list')).toHaveLength(2)
  })

  it('当前/备选、脱敏标识与六种状态文案都来自本渠道列表', async () => {
    const current = accountSummary('buddy', 'account-a', { displayName: 'Account A' })
    const alternative = accountSummary('buddy', 'account-b', {
      displayName: 'Account B',
      maskedIdentifier: 'b***@example.com',
      status: 'reauth_required',
    })
    const { container } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => ({ ok: true, value: [current, alternative] }),
        'accounts.current': () => ({ ok: true, value: current }),
      },
    })

    const rows = [...container.querySelectorAll<HTMLElement>('[data-account-row]')]
    expect(rows.map(row => row.getAttribute('data-account-id'))).toEqual(['account-a', 'account-b'])
    expect(rows[0]?.getAttribute('data-current')).toBe('true')
    expect(rows[0]?.textContent).toContain('当前使用')
    expect(rows[0]?.textContent).toContain('正常')
    expect(rows[0]?.querySelector('[data-action="set-current"]')).toBeNull()
    expect(rows[1]?.getAttribute('data-current')).toBe('false')
    expect(rows[1]?.textContent).toContain('备选')
    expect(rows[1]?.textContent).toContain('需要重新登录')
    expect(rows[1]?.textContent).toContain('b***@example.com')
    expect(query(rows[1] as HTMLElement, '[data-action="set-current"]').textContent)
      .toContain('设为当前使用')

    expect(query(rows[0] as HTMLElement, '[class*="accountBadge"]').getAttribute('data-tone')).toBe('solid')
    expect(query(rows[1] as HTMLElement, '[class*="accountBadge"]').getAttribute('data-tone')).toBe('neutral')
    expect(rows[0]?.querySelector('[data-account-actions]')).not.toBeNull()
    expect(rows[1]?.querySelector('[data-account-actions]')).not.toBeNull()

    const accountsHead = query<HTMLElement>(container, '[data-field="accounts"] [data-field-head]')
    expect(query<HTMLElement>(accountsHead, '[data-label-group]').textContent).toBe('账号')
    expect(accountsHead.querySelector('[data-field-actions] [data-action="add-account"]')).not.toBeNull()
    const clearHead = query<HTMLElement>(container, '[data-field="clear-accounts"] [data-field-head]')
    expect(query<HTMLElement>(clearHead, '[data-label-group]').textContent).toBe('清除全部账号数据')
    expect(clearHead.querySelector('[data-field-actions] [data-action="clear-all"]')).not.toBeNull()
  })

  it('显式设为当前只锁相关行；成功后当前标记移动，不自动影响其他账号', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const response = deferred<RpcResult<AccountSummary | null>>()
    const { container, calls } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => ({ ok: true, value: [a, b] }),
        'accounts.current': () => ({ ok: true, value: a }),
        'accounts.setCurrent': () => response.promise,
      },
    })

    const rowA = query<HTMLElement>(container, '[data-account-row][data-account-id="account-a"]')
    const rowB = query<HTMLElement>(container, '[data-account-row][data-account-id="account-b"]')
    await click(query(rowB, '[data-action="set-current"]'))

    expect(query<HTMLButtonElement>(rowB, '[data-action="set-current"]').disabled).toBe(true)
    expect(query<HTMLButtonElement>(rowB, '[data-action="delete"]').disabled).toBe(true)
    expect(query<HTMLButtonElement>(rowA, '[data-action="delete"]').disabled).toBe(false)
    expect(calls.find(call => call.method === 'accounts.setCurrent')).toEqual({
      method: 'accounts.setCurrent',
      payload: { channel: 'buddy', accountId: 'account-b' },
    })

    response.resolve({ ok: true, value: b })
    await flush()
    const movedA = query<HTMLElement>(container, '[data-account-row][data-account-id="account-a"]')
    const movedB = query<HTMLElement>(container, '[data-account-row][data-account-id="account-b"]')
    expect(movedA.getAttribute('data-current')).toBe('false')
    expect(movedB.getAttribute('data-current')).toBe('true')
    expect(container.querySelector('button:disabled')).toBeNull()
  })

  it('第一行操作在飞时第二行操作显示排队，并按顺序执行', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const setCurrentResponse = deferred<RpcResult<AccountSummary | null>>()
    const deleteResponse = deferred<RpcResult<ReturnType<typeof accountCollection>>>()
    const { container, calls } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => ({ ok: true, value: [a, b] }),
        'accounts.current': () => ({ ok: true, value: a }),
        'accounts.setCurrent': () => setCurrentResponse.promise,
        'accounts.delete': () => deleteResponse.promise,
      },
    })

    await click(query(container, '[data-action="set-current"][data-account-id="account-b"]'))
    await click(query(container, '[data-action="delete"][data-account-id="account-a"]'))
    const confirmation = query<HTMLElement>(container, '[data-delete-confirmation]')
    await click(query(confirmation, '[data-action="confirm-delete"]'))

    const rowA = query<HTMLElement>(container, '[data-account-row][data-account-id="account-a"]')
    expect(rowA.getAttribute('data-row-queued')).toBe('true')
    expect(rowA.textContent).toContain('排队中')
    expect(query<HTMLButtonElement>(confirmation, '[data-action="confirm-delete"]').disabled)
      .toBe(true)
    expect(calls.filter(call => call.method === 'accounts.setCurrent')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'accounts.delete')).toEqual([])

    setCurrentResponse.resolve({ ok: true, value: b })
    await flush()
    expect(calls.find(call => call.method === 'accounts.delete')).toEqual({
      method: 'accounts.delete',
      payload: { channel: 'buddy', accountId: 'account-a' },
    })
    expect(query(container, '[data-account-row][data-account-id="account-a"]')
      .getAttribute('data-row-busy')).toBe('true')
    expect(container.textContent).toContain('处理中')
    expect(container.textContent).not.toContain('排队中')

    deleteResponse.resolve({ ok: true, value: accountCollection([b], b) })
    await flush()
    expect(accountNames(container)).toEqual(['account-b'])
    expect(query(container, '[data-account-row][data-account-id="account-b"]')
      .getAttribute('data-current')).toBe('true')
    expect(container.querySelector('[data-delete-confirmation]')).toBeNull()
    expect(container.textContent).not.toContain('排队中')
  })

  it('授权完成后的刷新在飞时锁账号写操作，刷新 settle 后恢复', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const secondList = deferred<RpcResult<readonly AccountSummary[]>>()
    const secondCurrent = deferred<RpcResult<AccountSummary | null>>()
    let listCalls = 0
    let currentCalls = 0
    const { container, calls } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => {
          listCalls += 1
          return listCalls === 1
            ? { ok: true, value: [a, b] }
            : secondList.promise
        },
        'accounts.current': () => {
          currentCalls += 1
          return currentCalls === 1
            ? { ok: true, value: a }
            : secondCurrent.promise
        },
        'accounts.setCurrent': () => ({ ok: true, value: b }),
        'auth.start': () => ({
          ok: true,
          value: authStatus('buddy', {
            status: 'completed',
            authUrl: null,
            account: a,
          }),
        }),
      },
    })

    await click(query(container, '[data-action="add-account"]'))
    await flush()
    expect(query<HTMLButtonElement>(container, '[data-action="add-account"]').disabled).toBe(true)
    expect(query<HTMLButtonElement>(container, '[data-action="set-current"]').disabled).toBe(true)

    await click(query(container, '[data-action="set-current"]'))
    expect(calls.filter(call => call.method === 'accounts.setCurrent')).toEqual([])

    secondList.resolve({ ok: true, value: [a, b] })
    await flush()
    expect(query<HTMLButtonElement>(container, '[data-action="set-current"]').disabled).toBe(true)

    secondCurrent.resolve({ ok: true, value: a })
    await flush()
    expect(query<HTMLButtonElement>(container, '[data-action="set-current"]').disabled).toBe(false)
    expect(container.textContent).toContain('账号已添加')
  })

  it('排队中的删除确认可以取消，取消后不再执行该删除', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const setCurrentResponse = deferred<RpcResult<AccountSummary | null>>()
    const { container, calls } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => ({ ok: true, value: [a, b] }),
        'accounts.current': () => ({ ok: true, value: a }),
        'accounts.setCurrent': () => setCurrentResponse.promise,
        'accounts.delete': () => ({ ok: true, value: accountCollection([b], b) }),
      },
    })

    await click(query(container, '[data-action="set-current"][data-account-id="account-b"]'))
    await click(query(container, '[data-action="delete"][data-account-id="account-a"]'))
    const confirmation = query<HTMLElement>(container, '[data-delete-confirmation]')
    await click(query(confirmation, '[data-action="confirm-delete"]'))
    expect(container.textContent).toContain('排队中')

    await click(query(confirmation, '[data-action="cancel-delete"]'))
    expect(container.querySelector('[data-delete-confirmation]')).toBeNull()
    expect(container.textContent).not.toContain('排队中')

    setCurrentResponse.resolve({ ok: true, value: b })
    await flush()
    expect(calls.filter(call => call.method === 'accounts.delete')).toEqual([])
    expect(query(container, '[data-account-row][data-account-id="account-b"]')
      .getAttribute('data-current')).toBe('true')
  })

  it('添加账号在渠道区内联展开，授权 busy 通知上层且不自动打开 Search', async () => {
    const start = deferred<RpcResult<ReturnType<typeof authStatus>>>()
    const { container, calls, onAuthBusyChange } = await renderAccount('qodercn', {
      handlers: {
        'auth.start': () => start.promise,
      },
    })

    const add = query<HTMLButtonElement>(container, '[data-action="add-account"]')
    expect(add.textContent).toContain('添加账号')
    await click(add)

    expect(onAuthBusyChange).toHaveBeenLastCalledWith(true)
    expect(query(container, '[data-inline-auth]').getAttribute('data-auth-phase')).toBe('starting')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(calls.find(call => call.method === 'auth.start')).toEqual({
      method: 'auth.start',
      payload: { channel: 'qodercn' },
    })
    expect(query<HTMLButtonElement>(container, '[data-action="add-account"]').disabled).toBe(true)

    start.resolve({
      ok: true,
      value: authStatus('qodercn', { channel: 'qodercn' }),
    })
    await flush()
    const auth = query<HTMLElement>(container, '[data-inline-auth]')
    expect(auth.getAttribute('data-auth-phase')).toBe('pending')
    expect(auth.textContent).toContain('等待授权完成')
    expect(query<HTMLElement>(auth, '[data-auth-url]').textContent).toBe(AUTH_URLS.qodercn)
    expect(auth.querySelector('a[href]')).toBeNull()
    expect(auth.textContent).not.toContain('请在浏览器中完成授权')
    expect(onAuthBusyChange).toHaveBeenLastCalledWith(true)
  })

  it('重新登录带 accountId，标题指向该账号且保持当前账号不变', async () => {
    const a = accountSummary('buddy', 'account-a', { displayName: 'Account A' })
    const { container, calls } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => ({ ok: true, value: [a] }),
        'accounts.current': () => ({ ok: true, value: a }),
        'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      },
    })

    await click(query(container, '[data-action="reauth-account"][data-account-id="account-a"]'))
    expect(calls.find(call => call.method === 'auth.start')).toEqual({
      method: 'auth.start',
      payload: { channel: 'buddy', accountId: 'account-a' },
    })
    const auth = query<HTMLElement>(container, '[data-inline-auth]')
    expect(auth.getAttribute('data-auth-phase')).toBe('pending')
    expect(auth.textContent).toContain('重新登录账号')
    expect(auth.textContent).toContain('Account A')
    expect(container.textContent).toContain('当前使用')
  })

  it('重登刷新失败后错误状态锁定未排队行；点击重试成功即恢复并执行既有队列', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const c = accountSummary('buddy', 'account-c')
    let listCalls = 0
    let currentCalls = 0
    const setCurrentResponse = deferred<RpcResult<AccountSummary | null>>()
    const { container, calls } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => {
          listCalls += 1
          return listCalls === 2
            ? { ok: false as const, error: { code: 'accounts/internal', message: 'x', details: {} } }
            : { ok: true, value: [a, b, c] }
        },
        'accounts.current': () => {
          currentCalls += 1
          return { ok: true, value: currentCalls === 1 ? a : b }
        },
        'accounts.setCurrent': () => setCurrentResponse.promise,
        'accounts.delete': () => ({ ok: true, value: accountCollection([a, b], b) }),
        'auth.start': () => ({
          ok: true,
          value: authStatus('buddy', {
            status: 'completed',
            authUrl: null,
            account: a,
          }),
        }),
      },
    })

    await click(query(container, '[data-action="set-current"][data-account-id="account-b"]'))
    await click(query(container, '[data-action="reauth-account"][data-account-id="account-a"]'))
    await click(query(container, '[data-action="delete"][data-account-id="account-c"]'))
    const confirmation = query<HTMLElement>(container, '[data-delete-confirmation]')
    await click(query(confirmation, '[data-action="confirm-delete"]'))
    expect(container.textContent).toContain('排队中')

    setCurrentResponse.resolve({ ok: true, value: b })
    await flush()
    await flush()

    expect(query(container, '[data-account-error]').textContent).toContain('读取账号失败')
    const retry = query<HTMLButtonElement>(container, '[data-action="retry-accounts"]')
    expect(retry.disabled).toBe(false)
    expect(query<HTMLButtonElement>(container, '[data-action="add-account"]').disabled).toBe(true)
    expect(query<HTMLButtonElement>(
      container,
      '[data-action="set-current"][data-account-id="account-a"]',
    ).disabled).toBe(true)
    expect(query<HTMLButtonElement>(
      container,
      '[data-action="delete"][data-account-id="account-c"]',
    ).disabled).toBe(true)
    expect(container.textContent).toContain('排队中')
    expect(calls.filter(call => call.method === 'accounts.delete')).toEqual([])

    await click(retry)
    await flush()
    await flush()

    expect(calls.find(call => call.method === 'accounts.delete')).toEqual({
      method: 'accounts.delete',
      payload: { channel: 'buddy', accountId: 'account-c' },
    })
    expect(accountNames(container)).toEqual(['account-a', 'account-b'])
    expect(query(container, '[data-account-row][data-account-id="account-b"]')
      .getAttribute('data-current')).toBe('true')
    expect(container.querySelector('[data-account-error]')).toBeNull()
    expect(container.textContent).not.toContain('排队中')
    expect(container.querySelector('[data-delete-confirmation]')).toBeNull()
    expect(query<HTMLButtonElement>(
      container,
      '[data-action="set-current"][data-account-id="account-a"]',
    ).disabled).toBe(false)
  })

  it('授权刷新失败的错误状态禁用未排队行按钮，重试成功后恢复', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    let listCalls = 0
    let currentCalls = 0
    const { container } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => {
          listCalls += 1
          return listCalls === 2
            ? { ok: false as const, error: { code: 'accounts/internal', message: 'x', details: {} } }
            : { ok: true, value: [a, b] }
        },
        'accounts.current': () => {
          currentCalls += 1
          return { ok: true, value: a }
        },
        'auth.start': () => ({
          ok: true,
          value: authStatus('buddy', {
            status: 'completed',
            authUrl: null,
            account: a,
          }),
        }),
      },
    })

    await click(query(container, '[data-action="add-account"]'))
    await flush()
    await flush()

    expect(query(container, '[data-account-error]').textContent).toContain('读取账号失败')
    expect(query<HTMLButtonElement>(container, '[data-action="retry-accounts"]').disabled)
      .toBe(false)
    expect(query<HTMLButtonElement>(container, '[data-action="add-account"]').disabled).toBe(true)
    expect(query<HTMLButtonElement>(container, '[data-action="clear-all"]').disabled).toBe(true)
    expect(query<HTMLButtonElement>(
      container,
      '[data-action="set-current"][data-account-id="account-b"]',
    ).disabled).toBe(true)
    expect(container.textContent).not.toContain('排队中')

    await click(query(container, '[data-action="retry-accounts"]'))
    await flush()
    await flush()

    expect(container.querySelector('[data-account-error]')).toBeNull()
    expect(query<HTMLButtonElement>(
      container,
      '[data-action="set-current"][data-account-id="account-b"]',
    ).disabled).toBe(false)
  })

  it('重登返回其他账号时不显示成功，保持当前账号与错误状态', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const { container } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => ({ ok: true, value: [a, b] }),
        'accounts.current': () => ({ ok: true, value: a }),
        'auth.start': () => ({
          ok: true,
          value: authStatus('buddy', {
            status: 'completed',
            authUrl: null,
            account: b,
          }),
        }),
      },
    })

    await click(query(container, '[data-action="reauth-account"][data-account-id="account-a"]'))
    await flush()

    const auth = query<HTMLElement>(container, '[data-inline-auth]')
    expect(auth.getAttribute('data-auth-phase')).toBe('failed')
    expect(auth.textContent).toContain('授权服务返回了无效响应')
    expect(container.textContent).not.toContain('重新登录完成')
    expect(query(container, '[data-account-row][data-account-id="account-a"]')
      .getAttribute('data-current')).toBe('true')
    expect(query(container, '[data-account-row][data-account-id="account-b"]')
      .getAttribute('data-current')).toBe('false')
  })

  it('删除当前账号默认“暂不指定”，确认前不发 RPC，成功后不自动递补', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const deletion = deferred<RpcResult<ReturnType<typeof accountCollection>>>()
    const { container, calls } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => ({ ok: true, value: [a, b] }),
        'accounts.current': () => ({ ok: true, value: a }),
        'accounts.delete': () => deletion.promise,
      },
    })

    await click(query(container, '[data-action="delete"][data-account-id="account-a"]'))
    const confirmation = query<HTMLElement>(container, '[data-delete-confirmation]')
    expect(confirmation.textContent).toContain('确认删除账号')
    expect(confirmation.textContent).toContain('网页搜索将不可用')
    expect(confirmation.textContent).toContain('不会自动选择其他账号')
    expect(query<HTMLElement>(confirmation, '[data-delete-impact]').className).toContain('warning')
    expect(query<HTMLElement>(confirmation, '[data-delete-impact]').className).not.toContain('error')
    expect(calls.filter(call => call.method === 'accounts.delete')).toEqual([])

    const none = query<HTMLInputElement>(confirmation, '[data-replacement-option="none"]')
    expect(none.checked).toBe(true)
    const bOption = query<HTMLInputElement>(confirmation, '[data-replacement-option="account-b"]')
    expect(bOption.checked).toBe(false)

    await click(query(confirmation, '[data-action="confirm-delete"]'))
    expect(calls.find(call => call.method === 'accounts.delete')).toEqual({
      method: 'accounts.delete',
      payload: { channel: 'buddy', accountId: 'account-a', replacementAccountId: null },
    })

    deletion.resolve({
      ok: true,
      value: accountCollection([b], null),
    })
    await flush()

    expect(container.querySelector('[data-delete-confirmation]')).toBeNull()
    expect(accountNames(container)).toEqual(['account-b'])
    expect(query(container, '[data-account-row][data-account-id="account-b"]')
      .getAttribute('data-current')).toBe('false')
    expect(container.textContent).toContain('未选择当前账号')
    expect(calls.some(call => call.method === 'accounts.setCurrent')).toBe(false)
  })

  it('删除当前账号可显式选择替代账号，payload 带 replacementAccountId', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const deletion = deferred<RpcResult<ReturnType<typeof accountCollection>>>()
    const { container, calls } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => ({ ok: true, value: [a, b] }),
        'accounts.current': () => ({ ok: true, value: a }),
        'accounts.delete': () => deletion.promise,
      },
    })

    await click(query(container, '[data-action="delete"][data-account-id="account-a"]'))
    const confirmation = query<HTMLElement>(container, '[data-delete-confirmation]')
    const option = query<HTMLInputElement>(confirmation, '[data-replacement-option="account-b"]')
    await click(option)
    expect(option.checked).toBe(true)

    await click(query(confirmation, '[data-action="confirm-delete"]'))
    expect(calls.find(call => call.method === 'accounts.delete')).toEqual({
      method: 'accounts.delete',
      payload: {
        channel: 'buddy',
        accountId: 'account-a',
        replacementAccountId: 'account-b',
      },
    })

    deletion.resolve({ ok: true, value: accountCollection([b], b) })
    await flush()
    expect(query(container, '[data-account-row][data-account-id="account-b"]')
      .getAttribute('data-current')).toBe('true')
  })

  it('删除备选账号没有替代选择，payload 不带 replacementAccountId', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const { container, calls } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => ({ ok: true, value: [a, b] }),
        'accounts.current': () => ({ ok: true, value: a }),
        'accounts.delete': () => ({ ok: true, value: accountCollection([a], a) }),
      },
    })

    await click(query(container, '[data-action="delete"][data-account-id="account-b"]'))
    const confirmation = query<HTMLElement>(container, '[data-delete-confirmation]')
    expect(confirmation.querySelector('[data-replacement-group]')).toBeNull()
    await click(query(confirmation, '[data-action="confirm-delete"]'))
    expect(calls.find(call => call.method === 'accounts.delete')).toEqual({
      method: 'accounts.delete',
      payload: { channel: 'buddy', accountId: 'account-b' },
    })
    await flush()
    expect(accountNames(container)).toEqual(['account-a'])
  })

  it('删除失败保留账号与确认区，并显示未被门控覆盖的红色错误', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const { container } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => ({ ok: true, value: [a, b] }),
        'accounts.current': () => ({ ok: true, value: a }),
        'accounts.delete': () => failure,
      },
    })

    await click(query(container, '[data-action="delete"][data-account-id="account-a"]'))
    await click(query(container, '[data-delete-confirmation] [data-action="confirm-delete"]'))
    await flush()

    expect(accountNames(container)).toEqual(['account-a', 'account-b'])
    expect(query(container, '[data-account-row][data-account-id="account-a"]')
      .getAttribute('data-current')).toBe('true')
    expect(container.querySelector('[data-delete-confirmation]')).not.toBeNull()
    const alert = query<HTMLElement>(container, '[data-account-error]')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.className).toContain('error')
    expect(alert.textContent).toContain('删除失败')
    expect(alert.closest('[data-gated], [inert], [aria-disabled="true"]')).toBeNull()
  })

  it('清除全部数据就地二次确认，明确影响四渠道且不可恢复；取消不写', async () => {
    const a = accountSummary('buddy', 'account-a')
    let cleared = false
    const { container, calls } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => ({ ok: true, value: cleared ? [] : [a] }),
        'accounts.current': () => ({ ok: true, value: cleared ? null : a }),
        'accounts.clearAll': () => {
          cleared = true
          return { ok: true, value: { cleared: 1 } }
        },
      },
    })

    const clearAll = query<HTMLButtonElement>(container, '[data-action="clear-all"]')
    expect(clearAll.textContent).toContain('清除全部账号数据')
    await click(clearAll)

    const confirmation = query<HTMLElement>(container, '[data-clear-confirmation]')
    expect(confirmation.textContent).toContain('CodeBuddy')
    expect(confirmation.textContent).toContain('WorkBuddy')
    expect(confirmation.textContent).toContain('Qoder 国际版')
    expect(confirmation.textContent).toContain('Qoder 中国版')
    expect(confirmation.textContent).toContain('无法自动恢复')
    expect(query<HTMLElement>(confirmation, '[data-clear-impact]').className).toContain('warning')
    expect(query<HTMLElement>(confirmation, '[data-clear-impact]').className).not.toContain('error')
    expect(calls.filter(call => call.method === 'accounts.clearAll')).toEqual([])

    await click(query(confirmation, '[data-action="cancel-clear-all"]'))
    expect(container.querySelector('[data-clear-confirmation]')).toBeNull()
    expect(calls.filter(call => call.method === 'accounts.clearAll')).toEqual([])

    await click(clearAll)
    await click(query(container, '[data-clear-confirmation] [data-action="confirm-clear-all"]'))
    await flush()

    expect(calls.find(call => call.method === 'accounts.clearAll')).toEqual({
      method: 'accounts.clearAll',
      payload: {},
    })
    expect(accountNames(container)).toEqual([])
    expect(container.textContent).toContain('需要账号')
    expect(container.textContent).toContain('已清除全部账号数据')
    expect(container.querySelector('[data-clear-confirmation]')).toBeNull()
  })

  it('清除全部失败保留账号区并显示本地化错误', async () => {
    const a = accountSummary('buddy', 'account-a')
    const { container } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => ({ ok: true, value: [a] }),
        'accounts.current': () => ({ ok: true, value: a }),
        'accounts.clearAll': () => failure,
      },
    })

    await click(query(container, '[data-action="clear-all"]'))
    await click(query(container, '[data-clear-confirmation] [data-action="confirm-clear-all"]'))
    await flush()

    expect(accountNames(container)).toEqual(['account-a'])
    const alert = query<HTMLElement>(container, '[data-account-error]')
    expect(alert.textContent).toContain('清除失败')
    expect(alert.className).toContain('error')
  })

  it('只渲染六字段账号投影：任一夹带额外秘密字段的 DTO 使整次读取失败', async () => {
    const valid = accountSummary('buddy', 'account-a', { displayName: 'Safe Account' })
    const poisoned = {
      ...accountSummary('buddy', 'account-b', { displayName: 'Poisoned Account' }),
      accessToken: 'sentinel-access-token',
      machine_id: 'sentinel-machine-id',
    } as unknown as AccountSummary
    const { container } = await renderAccount('buddy', {
      handlers: {
        'accounts.list': () => ({ ok: true, value: [valid, poisoned] }),
        'accounts.current': () => ({ ok: true, value: valid }),
      },
    })

    expect(accountNames(container)).toEqual([])
    expect(container.textContent).not.toContain('Safe Account')
    expect(container.textContent).not.toContain('Poisoned Account')
    expect(container.innerHTML).not.toContain('sentinel-access-token')
    expect(container.innerHTML).not.toContain('sentinel-machine-id')
    expect(container.innerHTML).not.toContain('accessToken')
    expect(query(container, '[data-account-error]').textContent).toContain('读取账号失败')
  })

  it('账号行不把 AccountSummary.endpointLabel 冒充实际端点', async () => {
    const a = accountSummary('qoder', 'account-a', {
      endpointLabel: 'center.qoder.sh',
    })
    const { container } = await renderAccount('qoder', {
      handlers: {
        'accounts.list': () => ({ ok: true, value: [a] }),
        'accounts.current': () => ({ ok: true, value: a }),
      },
    })

    expect(container.textContent).not.toContain('center.qoder.sh')
    expect(container.textContent).not.toContain('api2.qoder.sh')
  })

  it('只读时添加/设当前/重登/删除/清除都被禁用，但错误仍可读', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const { container } = await renderAccount('buddy', {
      writable: false,
      handlers: {
        'accounts.list': () => ({ ok: true, value: [a, b] }),
        'accounts.current': () => ({ ok: true, value: a }),
      },
    })

    expect(query<HTMLButtonElement>(container, '[data-action="add-account"]').disabled).toBe(true)
    expect(query<HTMLButtonElement>(container, '[data-action="clear-all"]').disabled).toBe(true)
    expect(query<HTMLButtonElement>(container, '[data-action="set-current"]').disabled).toBe(true)
    expect(query<HTMLButtonElement>(container, '[data-action="reauth-account"]').disabled).toBe(true)
    expect(query<HTMLButtonElement>(container, '[data-action="delete"]').disabled).toBe(true)
  })

  it('英文文案覆盖当前/备选、状态、操作、删除与清除确认', async () => {
    const a = accountSummary('buddy', 'account-a', { displayName: 'Account A' })
    const b = accountSummary('buddy', 'account-b', {
      displayName: 'Account B',
      status: 'reauth_required',
    })
    const { container } = await renderAccount('buddy', {
      locale: 'en',
      handlers: {
        'accounts.list': () => ({ ok: true, value: [a, b] }),
        'accounts.current': () => ({ ok: true, value: a }),
      },
    })

    expect(container.textContent).toContain('In use')
    expect(container.textContent).toContain('Alternative')
    expect(container.textContent).toContain('Sign-in required')
    expect(container.textContent).toContain('Set as current')
    expect(container.textContent).toContain('Add account')
    expect(container.textContent).toContain('Clear all account data')
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/)
  })
})