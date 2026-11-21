// @vitest-environment jsdom
/**
 * Task 14 内联授权：状态轮询、取消、失败/超时映射、复制链接降级、授权链接
 * 只读展示（不自动打开、不持久化）、displayHint 不直出、authBusy 锁主渠道、
 * 卸载/正常渠道切换清理旧 generation 与轮询。
 */
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AccountChannelConfig } from '../../src/client/AccountChannelConfig.tsx'
import { InlineAuthFlow } from '../../src/client/InlineAuthFlow.tsx'
import type { AccountsAuthView } from '../../src/client/controllers/accounts.ts'
import { SettingsCard } from '../../src/client/SettingsCard.tsx'
import type { AccountSummary } from '../../src/shared/accounts.ts'
import type { SearchSettingsSnapshot } from '../../src/shared/contracts.ts'
import type { RpcResult } from '../../src/shared/rpc.ts'
import {
  AUTH_URLS,
  accountSummary,
  authStatus,
  routeAccounts,
  type AccountHandlers,
} from './support/accounts-harness.ts'
import {
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
  type RpcResponder,
  type TestLocale,
} from './support/settings-harness.ts'

const mounted: MountedRoot[] = []
const failure = {
  ok: false as const,
  error: { code: 'auth/internal', message: 'auth operation failed', details: {} },
}

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (navigator as { clipboard?: unknown }).clipboard
})

/**
 * 挂载真实账号区并等待首次读取。
 * @param channel - 当前渠道。
 * @param handlers - 账号/授权 RPC 处理器。
 * @param options - locale 与轮询间隔。
 * @returns 容器、调用记录、翻译函数。
 */
async function renderAccount(
  channel: 'buddy' | 'workbuddy' | 'qoder' | 'qodercn',
  handlers: AccountHandlers,
  options: { locale?: TestLocale; pollIntervalMs?: number } = {},
) {
  const t = translator(options.locale ?? 'zh')
  const rpc = createConnectionDouble(routeAccounts(handlers))
  const root = mount(createElement(AccountChannelConfig, {
    channel,
    connection: rpc.connection,
    t,
    writable: true,
    pollIntervalMs: options.pollIntervalMs ?? 1000,
  }))
  mounted.push(root)
  await flush()
  return { ...rpc, t, ...root }
}

/**
 * 挂载真实设置卡；账号 RPC 走给定处理器，settings RPC 走设置响应。
 * @param snapshot - 初始设置快照。
 * @param handlers - 账号/授权 RPC 处理器。
 * @param settingsResponder - settings RPC 响应。
 * @returns 容器、调用记录、翻译与表单替身。
 */
async function renderCard(
  snapshot: SearchSettingsSnapshot,
  handlers: AccountHandlers,
  settingsResponder: RpcResponder = () => ({ ok: true, value: snapshot }),
) {
  const t = translator('zh')
  const forms = createConfigFormsDouble(snapshot)
  const accounts = routeAccounts(handlers)
  const routed: RpcResponder = call => (
    call.method.startsWith('accounts.') || call.method.startsWith('auth.')
      ? accounts(call)
      : settingsResponder(call)
  )
  const rpc = createConnectionDouble(routed)
  const root = mount(createElement(SettingsCard, {
    view: 'page',
    t,
    configForms: forms.configForms,
    connection: rpc.connection,
  }))
  mounted.push(root)
  await flush()
  return { ...forms, ...rpc, t, ...root }
}

/** 点击账号区里的添加账号并等待初始授权状态。 */
async function startAdd(container: HTMLElement): Promise<void> {
  await click(query(container, '[data-action="add-account"]'))
  await flush()
}

/** 在 act 中推进授权轮询。 */
async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  await flush()
}

describe('InlineAuthFlow（真实 DOM）', () => {
  it('授权链接复制成功显示已复制；剪贴板不可用/拒绝时降级提示并保留只读链接', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { container } = await renderAccount('buddy', {
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
    })
    await startAdd(container)

    await click(query(container, '[data-action="copy-auth"]'))
    await flush()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(AUTH_URLS.buddy)
    expect(container.textContent).toContain('已复制授权链接')
    expect(query(container, '[data-auth-url]').textContent).toBe(AUTH_URLS.buddy)

    writeText.mockRejectedValueOnce(new Error('denied'))
    await click(query(container, '[data-action="copy-auth"]'))
    await flush()
    expect(container.textContent).toContain('复制失败，请手动选择并复制链接')
    expect(query(container, '[data-auth-url]').textContent).toBe(AUTH_URLS.buddy)

    delete (navigator as { clipboard?: unknown }).clipboard
    await click(query(container, '[data-action="copy-auth"]'))
    await flush()
    expect(container.textContent).toContain('复制失败，请手动选择并复制链接')
    expect(container.textContent).not.toContain('已复制授权链接')
  })

  it('B11：A→B 同 URL 不同 flow 时，A 的迟到复制结果不得标到 B', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    const writeText = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const t = translator('zh')
    const auth = (flowId: string): AccountsAuthView => ({
      phase: 'pending', flowId, authUrl: AUTH_URLS.buddy, errorCode: null, targetAccountId: null,
    })
    const element = (flowId: string) => createElement(InlineAuthFlow, {
      auth: auth(flowId), accountName: null, t, onCancel: () => {}, onDismiss: () => {},
    })
    const root = mount(element('flow-a'))
    mounted.push(root)
    await click(query(root.container, '[data-action="copy-auth"]'))
    await root.rerender(element('flow-b'))
    await click(query(root.container, '[data-action="copy-auth"]'))

    first.resolve()
    await flush()
    expect(query<HTMLElement>(root.container, '[data-copy-state]').getAttribute('data-copy-state'))
      .not.toBe('copied')
    second.resolve()
    await flush()
    expect(query<HTMLElement>(root.container, '[data-copy-state]').getAttribute('data-copy-state'))
      .toBe('copied')
  })

  it('B11：A 的迟到 reject 不把 B 标为失败，卸载后不 setState 或选中旧链接', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    const writeText = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const t = translator('zh')
    const auth = (flowId: string): AccountsAuthView => ({
      phase: 'pending', flowId, authUrl: AUTH_URLS.buddy, errorCode: null, targetAccountId: null,
    })
    const element = (flowId: string) => createElement(InlineAuthFlow, {
      auth: auth(flowId), accountName: null, t, onCancel: () => {}, onDismiss: () => {},
    })
    const root = mount(element('flow-a'))
    mounted.push(root)
    await click(query(root.container, '[data-action="copy-auth"]'))
    await root.rerender(element('flow-b'))
    await click(query(root.container, '[data-action="copy-auth"]'))
    first.reject(new Error('late denied'))
    await flush()
    expect(query<HTMLElement>(root.container, '[data-copy-state]').getAttribute('data-copy-state'))
      .not.toBe('failed')
    second.resolve()
    await flush()

    const late = deferred<void>()
    writeText.mockImplementationOnce(() => late.promise)
    await click(query(root.container, '[data-action="copy-auth"]'))
    const selection = vi.spyOn(window, 'getSelection')
    root.unmount()
    late.reject(new Error('unmounted denied'))
    await flush()
    expect(selection).not.toHaveBeenCalled()
  })

  it('授权链接只读展示：不创建链接、不自动打开、不写存储、不渲染 displayHint', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const { container } = await renderAccount('qoder', {
      'auth.start': () => ({
        ok: true,
        value: authStatus('qoder', {
          displayHint: '仅中文的后台提示',
        }),
      }),
    }, { locale: 'en' })
    await startAdd(container)

    const auth = query<HTMLElement>(container, '[data-inline-auth]')
    expect(auth.querySelector('a[href]')).toBeNull()
    expect(open).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
    expect(auth.textContent).not.toContain('仅中文的后台提示')
    expect(auth.textContent).not.toMatch(/[\u4e00-\u9fff]/)
    expect(query<HTMLElement>(auth, '[data-auth-status]').tagName).toBe('P')
    expect(query<HTMLElement>(auth, '[data-auth-instruction]').tagName).toBe('P')
    expect(query<HTMLElement>(auth, '[data-auth-url]').textContent).toContain('machine_id=machine-123')

    const urlElement = query<HTMLElement>(auth, '[data-auth-url]')
    expect(urlElement.className).toContain('authUrl')
    urlElement.remove()
    expect(document.body.textContent).not.toContain('machine_id')
  })

  it('授权/重登在飞时锁定主渠道下拉，取消成功后解锁并保留本地化状态', async () => {
    const start = deferred<RpcResult<ReturnType<typeof authStatus>>>()
    const cancel = deferred<RpcResult<ReturnType<typeof authStatus>>>()
    const { container } = await renderCard(
      makeSnapshot({ enabled: true, channel: 'buddy' }),
      {
        'auth.start': () => start.promise,
        'auth.cancel': () => cancel.promise,
      },
    )

    await click(query(container, '[data-account-config-slot] [data-action="add-account"]'))
    const channelTrigger = query<HTMLButtonElement>(container, '[data-search-section] [data-dropdown-trigger]')
    expect(channelTrigger.disabled).toBe(true)
    expect(query(container, '[data-search-section]').getAttribute('aria-busy')).toBe('true')
    expect(query<HTMLButtonElement>(container, '[data-action="add-account"]').disabled).toBe(true)

    start.resolve({ ok: true, value: authStatus('buddy') })
    await flush()
    expect(query<HTMLButtonElement>(container, '[data-search-section] [data-dropdown-trigger]').disabled)
      .toBe(true)

    await click(query(container, '[data-action="cancel-auth"]'))
    expect(query<HTMLButtonElement>(container, '[data-search-section] [data-dropdown-trigger]').disabled)
      .toBe(true)
    cancel.resolve({
      ok: true,
      value: authStatus('buddy', { status: 'cancelled', authUrl: null }),
    })
    await flush()

    expect(query(container, '[data-inline-auth]').getAttribute('data-auth-phase'))
      .toBe('cancelled')
    expect(container.textContent).toContain('授权已取消')
    expect(query<HTMLButtonElement>(container, '[data-search-section] [data-dropdown-trigger]').disabled)
      .toBe(false)
    expect(query<HTMLButtonElement>(container, '[data-action="add-account"]').disabled).toBe(false)
  })

  it('轮询 pending 后 completed：显示完成、移除授权链接、刷新账号并通知 busy 结束', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = accountSummary('buddy', 'account-a')
    let statusCalls = 0
    const { container, calls } = await renderAccount('buddy', {
      'accounts.list': () => ({ ok: true, value: [a] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.status': () => {
        statusCalls += 1
        return statusCalls === 1
          ? { ok: true, value: authStatus('buddy') }
          : {
              ok: true,
              value: authStatus('buddy', {
                status: 'completed',
                authUrl: null,
                account: a,
              }),
            }
      },
    })
    await startAdd(container)
    expect(query(container, '[data-auth-url]').textContent).toBe(AUTH_URLS.buddy)

    await advance(1000)
    expect(statusCalls).toBe(1)
    expect(query(container, '[data-inline-auth]').getAttribute('data-auth-phase')).toBe('pending')

    await advance(1000)
    expect(statusCalls).toBe(2)
    expect(query(container, '[data-inline-auth]').getAttribute('data-auth-phase')).toBe('completed')
    expect(container.textContent).toContain('授权完成')
    expect(container.querySelector('[data-auth-url]')).toBeNull()
    expect(container.textContent).toContain('账号已添加')
    expect(container.textContent).toContain('Account account-a')
    expect(container.querySelector('[data-account-row][data-account-id="account-a"]')
      ?.getAttribute('data-current')).toBe('true')
    expect(calls.filter(call => call.method === 'auth.status')).toHaveLength(2)

    await advance(5000)
    expect(statusCalls).toBe(2)
  })

  it('失败按 errorCode 显示固定文案，不显示 Host displayHint；关闭终态提示', async () => {
    const { container } = await renderAccount('buddy', {
      'auth.start': () => ({
        ok: true,
        value: authStatus('buddy', {
          status: 'failed',
          authUrl: null,
          displayHint: '仅中文的后台提示',
          errorCode: 'auth/identity-mismatch',
        }),
      }),
    })
    await startAdd(container)

    const auth = query<HTMLElement>(container, '[data-inline-auth]')
    expect(auth.getAttribute('data-auth-phase')).toBe('failed')
    expect(auth.textContent).toContain('登录的账号与要重新登录的账号不一致')
    expect(auth.textContent).not.toContain('仅中文的后台提示')
    expect(auth.querySelector('[role="alert"]')).not.toBeNull()

    await click(query(container, '[data-action="dismiss-auth"]'))
    await flush()
    expect(container.querySelector('[data-inline-auth]')).toBeNull()
  })

  it('超时状态使用本地化超时文案，英文下同样不显示 displayHint', async () => {
    const { container } = await renderAccount('buddy', {
      'auth.start': () => ({
        ok: true,
        value: authStatus('buddy', {
          status: 'timed_out',
          authUrl: null,
          displayHint: '仅中文的后台提示',
        }),
      }),
    }, { locale: 'en' })
    await startAdd(container)

    const auth = query<HTMLElement>(container, '[data-inline-auth]')
    expect(auth.getAttribute('data-auth-phase')).toBe('timed_out')
    expect(auth.textContent).toContain('Authorization timed out')
    expect(auth.textContent).not.toContain('仅中文的后台提示')
    expect(auth.textContent).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('取消授权带 channel/flowId；取消后不再轮询，授权链接移除', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { container, calls } = await renderAccount('buddy', {
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.cancel': () => ({
        ok: true,
        value: authStatus('buddy', { status: 'cancelled', authUrl: null }),
      }),
      'auth.status': () => ({ ok: true, value: authStatus('buddy') }),
    })
    await startAdd(container)

    await click(query(container, '[data-action="cancel-auth"]'))
    await flush()
    expect(calls.find(call => call.method === 'auth.cancel')).toEqual({
      method: 'auth.cancel',
      payload: { channel: 'buddy', flowId: 'flow-1' },
    })
    expect(container.querySelector('[data-auth-url]')).toBeNull()
    expect(query(container, '[data-inline-auth]').getAttribute('data-auth-phase'))
      .toBe('cancelled')

    await advance(5000)
    expect(calls.filter(call => call.method === 'auth.status')).toEqual([])
  })

  it('授权启动失败显示本地化错误并解锁主渠道', async () => {
    const { container } = await renderCard(
      makeSnapshot({ enabled: true, channel: 'workbuddy' }),
      { 'auth.start': () => failure },
    )
    await click(query(container, '[data-account-config-slot] [data-action="add-account"]'))
    await flush()

    expect(query(container, '[data-account-error]').textContent).toContain('无法启动授权')
    expect(query(container, '[data-inline-auth]').getAttribute('data-auth-phase')).toBe('failed')
    expect(query<HTMLButtonElement>(container, '[data-search-section] [data-dropdown-trigger]').disabled)
      .toBe(false)
  })

  it('非 https 授权链接不会展示，也不创建链接', async () => {
    const { container } = await renderAccount('buddy', {
      'auth.start': () => ({
        ok: true,
        value: authStatus('buddy', { authUrl: 'http://evil.example/device' }),
      }),
    })
    await startAdd(container)

    expect(container.querySelector('[data-auth-url]')).toBeNull()
    expect(container.querySelector('a[href]')).toBeNull()
    expect(container.textContent).not.toContain('evil.example')
  })

  it('卸载后停止本实例轮询并忽略迟到 status 回包', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const late = deferred<RpcResult<ReturnType<typeof authStatus>>>()
    let statusCalls = 0
    const { container, unmount } = await renderAccount('buddy', {
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.status': () => {
        statusCalls += 1
        return late.promise
      },
    })
    await startAdd(container)
    await advance(1000)
    expect(statusCalls).toBe(1)

    unmount()
    late.resolve({ ok: true, value: authStatus('buddy') })
    await flush()
    await advance(5000)
    expect(statusCalls).toBe(1)
  })

  it('授权在飞时卸载会通知上层 busy 结束，并停止轮询', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let statusCalls = 0
    const t = translator('zh')
    const rpc = createConnectionDouble(routeAccounts({
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.status': () => {
        statusCalls += 1
        return { ok: true, value: authStatus('buddy') }
      },
    }))
    const onAuthBusyChange = vi.fn()
    const root = mount(createElement(AccountChannelConfig, {
      channel: 'buddy',
      connection: rpc.connection,
      t,
      writable: true,
      pollIntervalMs: 1000,
      onAuthBusyChange,
    }))
    mounted.push(root)
    await flush()
    await startAdd(root.container)
    expect(onAuthBusyChange).toHaveBeenLastCalledWith(true)

    root.unmount()
    expect(onAuthBusyChange).toHaveBeenLastCalledWith(false)
    await advance(5000)
    expect(statusCalls).toBe(0)
  })

  it('非法/错渠道 authUrl 不进入 DOM 或剪贴板，并显示无效授权响应', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const invalidUrls = [
      'https://qoder.com/device/selectAccounts?machine_id=m',
      'https://evil.example/auth',
      'https://user:pass@www.codebuddy.cn/login',
      'https://www.codebuddy.cn:8443/login',
      'https://www.codebuddy.cn/login#fragment',
      'https://www.codebuddy.cn/login\ninjected',
      'https://',
      `https://www.codebuddy.cn/login?state=${'a'.repeat(2049)}`,
    ]

    for (const authUrl of invalidUrls) {
      const { container } = await renderAccount('buddy', {
        'auth.start': () => ({
          ok: true,
          value: authStatus('buddy', { authUrl }),
        }),
      })
      await startAdd(container)

      const auth = query<HTMLElement>(container, '[data-inline-auth]')
      expect(auth.getAttribute('data-auth-phase'), authUrl).toBe('failed')
      expect(container.querySelector('[data-auth-url]'), authUrl).toBeNull()
      expect(container.querySelector('[data-action="copy-auth"]'), authUrl).toBeNull()
      expect(container.innerHTML, authUrl).not.toContain(authUrl)
      expect(auth.textContent, authUrl).toContain('授权服务返回了无效响应')
      expect(writeText).not.toHaveBeenCalled()
    }
  })

  it('正常渠道切换取消旧 pending flow，并停止旧轮询', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let statusCalls = 0
    const { container, form, calls } = await renderCard(
      makeSnapshot({ enabled: true, channel: 'buddy' }),
      {
        'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
        'auth.status': () => {
          statusCalls += 1
          return { ok: true, value: authStatus('buddy') }
        },
        'auth.cancel': () => ({
          ok: true,
          value: authStatus('buddy', { status: 'cancelled', authUrl: null }),
        }),
      },
    )
    await startAdd(container)
    expect(container.querySelector('[data-auth-url]')).not.toBeNull()

    await act(async () => {
      form.push({ value: makeSnapshot({ enabled: true, channel: 'workbuddy' }) })
    })
    await flush()

    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel'))
      .toBe('workbuddy')
    expect(calls.find(call => call.method === 'auth.cancel')).toEqual({
      method: 'auth.cancel',
      payload: { channel: 'buddy', flowId: 'flow-1' },
    })
    expect(container.querySelector('[data-auth-url]')).toBeNull()
    await advance(5000)
    expect(statusCalls).toBe(0)
  })

  it('正常渠道切换卸载旧账号实例：迟到 auth.start 不再显示旧链接，也不启动旧轮询', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const start = deferred<RpcResult<ReturnType<typeof authStatus>>>()
    let statusCalls = 0
    const { container, form, calls } = await renderCard(
      makeSnapshot({ enabled: true, channel: 'buddy' }),
      {
        'auth.start': () => start.promise,
        'auth.status': () => {
          statusCalls += 1
          return { ok: true, value: authStatus('buddy') }
        },
        'auth.cancel': () => ({
          ok: true,
          value: authStatus('buddy', { status: 'cancelled', authUrl: null }),
        }),
      },
    )
    await click(query(container, '[data-account-config-slot] [data-action="add-account"]'))
    expect(query(container, '[data-inline-auth]').getAttribute('data-auth-phase')).toBe('starting')

    await act(async () => {
      form.push({ value: makeSnapshot({ enabled: true, channel: 'workbuddy' }) })
    })
    await flush()
    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel'))
      .toBe('workbuddy')
    expect(container.querySelector('[data-inline-auth]')).toBeNull()

    start.resolve({ ok: true, value: authStatus('buddy') })
    await flush()
    await advance(5000)

    expect(container.querySelector('[data-inline-auth]')).toBeNull()
    expect(container.textContent).not.toContain(AUTH_URLS.buddy)
    expect(statusCalls).toBe(0)
    expect(calls.find(call => call.method === 'auth.cancel')).toEqual({
      method: 'auth.cancel',
      payload: { channel: 'buddy', flowId: 'flow-1' },
    })
    expect(query<HTMLButtonElement>(container, '[data-search-section] [data-dropdown-trigger]').disabled)
      .toBe(false)
  })
})