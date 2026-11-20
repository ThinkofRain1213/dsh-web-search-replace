// @vitest-environment jsdom
/**
 * Task 13 搜索设置区：同一 search.channel 真源、OFF 灰化保值、ON 无账号状态、
 * 保存失败回滚、busy 锁、自有 Switch/Dropdown 的 portal/键盘/焦点。
 *
 * 这里挂载真实 `SettingsCard`，只把 Host 边界（configForms 与 Connection RPC）
 * 换成可控替身；断言全部读取真实 React DOM。
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { SettingsCard } from '../../src/client/SettingsCard.tsx'
import type { SearchSettingsSnapshot } from '../../src/shared/contracts.ts'
import type { RpcResult } from '../../src/shared/rpc.ts'
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
  readonly writable?: boolean
}

/**
 * 挂载真实设置卡。
 * @param options - 初始快照、locale、RPC 响应与可写性。
 * @returns 卡片容器与 Host 替身。
 */
function renderCard(options: RenderOptions = {}) {
  const snapshot = options.snapshot ?? makeSnapshot()
  const locale = options.locale ?? 'zh'
  const t = translator(locale)
  const forms = createConfigFormsDouble(snapshot, { writable: options.writable })
  const rpc = createConnectionDouble(options.responder ?? (() => ({ ok: true, value: snapshot })))
  const root = mount(createElement(SettingsCard, {
    view: 'page',
    t,
    configForms: forms.configForms,
    connection: rpc.connection,
  }))
  mounted.push(root)
  return { ...forms, ...rpc, t, locale, snapshot, ...root }
}

/** 等一次可控 RPC 的 Promise 链与 React 提交。 */
async function settle(): Promise<void> {
  await flush()
}

describe('SearchSection（真实 DOM）', () => {
  it('加载后只有一个 search.channel 真源：下拉、当前配置区和状态一致', () => {
    const { container, t, getCalls, snapshot } = renderCard({
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

  it('OFF 时渠道下拉灰化但保值，当前配置区仍可管理', () => {
    const { container, t } = renderCard({
      snapshot: makeSnapshot({ enabled: false, channel: 'qoder' }),
    })

    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    expect(trigger.disabled).toBe(true)
    expect(trigger.textContent).toContain(t('channel.qoder.name'))
    expect(trigger.closest('[data-row="channel"]')?.getAttribute('data-gated')).toBe('true')

    const config = query<HTMLElement>(container, '[data-channel-config-host]')
    expect(config.getAttribute('data-channel')).toBe('qoder')
    expect(config.querySelector('[data-qoder-endpoint-slot]')).toBeTruthy()
    expect(config.querySelector('[data-account-config-slot]')).toBeTruthy()
    expect(config.querySelector('[data-account-state]')?.textContent).toContain('需要账号')
  })

  it('ON 但该渠道无账号时明确显示需要账号，不伪造 ready', () => {
    const { container, t } = renderCard({
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
    expect(config.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelectorAll('[data-channel-config-host]')).toHaveLength(1)
  })

  it('busy 锁：写入在飞时禁用开关与下拉，重复点击不产生第二个 RPC', async () => {
    const before = makeSnapshot({ enabled: false, channel: 'buddy' })
    const after = makeSnapshot({ enabled: true, channel: 'buddy' })
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container, calls } = renderCard({ snapshot: before, responder: () => response.promise })

    const toggle = query<HTMLButtonElement>(container, '[role="switch"]')
    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    await click(toggle)

    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle.disabled).toBe(true)
    expect(trigger.disabled).toBe(true)
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

  it('开关保存失败时回滚到旧值并显示未被灰化选择器覆盖的错误红字', async () => {
    const before = makeSnapshot({ enabled: false, channel: 'buddy' })
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container } = renderCard({ snapshot: before, responder: () => response.promise })

    const toggle = query<HTMLButtonElement>(container, '[role="switch"]')
    await click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')

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
    const { container, calls, t } = renderCard({ snapshot: before, responder: () => response.promise })

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
    expect(document.activeElement).toBe(trigger)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ method: 'settings.update', payload: { patch: { channel: 'qoder' } } })
    expect(trigger.textContent).toContain(t('channel.qoder.name'))
    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel')).toBe('buddy')
    expect(trigger.disabled).toBe(true)

    response.resolve({ ok: true, value: after })
    await settle()

    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel')).toBe('qoder')
    expect(container.querySelectorAll('[data-channel-config-host]')).toHaveLength(1)
    expect(query(container, '[data-channel-config-host]').querySelector('[data-qoder-endpoint-slot]')).toBeTruthy()
    expect(container.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(1)
    expect(trigger.disabled).toBe(false)
  })

  it('渠道保存失败时回滚显示值并保持旧配置区', async () => {
    const before = makeSnapshot({ enabled: true, channel: 'buddy' })
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container, t } = renderCard({ snapshot: before, responder: () => response.promise })

    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    await click(trigger)
    const menu = query<HTMLElement>(document, '[data-dropdown-menu]')
    await click(buttonByText(menu, t('channel.workbuddy.name')))

    expect(trigger.textContent).toContain(t('channel.workbuddy.name'))
    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel')).toBe('buddy')

    response.resolve(failure)
    await settle()

    expect(trigger.textContent).toContain(t('channel.buddy.name'))
    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel')).toBe('buddy')
    expect(query(container, '[role="alert"]').textContent).toContain('保存失败')
  })

  it('Enter/Space/方向键可打开菜单，自动聚焦首项；方向键循环、Home/End 定位', async () => {
    const { container, t } = renderCard({
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

  it('门户定位使用锚点几何，minWidthFromAnchor 取锚点宽度', async () => {
    const { container } = renderCard({ snapshot: makeSnapshot({ enabled: true, channel: 'buddy' }) })
    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    const original = HTMLButtonElement.prototype.getBoundingClientRect
    HTMLButtonElement.prototype.getBoundingClientRect = function getRect(): DOMRect {
      return {
        width: 222, height: 34, top: 100, bottom: 134, left: 40, right: 262, x: 40, y: 100,
        toJSON: () => ({}),
      } as DOMRect
    }
    try {
      await click(trigger)
      const menu = query<HTMLElement>(document, '[data-dropdown-menu]')
      expect(menu.style.minWidth).toBe('222px')
      expect(menu.style.left).toBe('40px')
      expect(menu.style.top).toBe('138px')
      expect(menu.hasAttribute('data-min-width-from-anchor')).toBe(true)
    } finally {
      HTMLButtonElement.prototype.getBoundingClientRect = original
    }
  })

  it('英文文案覆盖标题、开关、渠道、账号状态与错误', async () => {
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container, t } = renderCard({
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
