// @vitest-environment jsdom
/**
 * Task 13 动态 ChannelConfigHost：同一时刻只渲染当前 search.channel 的配置区，
 * 为 Task 14 的账号区和 Qoder 端点行预留准确宿主，不提前实现账号列表/授权/删除
 * 或第二套端点编辑。
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
  it.each(CHANNEL_IDS)('只渲染当前渠道 %s，名称与说明都来自 locale', (channel) => {
    const { host, t, container } = renderHost(channel)
    expect(host.getAttribute('data-channel')).toBe(channel)
    expect(host.firstElementChild?.tagName).toBe('H3')
    expect(host.querySelector('h3')?.textContent).toBe(t(`channel.${channel}.name`))
    expect(host.textContent).toContain(t(`channel.${channel}.description`))

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

  it('账号区只显示状态，不出现账号列表、内联授权或删除按钮', () => {
    const { host } = renderHost('buddy')
    const accountSlot = query<HTMLElement>(host, '[data-account-config-slot]')
    expect(accountSlot.querySelectorAll('button')).toHaveLength(0)
    expect(accountSlot.textContent).toContain('需要账号')
    expect(accountSlot.textContent).not.toMatch(/添加账号|重新登录|删除|授权|登录/i)

    const status = query<HTMLElement>(host, '[data-account-state]')
    expect(status.getAttribute('data-account-state')).toBe('required')
    expect(status.closest('[data-account-config-slot]')).toBe(accountSlot)
  })

  it('已有 currentAccountId 时只显示当前账号，不宣称 ready', () => {
    const { host, t } = renderHost('workbuddy', { accountId: 'work-account' })
    expect(host.querySelector('[data-account-state]')?.getAttribute('data-account-state')).toBe('selected')
    expect(host.textContent).toContain(`${t('channel.account.current')}: work-account`)
    expect(host.textContent).not.toMatch(/就绪|已连接|ready/i)
  })

  it('只有 Qoder 国际版拥有端点行宿主，且宿主位于账号区之前；下拉只服务 qoder', () => {
    const qoder = renderHost('qoder')
    const endpoint = query<HTMLElement>(qoder.host, '[data-qoder-endpoint-slot]')
    const account = query<HTMLElement>(qoder.host, '[data-account-config-slot]')
    expect(endpoint.nextElementSibling).toBe(account)
    expect(query<HTMLElement>(endpoint, '[data-qoder-endpoint-row]')).toBeTruthy()
    expect(query<HTMLButtonElement>(endpoint, '[data-dropdown-trigger]').textContent)
      .toContain('自动')
    expect(endpoint.querySelector('[data-endpoint-status]')?.textContent).toContain('尚无运行观测')
    expect(endpoint.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(1)
    expect(endpoint.textContent).not.toContain('gateway.qoder.com.cn')

    const buddy = renderHost('buddy')
    expect(buddy.host.querySelector('[data-qoder-endpoint-slot]')).toBeNull()
    const fixedSlot = query<HTMLElement>(buddy.host, '[data-fixed-endpoint-slot]')
    expect(query<HTMLElement>(fixedSlot, '[data-fixed-endpoint]').textContent)
      .toBe('copilot.tencent.com')
    expect(fixedSlot.querySelector('[aria-haspopup="menu"]')).toBeNull()
    expect(query<HTMLElement>(fixedSlot, '[data-field-head] > [data-label-group] [data-field-label]').textContent)
      .toBe('搜索端点')
    expect(query<HTMLElement>(fixedSlot, 'p[class*="hint"]').textContent).toContain('固定使用该域名')
  })

  it('账号区 hintRow 位于 fieldSlot 内部，section 直接子元素只有 heading/row/fieldSlot', () => {
    const { host } = renderHost('qoder')
    const slot = query<HTMLElement>(host, '[data-account-config-slot]')
    const hint = query<HTMLElement>(host, '[data-hint-row]')
    expect(hint.parentElement).toBe(slot)
    expect(hint.closest('section')).toBe(host)
    expect(host.querySelector(':scope > [data-hint-row]')).toBeNull()
    expect(slot.querySelector('.field, [data-field]')).toBeTruthy()
    expect(slot.querySelector('[data-field-head] > [data-label-group] [data-field-label]')?.textContent).toBe('账号')
    expect(slot.hasAttribute('data-hint-row')).toBe(false)

    const directChildren = [...host.children]
    expect(directChildren.every(child => (
      child.matches('h3, [data-channel-description], [data-account-config-slot], [data-qoder-endpoint-slot]')
    ))).toBe(true)
  })

  it('Task 14 传入账号区 children 时替换占位状态；端点行仍只在 qoder 出现', () => {
    const children = createElement('div', { 'data-account-config': 'future' }, '未来账号区')
    const { host } = renderHost('qoder', { children })
    const slot = query<HTMLElement>(host, '[data-account-config-slot]')
    expect(slot.textContent).toBe('未来账号区')
    expect(host.querySelector('[data-account-state]')).toBeNull()
    expect(host.querySelector('[data-hint-row]')).toBeNull()
    const endpoint = query<HTMLElement>(host, '[data-qoder-endpoint-slot]')
    expect(endpoint.querySelector('[data-qoder-endpoint-row]')).not.toBeNull()
    expect(endpoint.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-channel-config-host]')).toHaveLength(0)
    expect(host.querySelectorAll('[data-qoder-endpoint-slot]')).toHaveLength(1)
  })

  it.each(CHANNEL_IDS)('OFF gating：%s 整段标记灰化并禁用配置修改入口', (channel) => {
    const { host, t } = renderHost(channel, { gated: true })
    expect(host.getAttribute('data-off-gated')).toBe('true')
    expect(host.className).toContain('channelGated')
    expect(host.querySelector('h3')?.textContent).toBe(t(`channel.${channel}.name`))
    expect(host.textContent).toContain(t(`channel.${channel}.description`))

    const fallback = query<HTMLElement>(host, '[data-account-config-slot] [data-off-gated="true"]')
    expect(fallback.closest('[data-account-config-slot]')).not.toBeNull()
    expect(host.querySelector('[data-account-state]')).not.toBeNull()

    if (channel === 'qoder') {
      const endpoint = query<HTMLElement>(host, '[data-qoder-endpoint-slot]')
      expect(query<HTMLButtonElement>(endpoint, '[data-dropdown-trigger]').disabled).toBe(true)
      expect(query<HTMLElement>(endpoint, '[data-qoder-endpoint-row]')
        .getAttribute('data-off-gated')).toBe('true')
    } else {
      const endpoint = query<HTMLElement>(host, '[data-fixed-endpoint-slot]')
      const field = query<HTMLElement>(endpoint, '[data-field="endpoint"]')
      expect(field.getAttribute('data-off-gated')).toBe('true')
      expect(field.className).toContain('fieldGated')
      expect(endpoint.querySelector('button')).toBeNull()
      expect(query<HTMLElement>(endpoint, '[data-fixed-endpoint]').textContent).not.toBe('')
    }
  })

  it('ON 时配置宿主没有 OFF gating 标记', () => {
    const { host } = renderHost('qoder')
    expect(host.hasAttribute('data-off-gated')).toBe(false)
    expect(host.className).not.toContain('channelGated')
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
    expect(host.textContent).toContain('Qoder International')
    expect(host.textContent).toContain('Account required')
    expect(host.textContent).not.toMatch(/[\u4e00-\u9fff]/)
  })
})
