// @vitest-environment jsdom
/**
 * Task 13 搜索设置区：同一 search.channel 真源、OFF 灰化保值、ON 无账号状态、
 * 保存失败保持旧值、busy 锁、自有 Switch/Dropdown 的 portal/键盘/焦点。
 *
 * 这里挂载真实 `SettingsCard`，只把 Host 边界（configForms 与 Connection RPC）
 * 换成可控替身；断言全部读取真实 React DOM。
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SettingsCard } from '../../src/client/SettingsCard.tsx'
import type { AccountCollection, AccountSummary } from '../../src/shared/accounts.ts'
import { CHANNEL_IDS } from '../../src/shared/channels.ts'
import type { SearchSettingsSnapshot } from '../../src/shared/contracts.ts'
import type { RpcResult } from '../../src/shared/rpc.ts'
import {
  accountSummary,
  routeAccounts,
  type AccountHandlers,
} from './support/accounts-harness.ts'
import {
  buttonByText,
  click,
  createConfigFormsDouble,
  createConnectionDouble,
  deferred,
  flush,
  keydown,
  makeSnapshot,
  mount,
  pointerdown,
  query,
  translator,
  type MountedRoot,
  type RpcResponder,
  type TestLocale,
} from './support/settings-harness.ts'

const PACKAGE_NAME = 'dsh-web-search-channels'
const failure = {
  ok: false as const,
  error: { code: 'settings/internal', message: 'settings operation failed', details: {} },
}
const mounted: MountedRoot[] = []

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

interface RenderOptions {
  readonly snapshot?: SearchSettingsSnapshot
  readonly locale?: TestLocale
  readonly responder?: RpcResponder
  readonly accounts?: AccountHandlers
  readonly writable?: boolean
  readonly status?: 'loading' | 'ready' | 'unavailable'
}

/**
 * 挂载真实设置卡。
 *
 * Task 14 的账号控制器在挂载后读取当前渠道账号；这里把账号 RPC 路由到空列表，
 * 并让调用记录只保留 settings.update，避免旧回归把账号读取误算成工作区写入。
 *
 * @param options - 初始快照、locale、RPC 响应与可写性。
 * @returns 卡片容器与 Host 替身。
 */
async function renderCard(options: RenderOptions = {}) {
  const snapshot = options.snapshot ?? makeSnapshot()
  const locale = options.locale ?? 'zh'
  const t = translator(locale)
  const forms = createConfigFormsDouble(snapshot, { writable: options.writable, status: options.status })
  const accounts = routeAccounts(options.accounts ?? {})
  const settingsResponder = options.responder ?? (() => ({ ok: true, value: snapshot }))
  const routed: RpcResponder = call => (
    call.method.startsWith('accounts.') || call.method.startsWith('auth.')
      ? accounts(call)
      : settingsResponder(call)
  )
  const rpc = createConnectionDouble(routed, {
    ignoredMethods: ['accounts.list', 'accounts.current', 'auth.start', 'auth.status', 'auth.cancel'],
  })
  const root = mount(createElement(SettingsCard, {
    view: 'page',
    t,
    configForms: forms.configForms,
    connection: rpc.connection,
  }))
  mounted.push(root)
  await flush()
  return { ...forms, ...rpc, t, locale, snapshot, ...root }
}

/** 等一次可控 RPC 的 Promise 链与 React 提交。 */
async function settle(): Promise<void> {
  await flush()
}

describe('SearchSection（真实 DOM）', () => {
  it('加载后只有一个 search.channel 真源：下拉、当前配置区和状态一致', async () => {
    const { container, t, getCalls, snapshot } = await renderCard({
      snapshot: makeSnapshot({ enabled: false, channel: 'buddy' }),
    })

    const stack = query<HTMLElement>(container, '[data-dsh-web-search-channels="settings-card"]')
    expect(stack.className).toContain('stack')
    expect(query(container, '[data-search-section]')).toBeTruthy()
    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel')).toBe('buddy')
    expect(container.querySelectorAll('[data-channel-config-host]')).toHaveLength(1)
    expect(container.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(1)

    const search = query<HTMLElement>(container, '[data-search-section]')
    expect(search.firstElementChild?.tagName).toBe('H3')
    expect(search.querySelector('h3')?.textContent).toBe(t('settings.title'))
    expect(container.textContent).toContain('网页搜索渠道')

    const toggle = query<HTMLButtonElement>(container, '[role="switch"]')
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle.type).toBe('button')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe(t('search.enabled.label'))
    expect(toggle.textContent).toBe('')
    expect(toggle.querySelector('span')).toBeTruthy()
    expect(toggle.tabIndex).toBe(0)
    toggle.focus()
    expect(document.activeElement).toBe(toggle)

    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    expect(trigger.disabled).toBe(true)
    expect(trigger.textContent).toContain(t('channel.buddy.name'))
    const channelRow = query<HTMLElement>(container, '[data-row="channel"]')
    expect(channelRow.getAttribute('data-gated')).toBe('true')

    const config = query<HTMLElement>(container, '[data-channel-config-host]')
    expect(config.getAttribute('data-channel')).toBe(snapshot.search.channel)
    expect(config.hasAttribute('aria-disabled')).toBe(false)
    expect(config.hasAttribute('inert')).toBe(false)
    expect(query(config, '[data-account-config-slot]')).toBeTruthy()
    expect(query(config, '[data-account-state]').getAttribute('data-account-state')).toBe('required')
    expect(config.textContent).toContain('需要账号')
    expect(config.querySelector('[data-qoder-endpoint-slot]')).toBeNull()

    expect(getCalls).toEqual([PACKAGE_NAME])
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('OFF 时渠道 lockedHint 替换原说明，不追加第三行', async () => {
    const { container, t } = await renderCard({
      snapshot: makeSnapshot({ enabled: false, channel: 'buddy' }),
    })

    const row = query<HTMLElement>(container, '[data-row="channel"]')
    const descriptions = [...row.querySelectorAll<HTMLElement>('[class*="rowDescription"]')]
    expect(descriptions.map(node => node.textContent)).toEqual([t('search.channel.lockedHint')])
    expect(row.textContent).not.toContain(t('search.channel.description'))
    expect(query<HTMLElement>(row, '[class*="rowTitle"]').textContent)
      .toBe(t('search.channel.label'))
    const trigger = query<HTMLButtonElement>(row, '[data-dropdown-trigger]')
    expect(trigger.disabled).toBe(true)
    expect(trigger.closest('[data-row="channel"]')?.getAttribute('data-gated')).toBe('true')
  })

  it('OFF 时下方渠道配置整体灰化，仅清除全部账号数据保留可用', async () => {
    const current = accountSummary('qoder', 'qoder-current', {
      displayName: 'Qoder Current', maskedIdentifier: 'q***@example.com', status: 'ready',
    })
    const alternative = accountSummary('qoder', 'qoder-alt', {
      displayName: 'Qoder Alternative', maskedIdentifier: 'q***2@example.com',
    })
    const { container } = await renderCard({
      snapshot: makeSnapshot({ enabled: false, channel: 'qoder' }),
      accounts: {
        'accounts.list': () => ({ ok: true, value: [current, alternative] }),
        'accounts.current': () => ({ ok: true, value: current }),
      },
    })

    const host = query<HTMLElement>(container, '[data-channel-config-host]')
    expect(host.getAttribute('data-off-gated')).toBe('true')
    expect(host.className).toContain('channelGated')

    const endpoint = query<HTMLElement>(host, '[data-qoder-endpoint-slot]')
    expect(query<HTMLButtonElement>(endpoint, '[data-dropdown-trigger]').disabled).toBe(true)
    expect(query<HTMLElement>(endpoint, '[data-qoder-endpoint-row]')
      .getAttribute('data-off-gated')).toBe('true')

    const accountsField = query<HTMLElement>(host, '[data-field="accounts"]')
    expect(accountsField.getAttribute('data-off-gated')).toBe('true')
    expect(accountsField.className).toContain('fieldGated')
    expect(accountsField.textContent).toContain('Qoder Current')
    expect(accountsField.textContent).toContain('Qoder Alternative')
    expect(query<HTMLButtonElement>(accountsField, '[data-action="add-account"]').disabled)
      .toBe(true)
    expect(query<HTMLButtonElement>(accountsField, '[data-action="set-current"]').disabled)
      .toBe(true)
    expect(query<HTMLButtonElement>(accountsField, '[data-action="reauth-account"]').disabled)
      .toBe(true)
    expect(query<HTMLButtonElement>(accountsField, '[data-action="delete"]').disabled)
      .toBe(true)

    const clearField = query<HTMLElement>(host, '[data-field="clear-accounts"]')
    expect(clearField.getAttribute('data-off-gated')).toBeNull()
    expect(clearField.className).not.toContain('fieldGated')
    expect(query<HTMLButtonElement>(clearField, '[data-action="clear-all"]').disabled)
      .toBe(false)
  })

  it.each(CHANNEL_IDS)('OFF 时 %s 配置区整体灰化且 clear-all 可用', async (channel) => {
    const { container } = await renderCard({
      snapshot: makeSnapshot({ enabled: false, channel }),
    })
    const host = query<HTMLElement>(container, '[data-channel-config-host]')
    expect(host.getAttribute('data-off-gated')).toBe('true')
    expect(query<HTMLButtonElement>(host, '[data-action="add-account"]').disabled).toBe(true)
    expect(query<HTMLButtonElement>(host, '[data-action="clear-all"]').disabled).toBe(false)

    if (channel === 'qoder') {
      const endpoint = query<HTMLElement>(host, '[data-qoder-endpoint-slot]')
      expect(query<HTMLButtonElement>(endpoint, '[data-dropdown-trigger]').disabled).toBe(true)
      expect(query<HTMLElement>(endpoint, '[data-qoder-endpoint-row]')
        .getAttribute('data-off-gated')).toBe('true')
    } else {
      const endpoint = query<HTMLElement>(host, '[data-fixed-endpoint-slot]')
      expect(query<HTMLElement>(endpoint, '[data-field="endpoint"]')
        .getAttribute('data-off-gated')).toBe('true')
      expect(endpoint.querySelector('button')).toBeNull()
      expect(query<HTMLElement>(endpoint, '[data-fixed-endpoint]').textContent).not.toBe('')
    }
  })

  it('OFF 时清除全部账号数据仍可就地确认并写入', async () => {
    const account = accountSummary('buddy', 'account-a')
    let cleared = false
    const { container, calls } = await renderCard({
      snapshot: makeSnapshot({ enabled: false, channel: 'buddy' }),
      accounts: {
        'accounts.list': () => ({ ok: true, value: cleared ? [] : [account] }),
        'accounts.current': () => ({ ok: true, value: cleared ? null : account }),
        'accounts.clearAll': () => {
          cleared = true
          return { ok: true, value: { cleared: 1 } }
        },
      },
    })

    const clearAll = query<HTMLButtonElement>(container, '[data-action="clear-all"]')
    expect(clearAll.disabled).toBe(false)
    await click(clearAll)
    const confirmation = query<HTMLElement>(container, '[data-clear-confirmation]')
    expect(query<HTMLButtonElement>(confirmation, '[data-action="confirm-clear-all"]').disabled)
      .toBe(false)
    await click(query(confirmation, '[data-action="confirm-clear-all"]'))
    await flush()

    expect(calls.find(call => call.method === 'accounts.clearAll')).toEqual({
      method: 'accounts.clearAll',
      payload: {},
    })
    expect(container.textContent).toContain('已清除全部账号数据')
  })

  it('OFF→ON 恢复渠道说明与配置区操作', async () => {
    const before = makeSnapshot({ enabled: false, channel: 'buddy' })
    const after = makeSnapshot({ enabled: true, channel: 'buddy' })
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container, t } = await renderCard({
      snapshot: before,
      responder: () => response.promise,
    })

    const gatedHost = query<HTMLElement>(container, '[data-channel-config-host]')
    expect(gatedHost.getAttribute('data-off-gated')).toBe('true')
    expect(query<HTMLButtonElement>(gatedHost, '[data-action="add-account"]').disabled).toBe(true)
    expect(query<HTMLElement>(container, '[data-row="channel"]').textContent)
      .toContain(t('search.channel.lockedHint'))

    await click(query(container, '[role="switch"]'))
    response.resolve({ ok: true, value: after })
    await settle()

    const restored = query<HTMLElement>(container, '[data-channel-config-host]')
    expect(restored.getAttribute('data-off-gated')).toBeNull()
    expect(restored.className).not.toContain('channelGated')
    expect(query<HTMLButtonElement>(restored, '[data-action="add-account"]').disabled).toBe(false)
    const row = query<HTMLElement>(container, '[data-row="channel"]')
    expect(row.textContent).toContain(t('search.channel.description'))
    expect(row.textContent).not.toContain(t('search.channel.lockedHint'))
  })

  it('OFF 时账号错误仍以红色错误呈现，不被灰化规则吞掉', async () => {
    const { container } = await renderCard({
      snapshot: makeSnapshot({ enabled: false, channel: 'buddy' }),
      accounts: { 'accounts.list': () => failure },
    })

    expect(query<HTMLElement>(container, '[data-channel-config-host]')
      .getAttribute('data-off-gated')).toBe('true')
    const alert = query<HTMLElement>(container, '[data-account-error]')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.className).toContain('error')
    expect(alert.textContent).toContain('读取账号失败')
  })

  it('ON 但该渠道无账号时明确显示需要账号，不伪造 ready', async () => {
    const { container, t } = await renderCard({
      snapshot: makeSnapshot({ enabled: true, channel: 'workbuddy' }),
    })

    const toggle = query<HTMLButtonElement>(container, '[role="switch"]')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    expect(trigger.disabled).toBe(false)
    expect(trigger.textContent).toContain(t('channel.workbuddy.name'))

    const config = query<HTMLElement>(container, '[data-channel-config-host]')
    expect(config.getAttribute('data-channel')).toBe('workbuddy')
    expect(query(config, '[data-account-state]').getAttribute('data-account-state')).toBe('required')
    expect(config.textContent).toContain('需要账号')
    expect(config.textContent).not.toMatch(/就绪|已连接|ready/i)
    expect(query<HTMLButtonElement>(config, '[data-action="add-account"]').textContent)
      .toContain(t('channel.accounts.add'))
    expect(config.querySelector('[data-qoder-endpoint-slot]')).toBeNull()
    expect(container.querySelectorAll('[data-channel-config-host]')).toHaveLength(1)
  })

  it('I6 ready 正例由当前账号真源驱动，含渠道、账号与脱敏状态', async () => {
    const current = accountSummary('workbuddy', 'ready-account', {
      displayName: 'Ready User', maskedIdentifier: 'r***@example.com', status: 'ready',
    })
    const { container, t } = await renderCard({
      snapshot: makeSnapshot({ enabled: true, channel: 'workbuddy' }),
      accounts: {
        'accounts.list': () => ({ ok: true, value: [current] }),
        'accounts.current': () => ({ ok: true, value: current }),
      },
    })
    const status = query<HTMLElement>(container, '[data-search-status]')
    expect(status.getAttribute('data-search-status')).toBe('ready')
    expect(status.textContent).toContain('已开启 · 已就绪')
    expect(status.textContent).toContain(t('channel.workbuddy.name'))
    expect(status.textContent).toContain('Ready User')
    expect(status.textContent).toContain('r***@example.com')
    expect(status.textContent).toContain('正常')
  })

  it('I6 OFF 明确交还官方搜索；loading 不假装无账号', async () => {
    const off = await renderCard({ snapshot: makeSnapshot({ enabled: false, channel: 'buddy' }) })
    expect(query<HTMLElement>(off.container, '[data-search-status]').getAttribute('data-search-status'))
      .toBe('off')
    expect(query<HTMLElement>(off.container, '[data-search-status]').textContent).toContain('官方')

    const pending = deferred<RpcResult<readonly unknown[]>>()
    const loading = await renderCard({
      snapshot: makeSnapshot({ enabled: true, channel: 'buddy' }),
      accounts: { 'accounts.list': () => pending.promise },
    })
    const status = query<HTMLElement>(loading.container, '[data-search-status]')
    expect(status.getAttribute('data-search-status')).toBe('loading')
    expect(status.textContent).toContain('读取中')
    expect(status.textContent).not.toContain('未选择当前账号')
    pending.resolve({ ok: true, value: [] })
    await flush()
  })

  it.each([
    { status: 'reauth_required' as const, expected: 'reauth_required', text: '需要重新登录' },
    { status: 'temporarily_unavailable' as const, expected: 'temporarily_unavailable', text: '暂时不可用' },
    { status: 'credential_unavailable' as const, expected: 'credential_error', text: '配置或凭据读取失败' },
  ])('I6 当前账号 $status 映射到 $expected', async ({ status, expected, text }) => {
    const current = accountSummary('buddy', 'account-status', { status })
    const { container } = await renderCard({
      snapshot: makeSnapshot({ enabled: true, channel: 'buddy' }),
      accounts: {
        'accounts.list': () => ({ ok: true, value: [current] }),
        'accounts.current': () => ({ ok: true, value: current }),
      },
    })
    const view = query<HTMLElement>(container, '[data-search-status]')
    expect(view.getAttribute('data-search-status')).toBe(expected)
    expect(view.textContent).toContain(text)
  })

  it('I6 有账号但未选择与读取失败分别映射 no-current 与 credential/config error', async () => {
    const account = accountSummary('buddy', 'alternative')
    const noCurrent = await renderCard({
      snapshot: makeSnapshot({ enabled: true, channel: 'buddy' }),
      accounts: {
        'accounts.list': () => ({ ok: true, value: [account] }),
        'accounts.current': () => ({ ok: true, value: null }),
      },
    })
    expect(query<HTMLElement>(noCurrent.container, '[data-search-status]')
      .getAttribute('data-search-status')).toBe('no-current')

    const failed = await renderCard({
      snapshot: makeSnapshot({ enabled: true, channel: 'buddy' }),
      accounts: { 'accounts.list': () => failure },
    })
    const view = query<HTMLElement>(failed.container, '[data-search-status]')
    expect(view.getAttribute('data-search-status')).toBe('credential_error')
    expect(view.textContent).toContain('配置或凭据读取失败')
  })

  it('I6 渠道切换原子性：新渠道为空时不继承旧渠道 ready', async () => {
    const buddy = accountSummary('buddy', 'buddy-ready')
    const before = makeSnapshot({ enabled: true, channel: 'buddy' })
    const after = makeSnapshot({ enabled: true, channel: 'qoder' })
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container, t } = await renderCard({
      snapshot: before,
      responder: () => response.promise,
      accounts: {
        'accounts.list': call => ({
          ok: true,
          value: (call.payload as { channel?: string }).channel === 'buddy' ? [buddy] : [],
        }),
        'accounts.current': call => ({
          ok: true,
          value: (call.payload as { channel?: string }).channel === 'buddy' ? buddy : null,
        }),
      },
    })
    expect(query<HTMLElement>(container, '[data-search-status]').getAttribute('data-search-status'))
      .toBe('ready')
    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    await click(trigger)
    await click(buttonByText(query(document, '[data-dropdown-menu]'), t('channel.qoder.name')))
    response.resolve({ ok: true, value: after })
    await settle()
    const status = query<HTMLElement>(container, '[data-search-status]')
    expect(status.getAttribute('data-search-status')).not.toBe('ready')
    expect(status.getAttribute('data-search-status')).toBe('no-account')
    expect(status.textContent).not.toContain('buddy-ready')
  })

  it('busy 锁：写入在飞时禁用开关与下拉，重复点击不产生第二个 RPC', async () => {
    const before = makeSnapshot({ enabled: false, channel: 'buddy' })
    const after = makeSnapshot({ enabled: true, channel: 'buddy' })
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container, calls } = await renderCard({ snapshot: before, responder: () => response.promise })

    const toggle = query<HTMLButtonElement>(container, '[role="switch"]')
    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    await click(toggle)

    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.disabled).toBe(true)
    expect(trigger.disabled).toBe(true)
    expect(trigger.textContent).toContain('CodeBuddy')
    expect(query(container, '[data-row="channel"]').getAttribute('data-gated')).toBe('true')
    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel')).toBe('buddy')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ method: 'settings.update', payload: { patch: { enabled: true } } })

    await click(toggle)
    expect(calls).toHaveLength(1)

    response.resolve({ ok: true, value: after })
    await settle()

    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle.disabled).toBe(false)
    expect(trigger.disabled).toBe(false)
    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel')).toBe('buddy')
  })

  it('I7 删除确认锁定主下拉并显示先完成或取消当前操作', async () => {
    const account = accountSummary('buddy', 'account-a')
    const { container } = await renderCard({
      snapshot: makeSnapshot({ enabled: true, channel: 'buddy' }),
      accounts: {
        'accounts.list': () => ({ ok: true, value: [account] }),
        'accounts.current': () => ({ ok: true, value: account }),
      },
    })
    await click(query(container, '[data-action="delete"]'))
    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    expect(trigger.disabled).toBe(true)
    expect(query<HTMLElement>(container, '[data-interaction-busy-hint]').textContent)
      .toContain('先完成或取消当前操作')
    await click(trigger)
    expect(document.querySelector('[data-dropdown-menu]')).toBeNull()
  })

  it('I7 已接受删除排队时锁定主下拉，不能切走并丢弃队列', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const setCurrentResponse = deferred<RpcResult<AccountSummary | null>>()
    const { container } = await renderCard({
      snapshot: makeSnapshot({ enabled: true, channel: 'buddy' }),
      accounts: {
        'accounts.list': () => ({ ok: true, value: [a, b] }),
        'accounts.current': () => ({ ok: true, value: a }),
        'accounts.setCurrent': () => setCurrentResponse.promise,
      },
    })
    await click(query(container, '[data-action="set-current"][data-account-id="account-b"]'))
    await click(query(container, '[data-action="delete"][data-account-id="account-a"]'))
    await click(query(container, '[data-delete-confirmation] [data-action="confirm-delete"]'))
    expect(container.textContent).toContain('排队中')
    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    expect(trigger.disabled).toBe(true)
    expect(query<HTMLElement>(container, '[data-interaction-busy-hint]').textContent)
      .toContain('先完成或取消当前操作')
    setCurrentResponse.resolve({ ok: true, value: b })
    await flush()
  })

  it('I7 删除执行中锁定主下拉，settle 后才恢复', async () => {
    const account = accountSummary('buddy', 'account-a')
    const deletion = deferred<RpcResult<AccountCollection>>()
    const { container } = await renderCard({
      snapshot: makeSnapshot({ enabled: true, channel: 'buddy' }),
      accounts: {
        'accounts.list': () => ({ ok: true, value: [account] }),
        'accounts.current': () => ({ ok: true, value: account }),
        'accounts.delete': () => deletion.promise,
      },
    })
    await click(query(container, '[data-action="delete"]'))
    await click(query(container, '[data-delete-confirmation] [data-action="confirm-delete"]'))
    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    expect(trigger.disabled).toBe(true)
    expect(query<HTMLElement>(container, '[data-interaction-busy-hint]').textContent)
      .toContain('先完成或取消当前操作')
    deletion.resolve({ ok: true, value: { accounts: [], current: null } })
    await flush()
    expect(trigger.disabled).toBe(false)
  })

  it('I7 授权完成后的账号刷新也汇入统一 interaction busy', async () => {
    const account = accountSummary('buddy', 'account-a')
    const secondList = deferred<RpcResult<readonly AccountSummary[]>>()
    let listCalls = 0
    const { container } = await renderCard({
      snapshot: makeSnapshot({ enabled: true, channel: 'buddy' }),
      accounts: {
        'accounts.list': () => {
          listCalls += 1
          return listCalls === 1 ? { ok: true, value: [account] } : secondList.promise
        },
        'accounts.current': () => ({ ok: true, value: account }),
        'auth.start': () => ({
          ok: true,
          value: {
            flowId: 'flow-refresh', channel: 'buddy', status: 'completed', authUrl: null,
            displayHint: '', account, errorCode: null,
          },
        }),
      },
    })
    await click(query(container, '[data-action="add-account"]'))
    await flush()
    expect(query<HTMLButtonElement>(container, '[data-dropdown-trigger]').disabled).toBe(true)
    expect(query<HTMLElement>(container, '[data-interaction-busy-hint]').textContent)
      .toContain('先完成或取消当前操作')
    secondList.resolve({ ok: true, value: [account] })
    await flush()
    expect(query<HTMLButtonElement>(container, '[data-dropdown-trigger]').disabled).toBe(false)
  })

  it('开关保存失败时保持旧值并显示未被灰化选择器覆盖的错误红字', async () => {
    const before = makeSnapshot({ enabled: false, channel: 'buddy' })
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container } = await renderCard({ snapshot: before, responder: () => response.promise })

    const toggle = query<HTMLButtonElement>(container, '[role="switch"]')
    await click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    response.resolve(failure)
    await settle()

    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.disabled).toBe(false)
    expect(query<HTMLButtonElement>(container, '[data-dropdown-trigger]').disabled).toBe(true)
    expect(query(container, '[data-row="channel"]').getAttribute('data-gated')).toBe('true')
    const alert = query<HTMLElement>(container, '[role="alert"]')
    expect(alert.textContent).toContain('保存失败')
    expect(alert.className).toContain('error')
    expect(alert.closest('[data-row="channel"]')).not.toBeNull()
    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel')).toBe('buddy')
  })

  it('渠道选择成功后才切换配置区；门户菜单含四个渠道且选择后焦点回 trigger', async () => {
    const before = makeSnapshot({ enabled: true, channel: 'buddy' })
    const after = makeSnapshot({ enabled: true, channel: 'qoder' })
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container, calls, t } = await renderCard({ snapshot: before, responder: () => response.promise })

    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    await click(trigger)

    const menu = query<HTMLElement>(document, '[data-dropdown-menu]')
    expect(container.contains(menu)).toBe(false)
    expect(document.body.contains(menu)).toBe(true)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect([...menu.querySelectorAll('[role="menuitem"]')].map(item => item.getAttribute('aria-label'))).toEqual([
      t('channel.buddy.name'),
      t('channel.workbuddy.name'),
      t('channel.qoder.name'),
      t('channel.qodercn.name'),
    ])
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem')

    await click(buttonByText(menu, t('channel.qoder.name')))
    expect(document.querySelector('[data-dropdown-menu]')).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ method: 'settings.update', payload: { patch: { channel: 'qoder' } } })
    expect(trigger.textContent).toContain(t('channel.buddy.name'))
    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel')).toBe('buddy')
    expect(trigger.disabled).toBe(true)

    response.resolve({ ok: true, value: after })
    await settle()

    expect(trigger.textContent).toContain(t('channel.qoder.name'))
    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel')).toBe('qoder')
    expect(container.querySelectorAll('[data-channel-config-host]')).toHaveLength(1)
    expect(query(container, '[data-channel-config-host]').querySelector('[data-qoder-endpoint-slot]')).toBeTruthy()
    expect(container.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(2)
    expect(query(container, '[data-search-section]').querySelectorAll('[aria-haspopup="menu"]'))
      .toHaveLength(1)
    expect(query(container, '[data-qoder-endpoint-slot]').querySelectorAll('[aria-haspopup="menu"]'))
      .toHaveLength(1)
    expect(trigger.disabled).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('渠道保存失败时保持旧值并保持旧配置区', async () => {
    const before = makeSnapshot({ enabled: true, channel: 'buddy' })
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container, t } = await renderCard({ snapshot: before, responder: () => response.promise })

    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    await click(trigger)
    const menu = query<HTMLElement>(document, '[data-dropdown-menu]')
    await click(buttonByText(menu, t('channel.workbuddy.name')))

    expect(trigger.textContent).toContain(t('channel.buddy.name'))
    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel')).toBe('buddy')

    response.resolve(failure)
    await settle()

    expect(trigger.textContent).toContain(t('channel.buddy.name'))
    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel')).toBe('buddy')
    expect(query(container, '[role="alert"]').textContent).toContain('保存失败')
  })

  it('Enter/Space/方向键可打开菜单，自动聚焦首项；方向键循环、Home/End 定位', async () => {
    const { container, t } = await renderCard({
      snapshot: makeSnapshot({ enabled: true, channel: 'buddy' }),
    })
    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')

    await keydown(trigger, 'Enter')
    let menu = query<HTMLElement>(document, '[data-dropdown-menu]')
    expect(document.activeElement?.getAttribute('aria-label')).toBe(t('channel.buddy.name'))

    await keydown(document.activeElement as Element, 'ArrowDown')
    expect(document.activeElement?.getAttribute('aria-label')).toBe(t('channel.workbuddy.name'))
    await keydown(document.activeElement as Element, 'ArrowDown')
    expect(document.activeElement?.getAttribute('aria-label')).toBe(t('channel.qoder.name'))
    await keydown(document.activeElement as Element, 'ArrowUp')
    expect(document.activeElement?.getAttribute('aria-label')).toBe(t('channel.workbuddy.name'))
    await keydown(document.activeElement as Element, 'End')
    expect(document.activeElement?.getAttribute('aria-label')).toBe(t('channel.qodercn.name'))
    await keydown(document.activeElement as Element, 'Home')
    expect(document.activeElement?.getAttribute('aria-label')).toBe(t('channel.buddy.name'))

    await keydown(document.activeElement as Element, 'Escape')
    expect(document.querySelector('[data-dropdown-menu]')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    await keydown(trigger, ' ')
    menu = query<HTMLElement>(document, '[data-dropdown-menu]')
    expect(document.activeElement?.getAttribute('aria-label')).toBe(t('channel.buddy.name'))

    await keydown(document.activeElement as Element, 'Tab', { shiftKey: true })
    expect(document.querySelector('[data-dropdown-menu]')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    await keydown(trigger, 'ArrowUp')
    menu = query<HTMLElement>(document, '[data-dropdown-menu]')
    expect(document.activeElement?.getAttribute('aria-label')).toBe(t('channel.qodercn.name'))

    await pointerdown(document.body)
    expect(document.querySelector('[data-dropdown-menu]')).toBeNull()
  })

  it('普通 Tab 在菜单项上复用选择路径，并保持 pending 旧值与相同 RPC', async () => {
    const before = makeSnapshot({ enabled: true, channel: 'buddy' })
    const after = makeSnapshot({ enabled: true, channel: 'workbuddy' })
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container, calls, t } = await renderCard({ snapshot: before, responder: () => response.promise })

    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    await keydown(trigger, 'Enter')
    await keydown(document.activeElement as Element, 'ArrowDown')
    expect(document.activeElement?.getAttribute('aria-label')).toBe(t('channel.workbuddy.name'))

    const tab = await keydown(document.activeElement as Element, 'Tab')
    expect(tab.defaultPrevented).toBe(true)
    expect(document.querySelector('[data-dropdown-menu]')).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ method: 'settings.update', payload: { patch: { channel: 'workbuddy' } } })

    expect(trigger.textContent).toContain(t('channel.buddy.name'))
    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel')).toBe('buddy')
    expect(query(container, '[role="switch"]').getAttribute('aria-checked')).toBe('true')
    expect(trigger.disabled).toBe(true)

    response.resolve({ ok: true, value: after })
    await settle()

    expect(trigger.textContent).toContain(t('channel.workbuddy.name'))
    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel')).toBe('workbuddy')
    expect(trigger.disabled).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('rc5 普通 Tab 从 trigger 进入首个 enabled row，不直接提交选择', async () => {
    const { container, calls } = await renderCard({
      snapshot: makeSnapshot({ enabled: true, channel: 'buddy' }),
    })
    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    await keydown(trigger, 'Enter')
    expect(document.querySelector('[data-dropdown-menu]')).not.toBeNull()

    trigger.focus()
    const tab = await keydown(trigger, 'Tab')
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('CodeBuddy')
    expect(calls).toHaveLength(0)
    expect(document.querySelector('[data-dropdown-menu]')).not.toBeNull()
  })

  it('菜单打开时卸载会清理 document 监听器', async () => {
    const { container, unmount } = await renderCard({
      snapshot: makeSnapshot({ enabled: true, channel: 'buddy' }),
    })
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    try {
      const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
      await keydown(trigger, 'Enter')
      expect(document.querySelector('[data-dropdown-menu]')).not.toBeNull()

      const addedKeydown = addSpy.mock.calls.find(([type]) => type === 'keydown')?.[1]
      const addedPointerdown = addSpy.mock.calls.find(([type]) => type === 'pointerdown')?.[1]
      expect(addedKeydown).toBeDefined()
      expect(addedPointerdown).toBeDefined()

      unmount()
      expect(document.querySelector('[data-dropdown-menu]')).toBeNull()
      expect(removeSpy.mock.calls.some(([type, listener]) => (
        type === 'keydown' && listener === addedKeydown
      ))).toBe(true)
      expect(removeSpy.mock.calls.some(([type, listener]) => (
        type === 'pointerdown' && listener === addedPointerdown
      ))).toBe(true)
      expect(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      }).not.toThrow()
    } finally {
      addSpy.mockRestore()
      removeSpy.mockRestore()
    }
  })

  it('门户使用 CSS anchor 与 minWidthFromAnchor，不写死 getBoundingClientRect 坐标', async () => {
    const { container } = await renderCard({ snapshot: makeSnapshot({ enabled: true, channel: 'buddy' }) })
    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    await click(trigger)
    const root = query<HTMLElement>(container, '[data-menu-root]')
    const menu = query<HTMLElement>(document, '[data-dropdown-menu]')
    expect(menu.style.getPropertyValue('position-anchor')).toBe(root.style.getPropertyValue('anchor-name'))
    expect(menu.hasAttribute('data-match-anchor-width')).toBe(true)
    expect(menu.style.left).toBe('')
    expect(menu.style.top).toBe('')
    expect(menu.style.minWidth).toBe('')
  })

  it.each([
    { status: 'loading' as const, text: '设置加载中', role: null },
    { status: 'unavailable' as const, text: '设置不可用', role: 'alert' },
  ])('status=$status 也保持 h3→row→rowText 的完整剖面', async ({ status, text, role }) => {
    const { container } = await renderCard({ status })
    const section = query<HTMLElement>(container, `section[data-settings-status="${status}"]`)
    expect(section.firstElementChild?.tagName).toBe('H3')
    const row = query<HTMLElement>(section, `:scope > div[data-settings-status="${status}"]`)
    expect(row.getAttribute('data-settings-status')).toBe(status)
    expect(row.querySelector('[class*="rowText"]')).not.toBeNull()
    const message = row.querySelector(role === null ? 'p[class*="hint"]' : 'p[class*="error"]')
    expect(message?.textContent).toBe(text)
    expect(message?.getAttribute('role')).toBe(role)
    expect(container.querySelector('[data-search-section]')).toBeNull()
    expect(container.querySelector('[data-channel-config-host]')).toBeNull()
  })

  it('英文文案覆盖标题、开关、渠道、账号状态与错误', async () => {
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container, t } = await renderCard({
      locale: 'en',
      snapshot: makeSnapshot({ enabled: false, channel: 'qodercn' }),
      responder: () => response.promise,
    })

    expect(container.textContent).toContain('Web search channels')
    expect(query(container, '[role="switch"]').getAttribute('aria-label')).toBe('Enable web search')
    expect(query<HTMLButtonElement>(container, '[data-dropdown-trigger]').textContent)
      .toContain('Qoder China')
    expect(container.textContent).toContain('Account required')
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/)

    await click(query(container, '[role="switch"]'))
    response.resolve(failure)
    await settle()
    expect(query(container, '[role="alert"]').textContent).toContain('Save failed')
    expect(t('settings.saveFailed')).toContain('Save failed')
  })
})
