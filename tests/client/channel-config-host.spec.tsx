// @vitest-environment jsdom
/**
 * Task 13 动态 ChannelConfigHost：同一时刻只渲染当前 search.channel 的配置区，
 * 为 Task 14 的账号区和 Qoder 端点行预留准确宿主，不提前实现账号列表/授权/删除
 * 或第二套端点编辑。
 *
 * R53：h3 下不再有独立渠道说明行；固定端点与 Qoder 端点都是“左侧搜索端点 +
 * 右侧值/下拉”的同一横向 row，说明放在紧随其后的 hintRow。
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { CHANNEL_IDS } from '../../src/shared/channels.ts'
import { ChannelConfigHost } from '../../src/client/ChannelConfigHost.tsx'
import {
  mount,
  query,
  translator,
  type MountedRoot,
} from './support/settings-harness.ts'

const mounted: MountedRoot[] = []

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

/**
 * 挂载一个渠道配置宿主。
 * @param channel - 当前渠道。
 * @param options - 当前账号、额外 children 与 OFF gating。
 * @returns 容器、翻译器与宿主元素。
 */
function renderHost(
  channel: (typeof CHANNEL_IDS)[number],
  options: {
    accountId?: string | null
    children?: ReturnType<typeof createElement>
    gated?: boolean
  } = {},
) {
  const t = translator('zh')
  const root = mount(createElement(ChannelConfigHost, {
    channel,
    currentAccountId: options.accountId ?? null,
    t,
    gated: options.gated ?? false,
    ...(options.children === undefined ? {} : { children: options.children }),
  }))
  mounted.push(root)
  return {
    ...root,
    t,
    host: query<HTMLElement>(root.container, '[data-channel-config-host]'),
  }
}

describe('ChannelConfigHost（真实 DOM）', () => {
  it.each(CHANNEL_IDS)('只渲染当前渠道 %s 的 h3 与配置，不再渲染重复说明行', (channel) => {
    const { host, t, container } = renderHost(channel)
    expect(host.getAttribute('data-channel')).toBe(channel)
    expect(host.firstElementChild?.tagName).toBe('H3')
    expect(host.querySelector('h3')?.textContent).toBe('渠道配置')
    expect(host.querySelector('h3')?.textContent).toBe(t('channel.config.title'))
    expect(host.querySelector('h3')?.textContent).not.toBe(t(`channel.${channel}.name`))
    // R53：组名下一行不再重复渠道说明。
    expect(host.querySelector('[data-channel-description]')).toBeNull()
    expect(host.textContent).not.toContain(t(`channel.${channel}.description`))

    expect(host.querySelectorAll('[data-channel-config-host]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-channel-config-host]')).toHaveLength(1)
    expect(host.querySelector('[data-account-config-slot]')).toBeTruthy()
    expect(host.querySelector('[data-account-state]')?.getAttribute('data-account-state')).toBe('required')

    const otherChannels = CHANNEL_IDS.filter(id => id !== channel)
    expect(host.querySelector('[data-qoder-endpoint-slot]') === null).toBe(channel !== 'qoder')
    for (const other of otherChannels) {
      expect(host.textContent).not.toContain(t(`channel.${other}.name`))
    }
  })

  it('账号区只显示状态 rowDescription，不出现账号列表、内联授权或删除按钮', () => {
    const { host, t } = renderHost('buddy')
    const accountSlot = query<HTMLElement>(host, '[data-account-config-slot]')
    expect(accountSlot.querySelectorAll('button')).toHaveLength(0)
    expect(accountSlot.textContent).toContain('需要账号')
    expect(accountSlot.textContent).not.toMatch(/添加账号|重新登录|删除|授权|登录/i)

    const status = query<HTMLElement>(host, '[data-account-state]')
    expect(status.getAttribute('data-account-state')).toBe('required')
    expect(status.tagName).toBe('DIV')
    expect(status.className).toContain('row')
    expect(status.closest('[data-hint-row]')).toBeNull()
    expect(status.closest('[data-field]')).toBeNull()
    expect(query<HTMLElement>(status, '[class*="rowDescription"]').textContent)
      .toBe(t('channel.account.required'))
    expect(status.closest('[data-account-config-slot]')).toBe(accountSlot)
  })

  it('已有 currentAccountId 时只显示当前账号，不宣称 ready', () => {
    const { host, t } = renderHost('workbuddy', { accountId: 'work-account' })
    const status = query<HTMLElement>(host, '[data-account-state]')
    expect(status.getAttribute('data-account-state')).toBe('selected')
    expect(host.textContent).toContain(`${t('channel.account.current')}: work-account`)
    expect(host.textContent).not.toMatch(/就绪|已连接|ready/i)
    expect(status.querySelector('[data-hint-row]')).toBeNull()
  })

  it('端点行横向排列：固定域与 Qoder 下拉都在左侧标签同一 row，说明在其后 hintRow', () => {
    const qoder = renderHost('qoder')
    const endpoint = query<HTMLElement>(qoder.host, '[data-qoder-endpoint-slot]')
    const account = query<HTMLElement>(qoder.host, '[data-account-config-slot]')
    expect(endpoint.nextElementSibling).toBe(account)

    const qoderRow = query<HTMLElement>(endpoint, '[data-qoder-endpoint-row]')
    expect(qoderRow.tagName).toBe('DIV')
    expect(qoderRow.className).toContain('row')
    expect(qoderRow.children).toHaveLength(2)
    expect(qoderRow.firstElementChild?.className).toContain('rowText')
    const qoderLabel = query<HTMLElement>(qoderRow, '[data-field-label]')
    expect(qoderLabel.tagName).toBe('LABEL')
    expect(qoderLabel.textContent).toBe('搜索端点')
    const qoderTrigger = query<HTMLButtonElement>(qoderRow, '[data-dropdown-trigger]')
    expect(qoderLabel.getAttribute('for')).toBe(qoderTrigger.id)
    expect(qoderRow.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(1)
    expect(qoderRow.querySelector('[class*="fieldControl"]')).toBeNull()
    expect(qoderRow.textContent).not.toContain('gateway.qoder.com.cn')

    const qoderHints = [...endpoint.querySelectorAll<HTMLElement>('[data-hint-row]')]
    expect(qoderHints).toHaveLength(1)
    expect(qoderHints[0]?.previousElementSibling).toBe(qoderRow)
    expect(qoderHints[0]?.querySelectorAll('button')).toHaveLength(0)
    expect(qoderHints[0]?.querySelector('[data-field-label]')).toBeNull()
    expect(qoderHints[0]?.textContent).toContain(qoder.t('channel.endpoint.noObservation'))
    expect(qoderHints[0]?.textContent).toContain(qoder.t('channel.endpoint.description'))
    expect(endpoint.children).toHaveLength(2)

    const buddy = renderHost('buddy')
    expect(buddy.host.querySelector('[data-qoder-endpoint-slot]')).toBeNull()
    expect(buddy.host.querySelector('[data-field="endpoint"]')).toBeNull()
    const fixedSlot = query<HTMLElement>(buddy.host, '[data-fixed-endpoint-slot]')
    const fixedRow = query<HTMLElement>(fixedSlot, '[data-fixed-endpoint-row]')
    expect(fixedRow.className).toContain('row')
    expect(fixedRow.children).toHaveLength(2)
    expect(query<HTMLElement>(fixedRow, '[data-fixed-endpoint-label]').textContent)
      .toBe('搜索端点')
    expect(query<HTMLElement>(fixedRow, '[data-fixed-endpoint-label]').className)
      .toContain('rowTitle')
    const fixedValue = query<HTMLElement>(fixedRow, '[data-fixed-endpoint]')
    expect(fixedValue.textContent).toBe('copilot.tencent.com')
    expect(fixedValue.className).toContain('fieldValue')
    expect(fixedSlot.querySelector('button')).toBeNull()
    const fixedHints = [...fixedSlot.querySelectorAll<HTMLElement>('[data-hint-row]')]
    expect(fixedHints).toHaveLength(1)
    expect(fixedHints[0]?.previousElementSibling).toBe(fixedRow)
    expect(fixedHints[0]?.querySelector('p[class*="hint"]')?.textContent).toContain('固定使用该域名')
    expect(fixedHints[0]?.querySelectorAll('button')).toHaveLength(0)
    expect(fixedSlot.children).toHaveLength(2)
  })

  it('账号状态是独立 row，section 直接子元素只有 heading 与两个 fieldSlot', () => {
    const { host, t } = renderHost('qoder')
    const accountSlot = query<HTMLElement>(host, '[data-account-config-slot]')
    const state = query<HTMLElement>(accountSlot, '[data-account-state]')
    expect(state.tagName).toBe('DIV')
    expect(state.className).toContain('row')
    expect(query<HTMLElement>(state, '[class*="rowDescription"]').textContent)
      .toBe(t('channel.account.required'))
    expect(accountSlot.querySelector('[data-hint-row]')).toBeNull()
    expect(accountSlot.querySelector('[data-field] [data-field-head]')?.textContent).toContain('账号')

    const directChildren = [...host.children]
    expect(directChildren.every(child => (
      child.matches('h3, [data-account-config-slot], [data-qoder-endpoint-slot], [data-fixed-endpoint-slot]')
    ))).toBe(true)
  })

  it('Task 14 传入账号区 children 时替换占位状态；端点行仍只在 qoder 出现', () => {
    const children = createElement('div', { 'data-account-config': 'future' }, '未来账号区')
    const { host } = renderHost('qoder', { children })
    const slot = query<HTMLElement>(host, '[data-account-config-slot]')
    expect(slot.textContent).toBe('未来账号区')
    expect(host.querySelector('[data-account-state]')).toBeNull()
    expect(slot.querySelector('[data-hint-row]')).toBeNull()
    const endpoint = query<HTMLElement>(host, '[data-qoder-endpoint-slot]')
    expect(endpoint.querySelector('[data-qoder-endpoint-row]')).not.toBeNull()
    expect(endpoint.querySelector('[data-hint-row]')).not.toBeNull()
    expect(endpoint.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-channel-config-host]')).toHaveLength(0)
    expect(host.querySelectorAll('[data-qoder-endpoint-slot]')).toHaveLength(1)
  })

  it.each(CHANNEL_IDS)('OFF gating：%s 整段标记灰化并禁用配置修改入口', (channel) => {
    const { host, t } = renderHost(channel, { gated: true })
    expect(host.getAttribute('data-off-gated')).toBe('true')
    expect(host.className).toContain('channelGated')
    expect(host.querySelector('h3')?.textContent).toBe('渠道配置')
    expect(host.querySelector('[data-channel-description]')).toBeNull()

    const fallback = query<HTMLElement>(host, '[data-account-config-slot] [data-off-gated="true"]')
    expect(fallback.closest('[data-account-config-slot]')).not.toBeNull()
    const state = query<HTMLElement>(host, '[data-account-state]')
    expect(state.getAttribute('data-off-gated')).toBe('true')
    expect(state.className).toContain('rowGated')

    if (channel === 'qoder') {
      const endpoint = query<HTMLElement>(host, '[data-qoder-endpoint-slot]')
      expect(query<HTMLButtonElement>(endpoint, '[data-dropdown-trigger]').disabled).toBe(true)
      const row = query<HTMLElement>(endpoint, '[data-qoder-endpoint-row]')
      expect(row.getAttribute('data-off-gated')).toBe('true')
      expect(row.className).toContain('rowGated')
      const hintRow = query<HTMLElement>(endpoint, '[data-hint-row]')
      expect(hintRow.getAttribute('data-off-gated')).toBe('true')
      expect(hintRow.className).toContain('rowGated')
    } else {
      const endpoint = query<HTMLElement>(host, '[data-fixed-endpoint-slot]')
      const row = query<HTMLElement>(endpoint, '[data-fixed-endpoint-row]')
      expect(row.getAttribute('data-off-gated')).toBe('true')
      expect(row.className).toContain('rowGated')
      expect(endpoint.querySelector('button')).toBeNull()
      expect(query<HTMLElement>(row, '[data-fixed-endpoint]').textContent).not.toBe('')
      expect(query<HTMLElement>(endpoint, '[data-hint-row]').getAttribute('data-off-gated'))
        .toBe('true')
    }
  })

  it('ON 时配置宿主没有 OFF gating 标记', () => {
    const { host } = renderHost('qoder')
    expect(host.hasAttribute('data-off-gated')).toBe(false)
    expect(host.className).not.toContain('channelGated')
    const row = query<HTMLElement>(host, '[data-qoder-endpoint-row]')
    expect(row.hasAttribute('data-off-gated')).toBe(false)
    expect(row.className).not.toContain('rowGated')
    expect(query<HTMLButtonElement>(host, '[data-dropdown-trigger]').disabled).toBe(false)
  })

  it('OFF gating 不改变传入 children 的账号区结构', () => {
    const children = createElement('div', { 'data-account-config': 'future' }, '未来账号区')
    const { host } = renderHost('buddy', { children, gated: true })
    expect(host.getAttribute('data-off-gated')).toBe('true')
    expect(query<HTMLElement>(host, '[data-account-config-slot]').textContent).toBe('未来账号区')
    expect(host.querySelector('[data-account-state]')).toBeNull()
  })

  it('英文配置区不含中文，Qoder 国际版名称与说明来自英文字典', () => {
    const t = translator('en')
    const root = mount(createElement(ChannelConfigHost, {
      channel: 'qoder',
      currentAccountId: null,
      t,
    }))
    mounted.push(root)
    const host = query<HTMLElement>(root.container, '[data-channel-config-host]')
    expect(host.querySelector('h3')?.textContent).toBe('Channel configuration')
    expect(host.textContent).not.toContain('Qoder International')
    expect(host.textContent).toContain('Account required')
    expect(host.textContent).toContain('Search endpoint')
    expect(host.textContent).not.toMatch(/[\u4e00-\u9fff]/)
  })
})
