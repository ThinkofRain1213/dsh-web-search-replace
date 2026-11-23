/** 账号独立测试：精确 grant、真实能力 verifier、60s/取消与脱敏 RPC。 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AccountCapabilityTester } from '../../src/host/accounts/test.ts'
import { accountRecordKey } from '../../src/host/accounts/store.ts'
import { createChannelCapabilityVerifiers, type ChannelCapabilityVerifiers } from '../../src/host/channels/capability.ts'
import { PluginLifecycle } from '../../src/host/lifecycle.ts'
import { handleManagementRpcRequest } from '../../src/host/rpc.ts'
import { CHANNEL_IDS, type ChannelId } from '../../src/shared/channels.ts'
import { MANAGEMENT_RPC_ENDPOINT, type RpcResult } from '../../src/shared/rpc.ts'
import type { AccountSummary } from '../../src/shared/accounts.ts'
import { createAccountFixture, type AccountFixture } from './support/account-fixture.ts'

const TOKEN = 'ACCOUNT_TEST_TOKEN_SECRET_51d0'
const REFRESH = 'ACCOUNT_TEST_REFRESH_SECRET_51d0'
const MACHINE = 'ACCOUNT_TEST_MACHINE_SECRET_51d0'
const UID = 'ACCOUNT_TEST_UID_SECRET_51d0'
const SECRETS = [TOKEN, REFRESH, MACHINE, UID]
const SUMMARY_KEYS = ['channelId', 'displayName', 'endpointLabel', 'id', 'maskedIdentifier', 'status']
const EXPECTED_URL: Readonly<Record<ChannelId, string>> = {
  buddy: 'https://copilot.tencent.com/agenttool/v1/search',
  workbuddy: 'https://www.workbuddy.ai/agenttool/v1/search',
  qoder: 'https://center.qoder.sh/algo/api/v1/webSearch/oneSearch?Encode=1',
  qodercn: 'https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=1',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail })
  return { promise, resolve, reject }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function saveAccount(fixture: AccountFixture, channel: ChannelId, vendor = `${channel}@example.test`) {
  return fixture.store.saveAccount(channel === 'buddy' || channel === 'workbuddy'
    ? {
        channel,
        vendorAccountId: vendor,
        displayName: `${channel} safe display`,
        secret: { accessToken: TOKEN, refreshToken: REFRESH },
      }
    : {
        channel,
        vendorAccountId: vendor,
        displayName: `${channel} safe display`,
        secret: {
          securityOauthToken: TOKEN,
          machineId: MACHINE,
          uid: UID,
          refreshToken: REFRESH,
          pkceVerifier: 'ACCOUNT_TEST_PKCE_SECRET_51d0',
        },
      })
}

function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value)
  for (const secret of [...SECRETS, 'ACCOUNT_TEST_PKCE_SECRET_51d0']) expect(text).not.toContain(secret)
  expect(text).not.toContain('accessToken')
  expect(text).not.toContain('refreshToken')
  expect(text).not.toContain('securityOauthToken')
  expect(text).not.toContain('machineId')
  expect(text).not.toContain('pkceVerifier')
}

function createHarness(fetcher: typeof fetch, verifiers?: ChannelCapabilityVerifiers) {
  const fixture = createAccountFixture()
  const lifecycle = new PluginLifecycle()
  const tester = new AccountCapabilityTester({
    accounts: fixture.service,
    store: fixture.store,
    verifiers: verifiers ?? createChannelCapabilityVerifiers({
      fetcher,
      getEndpointPreference: () => 'center',
      readLastSuccessfulHost: () => { throw new Error('fixed account test must not read route state') },
    }),
  })
  const call = async (
    payload: unknown,
    caller = new AbortController(),
  ): Promise<RpcResult<unknown>> => {
    const response = await handleManagementRpcRequest(
      fixture.settings,
      new Request('https://host.test/api/web-search-channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'account-test', method: MANAGEMENT_RPC_ENDPOINT,
          payload: { method: 'accounts.test', payload },
        }),
        signal: caller.signal,
      }),
      fixture.service,
      undefined,
      { lifecycle, accountTester: tester },
    )
    const body = await response.json() as { result: RpcResult<unknown> }
    return body.result
  }
  return { fixture, lifecycle, tester, call }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('accounts.test 四渠道真实 verifier', () => {
  it.each(CHANNEL_IDS)('%s 成功只更新被测账号为 ready，返回六字段 DTO 且不切换当前账号', async (channel) => {
    const urls: string[] = []
    const harness = createHarness(async (input) => {
      urls.push(String(input))
      return channel === 'buddy' || channel === 'workbuddy'
        ? json({ results: [{ url: 'https://probe.test/tencent' }] })
        : json({ pageItems: [{ link: 'https://probe.test/qoder' }] })
    })
    const account = await saveAccount(harness.fixture, channel)
    harness.fixture.credentials.reads.length = 0
    const editsBefore = harness.fixture.settingsDouble.edits.length

    const result = await harness.call({ channel, accountId: account.accountId })

    expect(result.ok).toBe(true)
    if (result.ok) {
      const summary = result.value as AccountSummary
      expect(Object.keys(summary).sort()).toEqual(SUMMARY_KEYS)
      expect(summary).toMatchObject({ id: account.accountId, channelId: channel, status: 'ready' })
    }
    expectNoSecrets(result)
    expect(urls).toEqual([EXPECTED_URL[channel]])
    expect(harness.fixture.settingsDouble.edits).toHaveLength(editsBefore)
    expect(harness.fixture.settings.getSnapshot()[channel].currentAccountId).toBeNull()
    expect(harness.fixture.credentials.reads.every(key => key === accountRecordKey(channel, account.accountId))).toBe(true)
    await harness.lifecycle.abortAllAndSettle()
  })

  it.each(CHANNEL_IDS)('%s 明确 HTTP 401 映射 reauth_required，不回显上游正文或秘密', async (channel) => {
    const harness = createHarness(async () => json({ error: `bad ${TOKEN} ${REFRESH} ${UID}` }, 401))
    const account = await saveAccount(harness.fixture, channel)

    const result = await harness.call({ channel, accountId: account.accountId })

    expect(result.ok).toBe(true)
    if (result.ok) expect((result.value as AccountSummary).status).toBe('reauth_required')
    expectNoSecrets(result)
    expect((await harness.fixture.service.list(channel))[0]?.status).toBe('reauth_required')
    await harness.lifecycle.abortAllAndSettle()
  })

  it.each(CHANNEL_IDS)('%s 网络/服务异常映射 temporarily_unavailable，秘密不进入 RPC/error/cause', async (channel) => {
    const harness = createHarness(async () => {
      throw new Error(`offline ${TOKEN} ${REFRESH} ${MACHINE} ${UID}`)
    })
    const account = await saveAccount(harness.fixture, channel)

    const result = await harness.call({ channel, accountId: account.accountId })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.value as AccountSummary).status).toBe('temporarily_unavailable')
      expect(Object.keys(result.value as object).sort()).toEqual(SUMMARY_KEYS)
    }
    expectNoSecrets(result)
    expect((result as { cause?: unknown }).cause).toBeUndefined()
    expect((await harness.fixture.service.list(channel))[0]?.status).toBe('temporarily_unavailable')
    await harness.lifecycle.abortAllAndSettle()
  })
})

describe('accounts.test 记录、渠道与快照边界', () => {
  it('坏记录返回 credential_unavailable，不调用网络也不写状态', async () => {
    let fetchCalls = 0
    const harness = createHarness(async () => { fetchCalls += 1; return json({}) })
    const account = await saveAccount(harness.fixture, 'buddy')
    harness.fixture.credentials.seed(accountRecordKey('buddy', account.accountId), {
      kind: 'grant',
      payload: {
        version: 1, channelId: 'buddy', accountId: account.accountId,
        secret: { accessToken: TOKEN, refreshToken: REFRESH },
      },
    })
    harness.fixture.credentials.writes.length = 0

    const result = await harness.call({ channel: 'buddy', accountId: account.accountId })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toMatchObject({ id: account.accountId, status: 'credential_unavailable' })
      expect(Object.keys(result.value as object).sort()).toEqual(SUMMARY_KEYS)
    }
    expect(fetchCalls).toBe(0)
    expect(harness.fixture.credentials.writes).toEqual([])
    expectNoSecrets(result)
  })

  it.each([
    { name: 'null', payload: null },
    { name: '数组', payload: [] },
    { name: '字符串', payload: 'malformed' },
  ])('非对象 $name payload 返回 accounts/invalid，且不读账号、不发网络', async ({ payload }) => {
    let fetchCalls = 0
    const harness = createHarness(async () => { fetchCalls += 1; return json({}) })
    harness.fixture.credentials.reads.length = 0
    harness.fixture.credentials.writes.length = 0

    const result = await harness.call(payload)

    expect(result).toMatchObject({ ok: false, error: { code: 'accounts/invalid', details: {} } })
    expect(harness.fixture.credentials.reads).toEqual([])
    expect(harness.fixture.credentials.writes).toEqual([])
    expect(fetchCalls).toBe(0)
    expectNoSecrets(result)
  })

  it('错误渠道/不存在账号返回固定错误，不读取或修改其他渠道', async () => {
    const harness = createHarness(async () => { throw new Error('must not fetch') })
    const buddy = await saveAccount(harness.fixture, 'buddy')
    harness.fixture.credentials.reads.length = 0
    const editsBefore = harness.fixture.settingsDouble.edits.length

    const wrongChannel = await harness.call({ channel: 'workbuddy', accountId: buddy.accountId })
    const missing = await harness.call({ channel: 'buddy', accountId: 'a0123456789ab' })
    const invalid = await harness.call({ channel: 'deepseek', accountId: buddy.accountId })

    expect(wrongChannel).toMatchObject({ ok: false, error: { code: 'accounts/not-found', details: {} } })
    expect(missing).toMatchObject({ ok: false, error: { code: 'accounts/not-found', details: {} } })
    expect(invalid).toMatchObject({ ok: false, error: { code: 'accounts/invalid', details: {} } })
    expect(harness.fixture.credentials.reads).toEqual([
      accountRecordKey('workbuddy', buddy.accountId),
      accountRecordKey('buddy', 'a0123456789ab'),
    ])
    expect(harness.fixture.settingsDouble.edits).toHaveLength(editsBefore)
    expect((await harness.fixture.service.list('buddy'))[0]?.status).toBe('ready')
    expectNoSecrets([wrongChannel, missing, invalid])
  })

  it('测试非当前账号不会切换 current，也不会改其他账号状态', async () => {
    const harness = createHarness(async () => json({ error: 'unauthorized' }, 401))
    const current = await saveAccount(harness.fixture, 'buddy', 'current@example.test')
    const alternative = await saveAccount(harness.fixture, 'buddy', 'alternative@example.test')
    await harness.fixture.service.setCurrent('buddy', current.accountId)

    const result = await harness.call({ channel: 'buddy', accountId: alternative.accountId })

    expect(result.ok).toBe(true)
    const accounts = await harness.fixture.service.list('buddy')
    expect(accounts.find(account => account.id === current.accountId)?.status).toBe('ready')
    expect(accounts.find(account => account.id === alternative.accountId)?.status).toBe('reauth_required')
    expect((await harness.fixture.service.getCurrent('buddy'))?.id).toBe(current.accountId)
    expect(harness.fixture.settings.getSnapshot().buddy.currentAccountId).toBe(current.accountId)
  })

  it('测试期间重新登录后，迟到网络错误不覆盖新 grant 或新 ready 状态', async () => {
    const probe = deferred<void>()
    const verifiers = {
      buddy: vi.fn(async () => { await probe.promise; throw new Error(`late ${TOKEN}`) }),
      workbuddy: vi.fn(async () => {}),
      qoder: vi.fn(async () => {}),
      qodercn: vi.fn(async () => {}),
    } as unknown as ChannelCapabilityVerifiers
    const harness = createHarness(async () => { throw new Error('unused') }, verifiers)
    const account = await saveAccount(harness.fixture, 'buddy')

    const running = harness.call({ channel: 'buddy', accountId: account.accountId })
    await Promise.resolve()
    await harness.fixture.store.saveAccount({
      channel: 'buddy', vendorAccountId: 'buddy@example.test', status: 'ready',
      secret: { accessToken: 'NEW_ACCESS_UNRETURNED', refreshToken: 'NEW_REFRESH_UNRETURNED' },
    })
    probe.resolve()
    const result = await running

    expect(result.ok).toBe(true)
    if (result.ok) expect((result.value as AccountSummary).status).toBe('ready')
    const current = await harness.fixture.store.readEntry('buddy', account.accountId)
    expect(current?.account?.secret).toMatchObject({
      accessToken: 'NEW_ACCESS_UNRETURNED', refreshToken: 'NEW_REFRESH_UNRETURNED',
    })
    expect(JSON.stringify(result)).not.toContain('NEW_ACCESS_UNRETURNED')
    expect(JSON.stringify(result)).not.toContain('NEW_REFRESH_UNRETURNED')
  })

  it('凭据存储错误使用固定 RPC 错误，秘密不进入 message/details/cause', async () => {
    const harness = createHarness(async () => { throw new Error('must not fetch') })
    const account = await saveAccount(harness.fixture, 'buddy')
    harness.fixture.credentials.failNextRead = new Error(`store failed ${TOKEN} ${REFRESH}`)

    const result = await harness.call({ channel: 'buddy', accountId: account.accountId })

    expect(result).toMatchObject({ ok: false, error: { code: 'accounts/storage-failed', details: {} } })
    expectNoSecrets(result)
    expect((result as { cause?: unknown }).cause).toBeUndefined()
  })
})

describe('accounts.test deadline、caller cancel 与 root dispose', () => {
  it('60s deadline 实际 abort verifier，最终为 temporarily_unavailable', async () => {
    vi.useFakeTimers()
    const entered = deferred<void>()
    let probeSignal: AbortSignal | undefined
    const verifiers = {
      buddy: async (_credential: unknown, signal: AbortSignal) => {
        probeSignal = signal
        entered.resolve()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
        })
      },
      workbuddy: async () => {}, qoder: async () => {}, qodercn: async () => {},
    } as unknown as ChannelCapabilityVerifiers
    const harness = createHarness(async () => { throw new Error('unused') }, verifiers)
    const account = await saveAccount(harness.fixture, 'buddy')

    const running = harness.call({ channel: 'buddy', accountId: account.accountId })
    await entered.promise
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await running

    expect(probeSignal?.aborted).toBe(true)
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.value as AccountSummary).status).toBe('temporarily_unavailable')
  })

  it('caller abort 实际中止 verifier，不写最终状态', async () => {
    const entered = deferred<void>()
    let probeSignal: AbortSignal | null | undefined
    const harness = createHarness(async (_input, init) => {
      probeSignal = init?.signal
      entered.resolve()
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason) }, { once: true })
      })
    })
    const account = await saveAccount(harness.fixture, 'buddy')
    const caller = new AbortController()

    const running = harness.call({ channel: 'buddy', accountId: account.accountId }, caller)
    await entered.promise
    caller.abort(new DOMException(`cancel ${TOKEN}`, 'AbortError'))
    const result = await running

    expect(probeSignal?.aborted).toBe(true)
    expect(result).toMatchObject({ ok: false, error: { code: 'accounts/cancelled', details: {} } })
    expect((await harness.fixture.service.list('buddy'))[0]?.status).toBe('ready')
    expectNoSecrets(result)
    await harness.lifecycle.abortAllAndSettle()
  })

  it('root dispose 实际 abort 并等待 verifier settle，无迟到状态写入', async () => {
    const entered = deferred<void>()
    let probeSignal: AbortSignal | null | undefined
    let settled = false
    const harness = createHarness(async (_input, init) => {
      probeSignal = init?.signal
      entered.resolve()
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          settled = true
          reject(init.signal?.reason)
        }, { once: true })
      })
    })
    const account = await saveAccount(harness.fixture, 'buddy')

    const running = harness.call({ channel: 'buddy', accountId: account.accountId })
    await entered.promise
    const disposing = harness.lifecycle.abortAllAndSettle()
    const result = await running
    await disposing

    expect(probeSignal?.aborted).toBe(true)
    expect(settled).toBe(true)
    expect(result.ok).toBe(false)
    expect((await harness.fixture.service.list('buddy'))[0]?.status).toBe('ready')
    expectNoSecrets(result)
  })
})
