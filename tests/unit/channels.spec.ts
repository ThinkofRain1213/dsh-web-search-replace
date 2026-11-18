/**
 * Task 2：四渠道注册表与设置契约。
 *
 * 这里固定的是「顶层渠道唯一真源」：四个稳定 ID、各自固定搜索域名、
 * 只有 Qoder 国际版拥有的 auto/center/api2 端点偏好、默认设置与稳定
 * 账号 slug 规则。协议族只用于代码复用，不能成为账号或执行归属。
 */
import { describe, expect, it } from 'vitest'

import {
  CHANNELS,
  CHANNEL_IDS,
  isChannelId,
  isQoderEndpointPreference,
} from '../../src/shared/channels.ts'
import {
  DEFAULT_SEARCH_SETTINGS,
  isStableChannelAccountId,
} from '../../src/shared/contracts.ts'

describe('四渠道注册表', () => {
  it('固定四个渠道及下拉顺序', () => {
    expect(CHANNEL_IDS).toEqual(['buddy', 'workbuddy', 'qoder', 'qodercn'])
    expect(Object.keys(CHANNELS)).toEqual([...CHANNEL_IDS])
  })

  it('每个渠道只声明自己的固定搜索域名', () => {
    expect(CHANNELS.buddy.hosts).toEqual(['copilot.tencent.com'])
    expect(CHANNELS.workbuddy.hosts).toEqual(['www.workbuddy.ai'])
    expect(CHANNELS.qoder.hosts).toEqual(['center.qoder.sh', 'api2.qoder.sh'])
    expect(CHANNELS.qodercn.hosts).toEqual(['gateway.qoder.com.cn'])
  })

  it('只有 Qoder 国际版有 auto/center/api2 端点偏好', () => {
    expect(CHANNELS.qoder.endpointPreference).toEqual({
      field: 'endpointPreference',
      defaultValue: 'auto',
      options: ['auto', 'center', 'api2'],
      // 自动模式默认 center，api2 是同渠道备用；不得出现 gateway.qoder.com.cn。
      hosts: {
        auto: 'center.qoder.sh',
        center: 'center.qoder.sh',
        api2: 'api2.qoder.sh',
      },
    })
    expect(CHANNELS.buddy.endpointPreference).toBeUndefined()
    expect(CHANNELS.workbuddy.endpointPreference).toBeUndefined()
    expect(CHANNELS.qodercn.endpointPreference).toBeUndefined()
  })

  it('渠道元数据只声明账号型配置与搜索能力', () => {
    for (const id of CHANNEL_IDS) {
      const channel = CHANNELS[id]
      expect(channel.id).toBe(id)
      expect(channel.configKind).toBe('account')
      expect(channel.capabilities).toEqual({ search: true, fetch: false })
      expect(channel.accountBoundary).toMatch(/仅/)
      expect(channel.displayName.trim()).not.toBe('')
      expect(channel.description.zh.trim()).not.toBe('')
      expect(channel.description.en.trim()).not.toBe('')
    }
  })

  it('协议族只标记代码复用归属，且腾讯系/Qoder 系不合并渠道', () => {
    expect(CHANNELS.buddy.protocolFamily).toBe('tencent')
    expect(CHANNELS.workbuddy.protocolFamily).toBe('tencent')
    expect(CHANNELS.qoder.protocolFamily).toBe('qoder')
    expect(CHANNELS.qodercn.protocolFamily).toBe('qoder')
    expect(new Set(CHANNEL_IDS.map((id) => CHANNELS[id].protocolFamily)).size).toBe(2)
  })

  it('渠道与端点偏好校验只接受精确值', () => {
    for (const id of CHANNEL_IDS) expect(isChannelId(id)).toBe(true)
    for (const value of ['deepseek', 'buddy ', 'Buddy', 'qoder-cn', '', null, 1]) {
      expect(isChannelId(value)).toBe(false)
    }
    for (const value of ['auto', 'center', 'api2']) {
      expect(isQoderEndpointPreference(value)).toBe(true)
    }
    for (const value of ['gateway', 'cn', 'center.qoder.sh', '', null, 1]) {
      expect(isQoderEndpointPreference(value)).toBe(false)
    }
  })
})

describe('默认搜索设置', () => {
  it('默认关闭搜索、选择 CodeBuddy，且四个渠道均无当前账号', () => {
    expect(DEFAULT_SEARCH_SETTINGS).toEqual({
      search: { enabled: false, channel: 'buddy' },
      buddy: { currentAccountId: null },
      workbuddy: { currentAccountId: null },
      qoder: { currentAccountId: null, endpointPreference: 'auto' },
      qodercn: { currentAccountId: null },
    })
  })
})

describe('稳定账号 slug', () => {
  it('只接受小写字母开头的字母/数字/连字符', () => {
    for (const value of ['a', 'account-1', 'a0-b9', 'z9']) {
      expect(isStableChannelAccountId(value)).toBe(true)
    }
  })

  it('拒绝大写、下划线、空格、数字开头、空串与非字符串', () => {
    for (const value of ['', 'Account-1', 'account_1', '1account', '-account', 'account ', null, 1, undefined]) {
      expect(isStableChannelAccountId(value)).toBe(false)
    }
  })
})
