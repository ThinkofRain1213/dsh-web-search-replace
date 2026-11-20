/** R37：activation drivers + invocation snapshot + 每 HTTP attempt 独立 retry。 */
import { describe, expect, it } from 'vitest'

import * as bindings from '../../src/host/accounts/bindings.ts'
import { BuddyAuthFlow } from '../../src/host/channels/buddy/auth.ts'
import { QoderInternationalAuthFlow } from '../../src/host/channels/qoder/auth.ts'
import { QoderCnAuthFlow } from '../../src/host/channels/qodercn/auth.ts'
import { WorkbuddyAuthFlow } from '../../src/host/channels/workbuddy/auth.ts'
import type { AccountStore } from '../../src/host/accounts/store.ts'
import type { ChannelId } from '../../src/shared/channels.ts'
import { createAccountFixture } from './support/account-fixture.ts'

const CENTER = 'center.qoder.sh'
const API2 = 'api2.qoder.sh'
const TENCENT_OK = { results: [{ url: 'https://tencent.test/result' }] }
const QODER_OK = { pageItems: [{ link: 'https://qoder.test/result' }] }

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function createFlows(fixture: ReturnType<typeof createAccountFixture>) {
  const options = {
    store: fixture.store,
    accounts: fixture.service,
    fetcher: async () => { throw new Error('unexpected auth network') },
    verifyCapability: async () => {},
  }
  return {
    buddy: new BuddyAuthFlow(options),
    workbuddy: new WorkbuddyAuthFlow(options),
    qoder: new QoderInternationalAuthFlow(options),
    qodercn: new QoderCnAuthFlow(options),
  }
}

function stubRefresh(
  store: AccountStore,
  flow: { refresh: (accountId: string) => Promise<any> },
  channel: ChannelId,
  nextSecret: (current: Readonly<Record<string, unknown>>) => Record<string, unknown>,
): string[] {
  const calls: string[] = []
  flow.refresh = async (accountId: string) => {
    calls.push(accountId)
    const entry = await store.readEntry(channel, accountId)
    if (entry?.account === undefined) throw new Error('missing fixture account')
    const saved = await store.saveAccount({
      channel,
      vendorAccountId: entry.account.vendorAccountId,
      secret: nextSecret(entry.account.secret),
    })
    return {
      id: saved.accountId,
      displayName: saved.displayName,
      channelId: saved.channelId,
      endpointLabel: saved.endpointLabel,
      status: saved.status,
      maskedIdentifier: saved.maskedIdentifier,
    }
  }
  return calls
}

function makeFactory(deps: Record<string, unknown>): any {
  const create = (bindings as any).createInvocationDriverFactory
  expect(typeof create).toBe('function')
  return create(deps)
}

describe('invocation-bound 四渠道 drivers', () => {
  it('多 query 启动后固定 A；切到 B 只影响新 invocation', async () => {
    const fixture = createAccountFixture()
    const a = await fixture.store.saveAccount({
      channel: 'buddy', vendorAccountId: 'account-a', secret: { accessToken: 'TOKEN_A', refreshToken: 'R_A' },
    })
    const b = await fixture.store.saveAccount({
      channel: 'buddy', vendorAccountId: 'account-b', secret: { accessToken: 'TOKEN_B', refreshToken: 'R_B' },
    })
    const tokens: string[] = []
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      tokens.push(new Headers(init?.headers).get('Authorization') ?? '')
      return json(TENCENT_OK)
    }
    const factory = makeFactory({
      flows: createFlows(fixture),
      fetcher,
      readLastSuccessfulHost: () => null,
      writeLastSuccessfulHost: async () => {},
    })
    const context = {
      channel: 'buddy', accountId: a.accountId, endpointPreference: 'auto', selectionGeneration: 1,
    }
    const driverA = factory.bind(context)
    await fixture.service.setCurrent('buddy', b.accountId)
    await Promise.all([
      driverA.searchOnce('q1', 10, new AbortController().signal),
      driverA.searchOnce('q2', 10, new AbortController().signal),
    ])
    expect(tokens).toEqual(['Bearer TOKEN_A', 'Bearer TOKEN_A'])

    const driverB = factory.bind({ ...context, accountId: b.accountId, selectionGeneration: 2 })
    await driverB.searchOnce('q3', 10, new AbortController().signal)
    expect(tokens).toEqual(['Bearer TOKEN_A', 'Bearer TOKEN_A', 'Bearer TOKEN_B'])
  })

  it('每 query 各自 401 retry；正常兄弟 query 不被重放且 retry 用刷新后的精确 credential', async () => {
    const fixture = createAccountFixture()
    const account = await fixture.store.saveAccount({
      channel: 'buddy', vendorAccountId: 'account-a', secret: { accessToken: 'OLD', refreshToken: 'R0' },
    })
    const flows = createFlows(fixture)
    const refreshes = stubRefresh(fixture.store, flows.buddy, 'buddy', secret => ({
      ...secret, accessToken: 'NEW', refreshToken: 'R1',
    }))
    const calls: Array<{ query: string; token: string }> = []
    let q1Attempts = 0
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string }
      const token = new Headers(init?.headers).get('Authorization') ?? ''
      calls.push({ query: body.query, token })
      if (body.query === 'q1' && ++q1Attempts === 1) return json({ message: 'expired' }, 401)
      return json(TENCENT_OK)
    }
    const driver = makeFactory({ flows, fetcher }).bind({
      channel: 'buddy', accountId: account.accountId, endpointPreference: 'auto', selectionGeneration: 1,
    })
    await Promise.all([
      driver.searchOnce('q1', 10, new AbortController().signal),
      driver.searchOnce('q2', 10, new AbortController().signal),
    ])
    expect(calls.filter(call => call.query === 'q1')).toHaveLength(2)
    expect(calls.filter(call => call.query === 'q2')).toHaveLength(1)
    expect(calls.filter(call => call.query === 'q1')[1]?.token).toBe('Bearer NEW')
    expect(calls.find(call => call.query === 'q2')?.token).toBe('Bearer OLD')
    expect(refreshes).toEqual([account.accountId])
  })

  it('Qoder 每个 host 独立 retry；fallback host 401 不换第三域，持久域跨账号共享', async () => {
    const fixture = createAccountFixture()
    const account = await fixture.store.saveAccount({
      channel: 'qoder',
      vendorAccountId: 'account-a',
      secret: { securityOauthToken: 'OLD', machineId: 'M', refreshToken: 'R0' },
    })
    const flows = createFlows(fixture)
    const refreshes = stubRefresh(fixture.store, flows.qoder, 'qoder', secret => ({
      ...secret, securityOauthToken: 'NEW', refreshToken: 'R1',
    }))
    const hosts: string[] = []
    let api2Attempts = 0
    let persisted: 'center.qoder.sh' | 'api2.qoder.sh' | null = null
    const observations: unknown[] = []
    const fetcher = async (input: RequestInfo | URL) => {
      const host = new URL(String(input)).hostname
      hosts.push(host)
      if (host === CENTER) return json({ message: 'down' }, 503)
      if (++api2Attempts === 1) return json({ message: 'expired' }, 401)
      return json(QODER_OK)
    }
    const factory = makeFactory({
      flows,
      fetcher,
      readLastSuccessfulHost: () => persisted,
      writeLastSuccessfulHost: async (host: typeof persisted) => { persisted = host },
      onObservation: (observation: unknown, context: unknown) => {
        observations.push([observation, context])
      },
    })
    const context = {
      channel: 'qoder', accountId: account.accountId, endpointPreference: 'auto', selectionGeneration: 7,
    }
    await factory.bind(context).searchOnce('q1', 10, new AbortController().signal)
    expect(hosts).toEqual([CENTER, API2, API2])
    expect(refreshes).toEqual([account.accountId])
    expect(persisted).toBe(API2)
    expect(observations).toHaveLength(1)

    const other = await fixture.store.saveAccount({
      channel: 'qoder', vendorAccountId: 'account-b',
      secret: { securityOauthToken: 'B', machineId: 'M_B', refreshToken: 'R_B' },
    })
    await factory.bind({ ...context, accountId: other.accountId, selectionGeneration: 8 })
      .searchOnce('q2', 10, new AbortController().signal)
    expect(hosts.at(-1)).toBe(API2)
  })

  it('Qoder 首 host 连续 401 只 refresh/重试同 host 一次，不跨域', async () => {
    const fixture = createAccountFixture()
    const account = await fixture.store.saveAccount({
      channel: 'qoder', vendorAccountId: 'account-a',
      secret: { securityOauthToken: 'OLD', machineId: 'M', refreshToken: 'R0' },
    })
    const flows = createFlows(fixture)
    const refreshes = stubRefresh(fixture.store, flows.qoder, 'qoder', secret => ({
      ...secret, securityOauthToken: 'NEW', refreshToken: 'R1',
    }))
    const hosts: string[] = []
    const driver = makeFactory({
      flows,
      fetcher: async (input: RequestInfo | URL) => {
        hosts.push(new URL(String(input)).hostname)
        return json({ message: 'expired' }, 401)
      },
    }).bind({ channel: 'qoder', accountId: account.accountId, endpointPreference: 'auto', selectionGeneration: 1 })
    await expect(driver.searchOnce('q', 10, new AbortController().signal)).rejects.toMatchObject({
      code: 'UNAUTHORIZED', httpStatus: 401,
    })
    expect(hosts).toEqual([CENTER, CENTER])
    expect(refreshes).toEqual([account.accountId])
  })

  it('WorkBuddy 与 QoderCN 同样按单次请求 retry，不串渠道', async () => {
    const fixture = createAccountFixture()
    const wb = await fixture.store.saveAccount({
      channel: 'workbuddy', vendorAccountId: 'wb', secret: { accessToken: 'WB_OLD', refreshToken: 'WB_R0' },
    })
    const cn = await fixture.store.saveAccount({
      channel: 'qodercn', vendorAccountId: 'cn',
      secret: { securityOauthToken: 'CN_OLD', machineId: 'CN_M', refreshToken: 'CN_R0' },
    })
    const flows = createFlows(fixture)
    const wbRefresh = stubRefresh(fixture.store, flows.workbuddy, 'workbuddy', secret => ({
      ...secret, accessToken: 'WB_NEW', refreshToken: 'WB_R1',
    }))
    const cnRefresh = stubRefresh(fixture.store, flows.qodercn, 'qodercn', secret => ({
      ...secret, securityOauthToken: 'CN_NEW', refreshToken: 'CN_R1',
    }))
    const urls: string[] = []
    let wbAttempts = 0
    let cnAttempts = 0
    const factory = makeFactory({
      flows,
      fetcher: async (input: RequestInfo | URL) => {
        const url = String(input)
        urls.push(url)
        if (url.includes('workbuddy.ai')) return ++wbAttempts === 1 ? json({}, 401) : json(TENCENT_OK)
        return ++cnAttempts === 1 ? json({}, 401) : json(QODER_OK)
      },
    })
    await factory.bind({ channel: 'workbuddy', accountId: wb.accountId, endpointPreference: 'auto', selectionGeneration: 1 })
      .searchOnce('wb', 10, new AbortController().signal)
    await factory.bind({ channel: 'qodercn', accountId: cn.accountId, endpointPreference: 'auto', selectionGeneration: 1 })
      .searchOnce('cn', 10, new AbortController().signal)
    expect(wbAttempts).toBe(2)
    expect(cnAttempts).toBe(2)
    expect(wbRefresh).toEqual([wb.accountId])
    expect(cnRefresh).toEqual([cn.accountId])
    expect(urls.filter(url => url.includes('copilot.tencent.com'))).toHaveLength(0)
    expect(urls.filter(url => url.includes('gateway.qoder.com.cn'))).toHaveLength(2)
  })
})
