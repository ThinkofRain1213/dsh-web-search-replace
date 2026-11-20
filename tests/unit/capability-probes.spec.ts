/** R38：四个真实 Search capability probes 与 hung-probe 取消边界。 */
import { describe, expect, it } from 'vitest'

import * as bindings from '../../src/host/accounts/bindings.ts'
import { BuddyAuthFlow } from '../../src/host/channels/buddy/auth.ts'
import { QoderSigner } from '../../src/host/channels/qoder/signer.ts'
import { createAccountFixture } from './support/account-fixture.ts'

const CENTER = 'center.qoder.sh'
const API2 = 'api2.qoder.sh'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function makeVerifiers(deps: Record<string, unknown>): any {
  const create = (bindings as any).createChannelCapabilityVerifiers
  expect(typeof create).toBe('function')
  return create(deps)
}

describe('四个真实 Search capability probes', () => {
  it('Buddy/WorkBuddy candidate 直传固定 host，不经过 current-account resolver', async () => {
    const calls: Array<{ url: string; token: string }> = []
    const verifiers = makeVerifiers({
      fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          token: new Headers(init?.headers).get('Authorization') ?? '',
        })
        return json({ results: [{ url: 'https://probe.test/tencent' }] })
      },
      resolveCurrentCredential: async () => { throw new Error('probe must not resolve current account') },
    })
    await verifiers.buddy({
      channelId: 'buddy', accessToken: 'BUDDY_CANDIDATE', vendorAccountId: 'buddy-vendor',
    }, new AbortController().signal)
    await verifiers.workbuddy({
      channelId: 'workbuddy', accessToken: 'WORKBUDDY_CANDIDATE', vendorAccountId: 'workbuddy-vendor',
    }, new AbortController().signal)
    expect(calls).toEqual([
      { url: 'https://copilot.tencent.com/agenttool/v1/search', token: 'Bearer BUDDY_CANDIDATE' },
      { url: 'https://www.workbuddy.ai/agenttool/v1/search', token: 'Bearer WORKBUDDY_CANDIDATE' },
    ])
  })

  it('QoderCN candidate 直传固定 gateway，使用真实签名路径', async () => {
    const credentials: unknown[] = []
    const originalPrepare = QoderSigner.prototype.prepare
    QoderSigner.prototype.prepare = async function (host, path, body, credential, signal) {
      credentials.push(credential)
      return await originalPrepare.call(this, host, path, body, credential, signal)
    }
    try {
      const urls: string[] = []
      const verifiers = makeVerifiers({
        fetcher: async (input: RequestInfo | URL) => {
          urls.push(String(input))
          return json({ pageItems: [{ link: 'https://probe.test/qodercn' }] })
        },
      })
      await verifiers.qodercn({
        channelId: 'qodercn',
        vendorAccountId: 'cn-vendor',
        credential: { securityOauthToken: 'CN_CANDIDATE', machineId: 'CN_MACHINE' },
      }, new AbortController().signal)
      expect(urls).toEqual(['https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=1'])
      expect(credentials).toEqual([{ securityOauthToken: 'CN_CANDIDATE', machineId: 'CN_MACHINE' }])
    } finally {
      QoderSigner.prototype.prepare = originalPrepare
    }
  })

  it('Qoder auto probe 可限定换域，但不写持久路由、不发布 actualHost；fixed 忽略路由读取', async () => {
    let writes = 0
    let observations = 0
    const hosts: string[] = []
    const verifiers = makeVerifiers({
      getEndpointPreference: () => 'auto',
      readLastSuccessfulHost: () => null,
      writeLastSuccessfulHost: async () => { writes += 1 },
      onObservation: () => { observations += 1 },
      fetcher: async (input: RequestInfo | URL) => {
        const host = new URL(String(input)).hostname
        hosts.push(host)
        if (host === CENTER) throw new TypeError('fetch failed')
        return json({ pageItems: [{ link: 'https://probe.test/qoder' }] })
      },
    })
    await verifiers.qoder({
      channelId: 'qoder',
      vendorAccountId: 'probe-only',
      credential: { securityOauthToken: 'QODER_CANDIDATE', machineId: 'QODER_MACHINE' },
    }, new AbortController().signal)
    expect(hosts).toEqual([CENTER, API2])
    expect(writes).toBe(0)
    expect(observations).toBe(0)

    const fixed = makeVerifiers({
      getEndpointPreference: () => 'center',
      readLastSuccessfulHost: () => { throw new Error('fixed must not read route') },
      fetcher: async () => json({ pageItems: [{ link: 'https://probe.test/qoder-fixed' }] }),
    })
    await fixed.qoder({
      channelId: 'qoder', vendorAccountId: 'probe-only',
      credential: { securityOauthToken: 'QODER_CANDIDATE', machineId: 'QODER_MACHINE' },
    }, new AbortController().signal)
  })
})

describe('hung capability probe 的 signal/settle 边界', () => {
  it('整体 deadline 实际 abort probe，等待 settle，saveAccount/setCurrent 为零', async () => {
    const fixture = createAccountFixture()
    let probeSignal: AbortSignal | undefined
    let probeSettled = false
    const flow = new BuddyAuthFlow({
      store: fixture.store,
      accounts: fixture.service,
      authTimeoutMs: 50,
      pollIntervalMs: 1,
      fetcher: async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/auth/state')) {
          return json({ code: 0, data: { state: 's', authUrl: 'https://www.codebuddy.cn/login/?state=s' } })
        }
        if (url.includes('/login/account')) {
          return json({ code: 0, data: { uid: 'u', nickname: 'U', enterpriseId: '', type: 'personal' } })
        }
        return json({ code: 0, data: {
          accessToken: 'A', refreshToken: 'R', expiresIn: 3600, tokenType: 'Bearer', domain: 'copilot.tencent.com',
        } })
      },
      verifyCapability: async (_credential, signal) => {
        probeSignal = signal
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            probeSettled = true
            resolve()
          }, { once: true })
        })
      },
    })
    const started = await flow.start()
    const outcome = await Promise.race([
      (async () => {
        for (let index = 0; index < 100; index += 1) {
          const status = await flow.status(started.flowId)
          if (status.status !== 'pending') return status.status
          await new Promise<void>((resolve) => { setTimeout(resolve, 2) })
        }
        return 'still-pending'
      })(),
      new Promise<string>((resolve) => { setTimeout(() => resolve('deadline-missing'), 100) }),
    ])
    expect(outcome).toBe('timed_out')
    expect(probeSignal?.aborted).toBe(true)
    expect(probeSettled).toBe(true)
    expect(fixture.credentials.keys()).toHaveLength(0)
    expect(fixture.settings.getSnapshot().buddy.currentAccountId).toBeNull()
    await flow.dispose()
  })

  it('显式 cancel 与 root dispose 都实际 abort hung probe 且不写账号', async () => {
    for (const mode of ['cancel', 'dispose'] as const) {
      const fixture = createAccountFixture()
      let probeSignal: AbortSignal | undefined
      let entered!: () => void
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
      const flow = new BuddyAuthFlow({
        store: fixture.store,
        accounts: fixture.service,
        authTimeoutMs: 60_000,
        pollIntervalMs: 1,
        fetcher: async (input: RequestInfo | URL) => {
          const url = String(input)
          if (url.includes('/auth/state')) {
            return json({ code: 0, data: { state: 's', authUrl: 'https://www.codebuddy.cn/login/?state=s' } })
          }
          if (url.includes('/login/account')) {
            return json({ code: 0, data: { uid: 'u', nickname: 'U', enterpriseId: '', type: 'personal' } })
          }
          return json({ code: 0, data: {
            accessToken: 'A', refreshToken: 'R', expiresIn: 3600, tokenType: 'Bearer', domain: 'copilot.tencent.com',
          } })
        },
        verifyCapability: async (_credential, signal) => {
          probeSignal = signal
          entered()
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        },
      })
      const started = await flow.start()
      await enteredPromise
      if (mode === 'cancel') await flow.cancel(started.flowId)
      else await flow.dispose()
      expect(probeSignal?.aborted).toBe(true)
      expect(fixture.credentials.keys()).toHaveLength(0)
      expect(fixture.settings.getSnapshot().buddy.currentAccountId).toBeNull()
      if (mode === 'cancel') await flow.dispose()
    }
  })
})
