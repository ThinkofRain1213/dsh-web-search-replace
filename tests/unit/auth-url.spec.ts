/**
 * 共享授权 URL 安全契约：四渠道各自精确 host、https、无 userinfo、默认端口、
 * 无 fragment、无控制字符、长度上限；不使用后缀匹配，也不接受其他渠道 host。
 */
import { describe, expect, it } from 'vitest'

import {
  AUTH_URL_HOSTS,
  isAuthUrlForChannel,
  type AuthChannel,
} from '../../src/shared/auth.ts'
import { normalizeTencentAuthUrl } from '../../src/host/channels/tencent/auth-flow.ts'
import { normalizeQoderAuthUrl } from '../../src/host/channels/qoder/auth-flow.ts'

describe('isAuthUrlForChannel', () => {
  it('四渠道分别接受自己的精确授权 host', () => {
    const valid: Readonly<Record<AuthChannel, readonly string[]>> = {
      buddy: [
        'https://www.codebuddy.cn/login?state=abc',
        'https://copilot.tencent.com/auth/callback?code=1',
      ],
      workbuddy: ['https://www.workbuddy.ai/auth?flow=1'],
      qoder: ['https://qoder.com/device/selectAccounts?machine_id=m'],
      qodercn: ['https://qoder.cn/device/selectAccounts?machine_id=m'],
    }
    for (const channel of Object.keys(valid) as AuthChannel[]) {
      for (const url of valid[channel]) {
        expect(isAuthUrlForChannel(url, channel), `${channel} ${url}`).toBe(true)
      }
    }
    expect(AUTH_URL_HOSTS).toEqual({
      buddy: ['www.codebuddy.cn', 'copilot.tencent.com'],
      workbuddy: ['www.workbuddy.ai'],
      qoder: ['qoder.com'],
      qodercn: ['qoder.cn'],
    })
  })

  it('拒绝错渠道 host、恶意域与后缀匹配', () => {
    const invalid: ReadonlyArray<readonly [AuthChannel, string]> = [
      ['buddy', 'https://qoder.com/device'],
      ['buddy', 'https://www.workbuddy.ai/auth'],
      ['qoder', 'https://qoder.cn/device'],
      ['qodercn', 'https://qoder.com/device'],
      ['workbuddy', 'https://www.codebuddy.cn/login'],
      ['buddy', 'https://evil.example/auth'],
      ['qoder', 'https://qoder.com.evil.example/auth'],
      ['qoder', 'https://notqoder.com/auth'],
      ['qoder', 'https://qoder.com./auth'],
    ]
    for (const [channel, url] of invalid) {
      expect(isAuthUrlForChannel(url, channel), `${channel} ${url}`).toBe(false)
    }
  })

  it('B2：四渠道 Host/Client 都接受显式标准 443，拒绝其他显式端口', () => {
    const cases = [
      { channel: 'buddy', host: 'www.codebuddy.cn', family: 'tencent' },
      { channel: 'workbuddy', host: 'www.workbuddy.ai', family: 'tencent' },
      { channel: 'qoder', host: 'qoder.com', family: 'qoder' },
      { channel: 'qodercn', host: 'qoder.cn', family: 'qoder' },
    ] as const
    for (const { channel, host, family } of cases) {
      const standard = `https://${host}:443/login?state=abc`
      const other = `https://${host}:8443/login?state=abc`
      expect(isAuthUrlForChannel(standard, channel), `${channel} Client :443`).toBe(true)
      expect(isAuthUrlForChannel(other, channel), `${channel} Client :8443`).toBe(false)
      if (family === 'tencent') {
        expect(normalizeTencentAuthUrl(standard, [host]), `${channel} Host :443`).toBe(standard)
        expect(normalizeTencentAuthUrl(other, [host]), `${channel} Host :8443`).toBeUndefined()
      } else {
        expect(normalizeQoderAuthUrl(standard, [host]), `${channel} Host :443`).toBe(standard)
        expect(normalizeQoderAuthUrl(other, [host]), `${channel} Host :8443`).toBeUndefined()
      }
    }
  })

  it('拒绝 http、userinfo、非默认端口、fragment、控制字符与畸形 https', () => {
    const invalid = [
      'http://qoder.com/device',
      'javascript:alert(1)',
      'https://user@qoder.com/device',
      'https://user:pass@qoder.com/device',
      'https://user%3Apass@qoder.com/device',
      'https://qoder.com:8443/device',
      'https://qoder.com/device#fragment',
      'https://qoder.com/de\u0000vice',
      'https://qoder.com/de\nvice',
      'https://qoder.com/de\tvice',
      'https://',
      'https:///device',
      'not-a-url',
      '',
    ]
    for (const url of invalid) {
      expect(isAuthUrlForChannel(url, 'qoder'), JSON.stringify(url)).toBe(false)
    }
  })

  it('拒绝超过 2048 字符的 URL 与非字符串值', () => {
    const base = 'https://qoder.com/device?x='
    const long = `${base}${'a'.repeat(2049 - base.length)}`
    const max = `${base}${'a'.repeat(2048 - base.length)}`
    expect(isAuthUrlForChannel(long, 'qoder')).toBe(false)
    expect(isAuthUrlForChannel(max, 'qoder')).toBe(true)
    for (const value of [null, undefined, 1, {}, []]) {
      expect(isAuthUrlForChannel(value, 'qoder')).toBe(false)
    }
  })
})