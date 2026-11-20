// @vitest-environment jsdom
/**
 * Task 13 R30 慢保存焦点回归：选择后 trigger 在 pending 期间被原生 disabled，
 * jsdom 的异步 focus fixup 会跨帧把焦点迁到 body；保存结束并重新 enabled 后，
 * Dropdown 必须仅在“本次选择且无用户竞争焦点”时补偿回焦。
 *
 * 本文件单独使用只假 setInterval 的 fake timers，避免 jsdom rendering interval
 * 与其它快速用例互相污染；推进 20ms 即可确定性执行一次 focus fixup，不用真实 sleep。
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  query,
  translator,
  type MountedRoot,
  type RpcResponder,
} from './support/settings-harness.ts'

const mounted: MountedRoot[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount()
  vi.runOnlyPendingTimers()
  vi.clearAllTimers()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

/**
 * 挂载真实设置卡。
 * @param snapshot - 初始快照。
 * @param responder - 可控 RPC。
 * @returns 卡片容器与 Host 替身。
 */
function renderCard(snapshot: SearchSettingsSnapshot, responder: RpcResponder) {
  const forms = createConfigFormsDouble(snapshot)
  const rpc = createConnectionDouble(responder)
  const t = translator('zh')
  const root = mount(createElement(SettingsCard, {
    view: 'page',
    t,
    configForms: forms.configForms,
    connection: rpc.connection,
  }))
  mounted.push(root)
  return { ...forms, ...rpc, t, ...root }
}

/** 等一次可控 RPC 的 Promise 链与 React 提交。 */
async function settle(): Promise<void> {
  await flush()
}

/** 只推进 jsdom 的 1000/60 rendering interval，执行一次 focus fixup。 */
async function advanceFocusFixupFrame(): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(20) })
}

/** 在测试页面上临时放一个可用控件，模拟用户主动把焦点移走。 */
function appendUserControl(): HTMLButtonElement {
  const control = document.createElement('button')
  control.type = 'button'
  control.textContent = 'user focus target'
  document.body.append(control)
  return control
}

describe('Dropdown 慢保存后的最终回焦（R30）', () => {
  it('普通 Tab 跨帧失焦后，保存结束和重新 enabled 后回焦 trigger', async () => {
    const before = makeSnapshot({ enabled: true, channel: 'buddy' })
    const after = makeSnapshot({ enabled: true, channel: 'workbuddy' })
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container, calls, t } = renderCard(before, () => response.promise)

    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    await keydown(trigger, 'Enter')
    await keydown(document.activeElement as Element, 'ArrowDown')
    const tab = await keydown(document.activeElement as Element, 'Tab')

    expect(tab.defaultPrevented).toBe(true)
    expect(document.querySelector('[data-dropdown-menu]')).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ method: 'settings.update', payload: { patch: { channel: 'workbuddy' } } })
    expect(trigger.disabled).toBe(true)
    expect(trigger.textContent).toContain(t('channel.buddy.name'))
    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel')).toBe('buddy')
    expect(query(container, '[role="switch"]').getAttribute('aria-checked')).toBe('true')

    await advanceFocusFixupFrame()
    expect(document.activeElement).toBe(document.body)
    expect(trigger.disabled).toBe(true)

    response.resolve({ ok: true, value: after })
    await settle()

    expect(trigger.disabled).toBe(false)
    expect(document.activeElement).toBe(trigger)
    expect(trigger.textContent).toContain(t('channel.workbuddy.name'))
    expect(query(container, '[data-channel-config-host]').getAttribute('data-channel')).toBe('workbuddy')
  })

  it('鼠标点击菜单项跨帧失焦后，保存结束和重新 enabled 后回焦 trigger', async () => {
    const before = makeSnapshot({ enabled: true, channel: 'buddy' })
    const after = makeSnapshot({ enabled: true, channel: 'workbuddy' })
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container, calls, t } = renderCard(before, () => response.promise)

    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    await click(trigger)
    const menu = query<HTMLElement>(document, '[data-dropdown-menu]')
    // 浏览器始终有已计算的样式；jsdom 需要先计算一次，disabled 的属性失效
    // 才会像浏览器一样请求 focus fixup。这里不手动聚焦任何元素。
    void getComputedStyle(trigger).color
    await click(buttonByText(menu, t('channel.workbuddy.name')))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ method: 'settings.update', payload: { patch: { channel: 'workbuddy' } } })
    expect(trigger.disabled).toBe(true)
    expect(trigger.textContent).toContain(t('channel.buddy.name'))

    await advanceFocusFixupFrame()
    expect(document.activeElement).toBe(document.body)

    response.resolve({ ok: true, value: after })
    await settle()

    expect(trigger.disabled).toBe(false)
    expect(document.activeElement).toBe(trigger)
    expect(trigger.textContent).toContain(t('channel.workbuddy.name'))
  })

  it('pending 失焦后用户主动聚焦其它控件，保存结束不得抢回焦点', async () => {
    const before = makeSnapshot({ enabled: true, channel: 'buddy' })
    const after = makeSnapshot({ enabled: true, channel: 'workbuddy' })
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container, t } = renderCard(before, () => response.promise)
    const userControl = appendUserControl()

    const trigger = query<HTMLButtonElement>(container, '[data-dropdown-trigger]')
    await keydown(trigger, 'Enter')
    await keydown(document.activeElement as Element, 'ArrowDown')
    await keydown(document.activeElement as Element, 'Tab')

    await advanceFocusFixupFrame()
    expect(document.activeElement).toBe(document.body)

    userControl.focus()
    expect(document.activeElement).toBe(userControl)

    response.resolve({ ok: true, value: after })
    await settle()

    expect(trigger.disabled).toBe(false)
    expect(trigger.textContent).toContain(t('channel.workbuddy.name'))
    expect(document.activeElement).toBe(userControl)
    userControl.remove()
  })

  it('初次挂载与无关 busy 更新不把焦点抢到 trigger', async () => {
    const before = makeSnapshot({ enabled: false, channel: 'buddy' })
    const after = makeSnapshot({ enabled: true, channel: 'buddy' })
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container } = renderCard(before, () => response.promise)
    const userControl = appendUserControl()
    userControl.focus()

    expect(document.activeElement).toBe(userControl)
    await click(query(container, '[role="switch"]'))
    expect(query<HTMLButtonElement>(container, '[data-dropdown-trigger]').disabled).toBe(true)

    response.resolve({ ok: true, value: after })
    await settle()

    expect(query<HTMLButtonElement>(container, '[data-dropdown-trigger]').disabled).toBe(false)
    expect(document.activeElement).toBe(userControl)
    userControl.remove()
  })
})