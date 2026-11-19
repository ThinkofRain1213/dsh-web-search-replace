/**
 * Task 9：CodeBuddy 独立 external-link 授权、刷新与重新登录。
 *
 * 所有网络都由脚本化 fetcher 提供，时钟、随机 flowId 与请求超时信号都可注入；
 * 测试不接触真实厂商网络、真实凭据或真实浏览器。断言重点是：
 *
 * - 授权/重新登录只能由显式方法触发，构造不自动启动；
 * - 成功只经 AccountStore 落 buddy grant，首个账号经 AccountService 设为当前；
 * - 取消、超时、dispose 后没有迟到写入；
 * - 刷新按账号单飞，旧刷新不得覆盖新记录；
 * - 只有明确 401/UNAUTHORIZED 才刷新并重试原操作一次；
 * - Client 可见状态只含脱敏 flowId/状态/授权 URL/说明/AccountSummary。
 */
import { describe, expect, it } from 'vitest'

import {
  BuddyAuthFlow,
  BuddyAuthError,
  type BuddyAuthFlowOptions,
} from '../../src/host/channels/buddy/auth.ts'
import { accountRecordKey } from '../../src/host/accounts/store.ts'
import { ChannelSearchError } from '../../src/host/search/errors.ts'
import type { AccountSummary } from '../../src/shared/accounts.ts'
import type { AuthFlowStatus } from '../../src/shared/auth.ts'
import { createAccountFixture, type AccountFixture } from './support/account-fixture.ts'

const AUTH_URL = 'https://www.codebuddy.cn/login/?platform=ide&state=state-abc'
const STATE = 'state-abc'

/** 一次被脚本化 fetcher 记录到的请求。 */
interface FetchCall {
  readonly url: string
  readonly init: RequestInit
}

/** 脚本化路由。 */
interface Route {
  readonly when: (url: string, init: RequestInit) => boolean
  readonly respond: (url: string, init: RequestInit) => Response | Promise<Response>
}

/** 构造 JSON 响应。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 组装一个记录调用顺序的 fetcher；未命中路由返回 404。 */
function createScriptedFetcher(routes: readonly Route[]): {
  readonly fetcher: typeof fetch
  readonly calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const requestInit = init ?? {}
    calls.push({ url, init: requestInit })
    for (const route of routes) {
      if (route.when(url, requestInit)) return await route.respond(url, requestInit)
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { fetcher, calls }
}

/** 默认 auth/state 成功响应。 */
function stateRoute(response?: () => Response | Promise<Response>): Route {
  return {
    when: (url) => url.includes('/v2/plugin/auth/state'),
    respond: response ?? (() => jsonResponse({
      code: 0,
      data: { state: STATE, authUrl: AUTH_URL },
    })),
  }
}

/** token 轮询路由；刷新路径必须排除。 */
function tokenRoute(response: () => Response | Promise<Response>): Route {
  return {
    when: (url) => url.includes('/v2/plugin/auth/token') && !url.includes('/refresh'),
    respond: response,
  }
}

/** 账户轮询路由。 */
function accountRoute(response: () => Response | Promise<Response>): Route {
  return {
    when: (url) => url.includes('/v2/plugin/login/account'),
    respond: response,
  }
}

/** 刷新路由。 */
function refreshRoute(response: () => Response | Promise<Response>): Route {
  return {
    when: (url) => url.includes('/v2/plugin/auth/token/refresh'),
    respond: response,
  }
}

/** 默认令牌数据。 */
function tokenData(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    accessToken: 'ACCESS_1',
    refreshToken: 'REFRESH_1',
    expiresIn: 3600,
    tokenType: 'Bearer',
    domain: 'copilot.tencent.com',
    ...overrides,
  }
}

/** 默认账户数据。 */
function accountData(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    uid: 'user-1',
    nickname: 'Nick One',
    enterpriseId: '',
    type: 'personal',
    ...overrides,
  }
}

/** 成功令牌响应。 */
function okToken(overrides: Readonly<Record<string, unknown>> = {}): Response {
  return jsonResponse({ code: 0, data: tokenData(overrides) })
}

/** 成功账户响应。 */
function okAccount(overrides: Readonly<Record<string, unknown>> = {}): Response {
  return jsonResponse({ code: 0, data: accountData(overrides) })
}

/** 构造一个仅用于身份/展示名解析的假 JWT（不验签）。 */
function fakeJwt(payload: Readonly<Record<string, unknown>>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`
}

/** 一个可手动释放的 Promise。 */
function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** 等待一次真实事件循环，让后台轮询推进。 */
async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/** 等待某个请求出现。 */
async function waitForCall(
  calls: readonly FetchCall[],
  predicate: (call: FetchCall) => boolean,
): Promise<FetchCall> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const call = calls.find(predicate)
    if (call !== undefined) return call
    await new Promise<void>((resolve) => { setTimeout(resolve, 1) })
  }
  throw new Error('expected fetch call did not happen')
}

/** 轮询到终态；不使用真实厂商网络。 */
async function waitForTerminal(flow: BuddyAuthFlow, flowId: string): Promise<AuthFlowStatus> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const status = await flow.status(flowId)
    if (status.status !== 'pending') return status
    await new Promise<void>((resolve) => { setTimeout(resolve, 1) })
  }
  throw new Error('auth flow did not settle')
}

/** 测试夹具：真实 AccountStore/AccountService + 内存 credentials + 假时钟。 */
interface BuddyAuthFixture extends AccountFixture {
  readonly createFlow: (
    fetcher: typeof fetch,
    overrides?: Partial<BuddyAuthFlowOptions>,
  ) => BuddyAuthFlow
  readonly now: () => number
}

function createBuddyAuthFixture(): BuddyAuthFixture {
  const accounts = createAccountFixture()
  let now = 1_000_000
  let nextFlow = 0
  const clock = {
    now: () => now,
    sleep: async (ms: number) => { now += Math.max(1, ms) },
  }
  const createFlow = (
    fetcher: typeof fetch,
    overrides: Partial<BuddyAuthFlowOptions> = {},
  ): BuddyAuthFlow => new BuddyAuthFlow({
    store: accounts.store,
    accounts: accounts.service,
    fetcher,
    clock,
    randomId: () => `flow-${++nextFlow}`,
    pollIntervalMs: 10,
    authTimeoutMs: 60_000,
    requestTimeoutMs: 5_000,
    // 测试不让每个请求挂真实 60s 定时器；取消/超时由流程级 deadline 覆盖。
    timeoutSignal: () => new AbortController().signal,
    ...overrides,
  })
  return { ...accounts, createFlow, now: () => now }
}

/** 预置一个账号；默认 buddy。 */
async function seedAccount(
  fixture: BuddyAuthFixture,
  options: {
    readonly channel?: 'buddy' | 'workbuddy'
    readonly vendor?: string
    readonly accessToken?: string
    readonly refreshToken?: string
  } = {},
) {
  return await fixture.store.saveAccount({
    channel: options.channel ?? 'buddy',
    vendorAccountId: options.vendor ?? 'user-1',
    displayName: 'Seed User',
    secret: {
      accessToken: options.accessToken ?? 'ACCESS_1',
      refreshToken: options.refreshToken ?? 'REFRESH_1',
    },
  })
}

/** 断言 Client 可见对象不含任何令牌/秘密字段或值。 */
function expectNoSecret(value: unknown): void {
  const text = JSON.stringify(value)
  for (const marker of [
    'ACCESS_1',
    'ACCESS_2',
    'REFRESH_1',
    'REFRESH_2',
    'accessToken',
    'refreshToken',
    'secret',
  ]) {
    expect(text).not.toContain(marker)
  }
}

describe('CodeBuddy 授权 URL 与生命周期', () => {
  it('构造时不自动启动；start 返回脱敏 flowId、pending 与授权 URL', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher, calls } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher)
    expect(calls).toHaveLength(0)

    const started = await flow.start()

    expect(started).toEqual({
      flowId: 'flow-1',
      channel: 'buddy',
      status: 'pending',
      authUrl: AUTH_URL,
      displayHint: expect.stringContaining('浏览器'),
      account: null,
      errorCode: null,
    })
    expectNoSecret(started)

    const stateCall = calls[0]
    expect(stateCall?.url).toBe('https://copilot.tencent.com/v2/plugin/auth/state?platform=ide')
    const headers = stateCall?.init.headers as Record<string, string>
    expect(stateCall?.init.method).toBe('POST')
    expect(headers['X-Domain']).toBe('copilot.tencent.com')
    expect(headers['X-No-Authorization']).toBe('true')
    expect(headers['X-No-User-Id']).toBe('true')
    expect(headers['X-No-Enterprise-Id']).toBe('true')
    expect(headers['X-No-Department-Info']).toBe('true')
    expect(headers['User-Agent']).toBe('CodeBuddyIDE/1.106.1')

    const terminal = await waitForTerminal(flow, started.flowId)
    expect(terminal.status).toBe('completed')
  })

  it('auth/state 失败只返回固定安全错误，不创建流程也不写账号', async () => {
    const fixture = createBuddyAuthFixture()
    const sentinel = 'NON_REAL_UPSTREAM_SECRET_SENTINEL'
    const { fetcher } = createScriptedFetcher([
      stateRoute(() => jsonResponse({ code: 500, message: sentinel }, 500)),
    ])
    const flow = fixture.createFlow(fetcher)

    const error = await flow.start().catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(BuddyAuthError)
    expect(error).toMatchObject({ code: 'auth/failed' })
    expect(String((error as Error).message)).not.toContain(sentinel)
    expect(JSON.stringify(error)).not.toContain(sentinel)
    expect(fixture.credentials.writes).toHaveLength(0)
    await expect(flow.status('flow-1')).rejects.toMatchObject({ code: 'auth/flow-not-found' })
  })

  it('轮询遇到一次网络错误后继续，最终成功落码', async () => {
    const fixture = createBuddyAuthFixture()
    let tokenAttempts = 0
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => {
        tokenAttempts += 1
        if (tokenAttempts === 1) throw new Error('network down')
        return okToken()
      }),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('completed')
    expect(tokenAttempts).toBe(2)
    expect(fixture.credentials.writes).toHaveLength(1)
  })

  it('已有活动流程时拒绝第二个 start，取消后不再拒绝', async () => {
    const fixture = createBuddyAuthFixture()
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => gate.promise),
    ])
    const flow = fixture.createFlow(fetcher)

    const first = await flow.start()
    await waitForCall(calls, (call) => call.url.includes('/auth/token'))

    await expect(flow.start()).rejects.toMatchObject({ code: 'auth/flow-active' })

    const cancelling = flow.cancel(first.flowId)
    gate.resolve(okToken())
    const cancelled = await cancelling
    expect(cancelled.status).toBe('cancelled')

    const { fetcher: secondFetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const secondFlow = fixture.createFlow(secondFetcher)
    const second = await secondFlow.start()
    expect(second.status).toBe('pending')
    const terminal = await waitForTerminal(secondFlow, second.flowId)
    expect(terminal.status).toBe('completed')
  })

  it('auth/state 返回非 https 或空 authUrl 时拒绝', async () => {
    const fixture = createBuddyAuthFixture()
    for (const authUrl of ['', 'http://www.codebuddy.cn/login', 'javascript:alert(1)']) {
      const { fetcher } = createScriptedFetcher([
        stateRoute(() => jsonResponse({ code: 0, data: { state: STATE, authUrl } })),
      ])
      const flow = fixture.createFlow(fetcher)
      await expect(flow.start()).rejects.toMatchObject({ code: 'auth/invalid-response' })
      expect(fixture.credentials.writes).toHaveLength(0)
    }
  })
})

describe('CodeBuddy 授权成功落码与当前账号', () => {
  it('轮询成功后只写 buddy grant，首个账号设为当前，状态只含 AccountSummary', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher, calls } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('completed')
    expect(terminal.errorCode).toBeNull()
    expect(terminal.account).toMatchObject({
      channelId: 'buddy',
      displayName: 'Nick One',
      endpointLabel: 'copilot.tencent.com',
      status: 'ready',
      maskedIdentifier: 'u***1',
    })
    expect(terminal.account?.id).toMatch(/^a[0-9a-f]{12}$/)
    expectNoSecret(terminal)

    const accountId = terminal.account!.id
    const entry = await fixture.store.readEntry('buddy', accountId)
    expect(entry?.account).toMatchObject({
      channelId: 'buddy',
      accountId,
      vendorAccountId: 'user-1',
      displayName: 'Nick One',
      status: 'ready',
    })
    expect(entry?.account?.secret).toMatchObject({
      accessToken: 'ACCESS_1',
      refreshToken: 'REFRESH_1',
    })
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(accountId)
    expect(fixture.credentials.writes).toHaveLength(1)
    expect(fixture.credentials.writes[0]).toBe(`dsh-web-search-channels/buddy-${accountId}`)
    expect(fixture.credentials.keys().some((key) => key.includes('workbuddy'))).toBe(false)

    const tokenCall = calls.find((call) => call.url.includes('/auth/token'))
    expect(tokenCall?.url).toContain(`state=${STATE}`)
    const tokenHeaders = tokenCall?.init.headers as Record<string, string>
    expect(tokenHeaders['X-No-Authorization']).toBe('true')
    expect(tokenHeaders['User-Agent']).toBe('CodeBuddyIDE/1.106.1')

    const accountCall = calls.find((call) => call.url.includes('/login/account'))
    expect(accountCall?.url).toContain(`state=${STATE}`)
    const accountHeaders = accountCall?.init.headers as Record<string, string>
    expect(accountHeaders.Authorization).toBe('Bearer ACCESS_1')
    expect(accountHeaders['X-Domain']).toBe('copilot.tencent.com')
    expect(accountHeaders['X-No-User-Id']).toBe('true')
    expect(accountHeaders['X-No-Enterprise-Id']).toBe('true')
    expect(accountHeaders['User-Agent']).toBe('CodeBuddyIDE/1.106.1')
  })

  it('后续账号成功不自动替换当前账号', async () => {
    const fixture = createBuddyAuthFixture()
    const firstFlow = fixture.createFlow(createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ]).fetcher)
    const firstStarted = await firstFlow.start()
    const firstTerminal = await waitForTerminal(firstFlow, firstStarted.flowId)
    const firstId = firstTerminal.account!.id

    const secondFlow = fixture.createFlow(createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken({ accessToken: 'ACCESS_2', refreshToken: 'REFRESH_2' })),
      accountRoute(() => okAccount({ uid: 'user-2', nickname: 'Nick Two' })),
    ]).fetcher)
    const secondStarted = await secondFlow.start()
    const secondTerminal = await waitForTerminal(secondFlow, secondStarted.flowId)

    expect(secondTerminal.status).toBe('completed')
    expect(secondTerminal.account?.id).not.toBe(firstId)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(firstId)
    const accounts = await fixture.store.listEntries('buddy')
    expect(accounts.map((entry) => entry.accountId).sort()).toEqual(
      [firstId, secondTerminal.account!.id].sort(),
    )
  })

  it('账户 uid 为空时回退到 JWT sub 与 JWT 昵称', async () => {
    const fixture = createBuddyAuthFixture()
    const accessToken = fakeJwt({ sub: 'jwt-user', nickname: 'JWT Nick' })
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken({ accessToken })),
      accountRoute(() => okAccount({ uid: '', nickname: '' })),
    ])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('completed')
    expect(terminal.account?.displayName).toBe('JWT Nick')
    const entry = await fixture.store.readEntry('buddy', terminal.account!.id)
    expect(entry?.account?.vendorAccountId).toBe('jwt-user')
  })

  it('账户响应缺少 uid 且令牌不是 JWT 时不落码', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher, calls } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount({ uid: '', nickname: '' })),
    ])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('failed')
    expect(terminal.errorCode).toBe('auth/invalid-response')
    expect(terminal.account).toBeNull()
    expect(calls.some((call) => call.url.includes('/login/account'))).toBe(true)
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
  })
})

describe('CodeBuddy 取消、超时与卸载', () => {
  it('取消后迟到的 token 响应不得写账号或当前账号', async () => {
    const fixture = createBuddyAuthFixture()
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => gate.promise),
    ])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    await waitForCall(calls, (call) => call.url.includes('/auth/token'))

    const cancelling = flow.cancel(started.flowId)
    gate.resolve(okToken())
    const cancelled = await cancelling
    await flush()

    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.errorCode).toBe('auth/cancelled')
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(await fixture.store.listEntries('buddy')).toHaveLength(0)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
    expect((await flow.status(started.flowId)).status).toBe('cancelled')
  })

  it('cancel 对已完成流程幂等返回 completed，不改变已落码账号', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher)
    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    const cancelled = await flow.cancel(started.flowId)

    expect(cancelled.status).toBe('completed')
    expect(cancelled.account).toEqual(terminal.account)
    expect(await fixture.store.listEntries('buddy')).toHaveLength(1)
  })

  it('未知 flowId 的 cancel/status 返回 flow-not-found', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher } = createScriptedFetcher([stateRoute()])
    const flow = fixture.createFlow(fetcher)

    await expect(flow.cancel('flow-404')).rejects.toMatchObject({ code: 'auth/flow-not-found' })
    await expect(flow.status('flow-404')).rejects.toMatchObject({ code: 'auth/flow-not-found' })
  })

  it('轮询超时进入 timed_out 且不写账号', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher, calls } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => jsonResponse({ code: 11217 }, 400)),
    ])
    const flow = fixture.createFlow(fetcher, { authTimeoutMs: 100, pollIntervalMs: 10 })

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('timed_out')
    expect(terminal.errorCode).toBe('auth/timeout')
    expect(calls.filter((call) => call.url.includes('/auth/token')).length).toBeGreaterThan(1)
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
  })

  it('账户轮询超时进入 timed_out 且不写账号', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => jsonResponse({ code: 12151 }, 400)),
    ])
    const flow = fixture.createFlow(fetcher, { authTimeoutMs: 100, pollIntervalMs: 10 })

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('timed_out')
    expect(terminal.errorCode).toBe('auth/timeout')
    expect(fixture.credentials.writes).toHaveLength(0)
  })

  it('dispose 停止轮询、等待 settle，迟到响应不写账号；dispose 后拒绝新任务', async () => {
    const fixture = createBuddyAuthFixture()
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => gate.promise),
    ])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    await waitForCall(calls, (call) => call.url.includes('/auth/token'))

    const disposing = flow.dispose()
    gate.resolve(okToken())
    await disposing
    await flush()

    expect((await flow.status(started.flowId)).status).toBe('cancelled')
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
    await expect(flow.start()).rejects.toMatchObject({ code: 'auth/disposed' })
    await expect(flow.reauthenticate('a000000000000')).rejects.toMatchObject({
      code: 'auth/disposed',
    })
  })

  it('dispose 在 auth/state 在途时也会等待 start settle 且不创建流程', async () => {
    const fixture = createBuddyAuthFixture()
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([
      stateRoute(() => gate.promise),
    ])
    const flow = fixture.createFlow(fetcher)

    const starting = flow.start().catch((error: unknown) => error)
    await waitForCall(calls, (call) => call.url.includes('/auth/state'))

    const disposing = flow.dispose()
    gate.resolve(jsonResponse({ code: 0, data: { state: STATE, authUrl: AUTH_URL } }))
    await disposing
    const error = await starting

    expect(error).toMatchObject({ code: 'auth/disposed' })
    expect(fixture.credentials.writes).toHaveLength(0)
    await expect(flow.status('flow-1')).rejects.toMatchObject({ code: 'auth/flow-not-found' })
  })
})

describe('CodeBuddy 刷新单飞与旧刷新保护', () => {
  it('刷新请求使用 CodeBuddy 产品头与 X-Refresh-Token', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(() => okToken({ accessToken: 'ACCESS_2', refreshToken: 'REFRESH_2' })),
    ])
    const flow = fixture.createFlow(fetcher)

    await flow.refresh(account.accountId)

    const call = calls.find((candidate) => candidate.url.includes('/auth/token/refresh'))
    expect(call?.url).toBe('https://copilot.tencent.com/v2/plugin/auth/token/refresh')
    expect(call?.init.method).toBe('POST')
    const headers = call?.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer ACCESS_1')
    expect(headers['X-Refresh-Token']).toBe('REFRESH_1')
    expect(headers['X-Auth-Refresh-Source']).toBe('ide-main')
    expect(headers['X-Domain']).toBe('copilot.tencent.com')
    expect(headers['User-Agent']).toBe('CodeBuddyIDE/1.106.1')
  })

  it('并发刷新同一账号只发一次网络请求，双方拿到同一 AccountSummary', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const gate = deferred<void>()
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(async () => {
        await gate.promise
        return okToken({ accessToken: 'ACCESS_2', refreshToken: 'REFRESH_2' })
      }),
    ])
    const flow = fixture.createFlow(fetcher)

    const first = flow.refresh(account.accountId)
    const second = flow.refresh(account.accountId)
    await waitForCall(calls, (call) => call.url.includes('/auth/token/refresh'))
    gate.resolve()

    const [left, right] = await Promise.all([first, second])
    expect(left).toEqual(right)
    expect(left.id).toBe(account.accountId)
    expect(calls.filter((call) => call.url.includes('/auth/token/refresh'))).toHaveLength(1)

    const stored = await fixture.store.readEntry('buddy', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'ACCESS_2',
      refreshToken: 'REFRESH_2',
    })
    expect(stored?.account?.status).toBe('ready')
  })

  it('旧刷新迟到时以 modifyRecord 当前记录为准，不覆盖新 refreshToken', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => gate.promise)])
    const flow = fixture.createFlow(fetcher)

    const refreshing = flow.refresh(account.accountId)
    await waitForCall(calls, (call) => call.url.includes('/auth/token/refresh'))

    await fixture.store.saveAccount({
      channel: 'buddy',
      vendorAccountId: 'user-1',
      secret: { accessToken: 'ACCESS_NEW', refreshToken: 'REFRESH_NEW' },
    })
    gate.resolve(okToken({ accessToken: 'ACCESS_2', refreshToken: 'REFRESH_2' }))
    const summary = await refreshing

    expect(summary.id).toBe(account.accountId)
    const stored = await fixture.store.readEntry('buddy', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'ACCESS_NEW',
      refreshToken: 'REFRESH_NEW',
    })
  })

  it('刷新明确 401 时标记 reauth_required、抛固定错误且不重试', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const sentinel = 'NON_REAL_REFRESH_SECRET_SENTINEL'
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(() => jsonResponse({ code: 401, message: sentinel }, 401)),
    ])
    const flow = fixture.createFlow(fetcher)

    const error = await flow.refresh(account.accountId).catch((failure: unknown) => failure)

    expect(error).toMatchObject({ code: 'auth/reauth-required' })
    expect(String((error as Error).message)).not.toContain(sentinel)
    expect(JSON.stringify(error)).not.toContain(sentinel)
    expect(calls.filter((call) => call.url.includes('/auth/token/refresh'))).toHaveLength(1)
    const stored = await fixture.store.readEntry('buddy', account.accountId)
    expect(stored?.account?.status).toBe('reauth_required')
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'ACCESS_1',
      refreshToken: 'REFRESH_1',
    })
  })

  it('刷新暂时失败标记 temporarily_unavailable、不写秘密且不重试', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(() => jsonResponse({ code: 502, message: 'upstream down' }, 502)),
    ])
    const flow = fixture.createFlow(fetcher)

    await expect(flow.refresh(account.accountId)).rejects.toMatchObject({
      code: 'auth/refresh-failed',
    })

    expect(calls.filter((call) => call.url.includes('/auth/token/refresh'))).toHaveLength(1)
    const stored = await fixture.store.readEntry('buddy', account.accountId)
    expect(stored?.account?.status).toBe('temporarily_unavailable')
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'ACCESS_1',
      refreshToken: 'REFRESH_1',
    })
  })

  it('无 refreshToken 直接进入 reauth_required 且不发网络', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture, { refreshToken: '' })
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)

    await expect(flow.refresh(account.accountId)).rejects.toMatchObject({
      code: 'auth/reauth-required',
    })
    expect(calls).toHaveLength(0)
    const stored = await fixture.store.readEntry('buddy', account.accountId)
    expect(stored?.account?.status).toBe('reauth_required')
  })

  it('刷新响应未下发新 refreshToken 时保留旧 refreshToken', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher } = createScriptedFetcher([
      refreshRoute(() => okToken({ accessToken: 'ACCESS_2', refreshToken: '' })),
    ])
    const flow = fixture.createFlow(fetcher)

    const summary = await flow.refresh(account.accountId)

    expect(summary.id).toBe(account.accountId)
    const stored = await fixture.store.readEntry('buddy', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'ACCESS_2',
      refreshToken: 'REFRESH_1',
    })
  })

  it('刷新不存在或跨渠道账号返回 account-not-found，且不触碰 WorkBuddy 记录', async () => {
    const fixture = createBuddyAuthFixture()
    const workbuddy = await seedAccount(fixture, {
      channel: 'workbuddy',
      vendor: 'work-user',
      accessToken: 'WB_ACCESS',
      refreshToken: 'WB_REFRESH',
    })
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)

    await expect(flow.refresh(workbuddy.accountId)).rejects.toMatchObject({
      code: 'auth/account-not-found',
    })
    expect(calls).toHaveLength(0)
    const stored = await fixture.store.readEntry('workbuddy', workbuddy.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'WB_ACCESS',
      refreshToken: 'WB_REFRESH',
    })
  })

  it('刷新响应畸形时保持原秘密，不写入空令牌', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher } = createScriptedFetcher([
      refreshRoute(() => jsonResponse({ code: 0, data: {} })),
    ])
    const flow = fixture.createFlow(fetcher)

    await expect(flow.refresh(account.accountId)).rejects.toMatchObject({
      code: 'auth/refresh-failed',
    })
    const stored = await fixture.store.readEntry('buddy', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'ACCESS_1',
      refreshToken: 'REFRESH_1',
    })
  })

  it('dispose 取消在飞刷新并等待 settle，迟到响应不写凭据', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => gate.promise)])
    const flow = fixture.createFlow(fetcher)

    const refreshing = flow.refresh(account.accountId).catch((error: unknown) => error)
    await waitForCall(calls, (call) => call.url.includes('/auth/token/refresh'))

    const disposing = flow.dispose()
    gate.resolve(okToken({ accessToken: 'ACCESS_2', refreshToken: 'REFRESH_2' }))
    await disposing
    const error = await refreshing

    expect(error).toMatchObject({ code: 'auth/disposed' })
    const stored = await fixture.store.readEntry('buddy', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'ACCESS_1',
      refreshToken: 'REFRESH_1',
    })
    await expect(flow.refresh(account.accountId)).rejects.toMatchObject({
      code: 'auth/disposed',
    })
  })
})

describe('CodeBuddy 401 同账号重试一次', () => {
  it('明确 UNAUTHORIZED 时刷新同一账号并重试原操作一次', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(() => okToken({ accessToken: 'ACCESS_2', refreshToken: 'REFRESH_2' })),
    ])
    const flow = fixture.createFlow(fetcher)
    const seen: string[] = []
    let attempts = 0

    const result = await flow.runWithAuthRetry(account.accountId, async (credential) => {
      expect(credential.channelId).toBe('buddy')
      expect(credential.accountId).toBe(account.accountId)
      seen.push(credential.accessToken)
      attempts += 1
      if (attempts === 1) throw new ChannelSearchError('UNAUTHORIZED', 'buddy', 'upstream 401')
      return 'search-ok'
    })

    expect(result).toBe('search-ok')
    expect(seen).toEqual(['ACCESS_1', 'ACCESS_2'])
    expect(calls.filter((call) => call.url.includes('/auth/token/refresh'))).toHaveLength(1)
    const stored = await fixture.store.readEntry('buddy', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'ACCESS_2',
      refreshToken: 'REFRESH_2',
    })
  })

  it('非 401 错误不刷新、不重试', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)
    const timeoutError = new ChannelSearchError('TIMEOUT', 'buddy', 'upstream timeout')
    let attempts = 0

    const error = await flow.runWithAuthRetry(account.accountId, async () => {
      attempts += 1
      throw timeoutError
    }).catch((failure: unknown) => failure)

    expect(error).toBe(timeoutError)
    expect(attempts).toBe(1)
    expect(calls).toHaveLength(0)
  })

  it('跨渠道 UNAUTHORIZED 不刷新、不重试', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)
    const foreign = new ChannelSearchError('UNAUTHORIZED', 'workbuddy', 'foreign 401')
    let attempts = 0

    const error = await flow.runWithAuthRetry(account.accountId, async () => {
      attempts += 1
      throw foreign
    }).catch((failure: unknown) => failure)

    expect(error).toBe(foreign)
    expect(attempts).toBe(1)
    expect(calls).toHaveLength(0)
  })

  it('重试仍 401 时不再刷新，原操作最多两次', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(() => okToken({ accessToken: 'ACCESS_2', refreshToken: 'REFRESH_2' })),
    ])
    const flow = fixture.createFlow(fetcher)
    let attempts = 0

    await expect(flow.runWithAuthRetry(account.accountId, async () => {
      attempts += 1
      throw new ChannelSearchError('UNAUTHORIZED', 'buddy', 'still 401')
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    expect(attempts).toBe(2)
    expect(calls.filter((call) => call.url.includes('/auth/token/refresh'))).toHaveLength(1)
  })

  it('并发 401 共享同一账号单飞刷新', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const gate = deferred<void>()
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(async () => {
        await gate.promise
        return okToken({ accessToken: 'ACCESS_2', refreshToken: 'REFRESH_2' })
      }),
    ])
    const flow = fixture.createFlow(fetcher)
    const makeOperation = () => {
      let attempts = 0
      return async (credential: { readonly accessToken: string }) => {
        attempts += 1
        if (attempts === 1) throw new ChannelSearchError('UNAUTHORIZED', 'buddy', 'concurrent 401')
        return credential.accessToken
      }
    }

    const first = flow.runWithAuthRetry(account.accountId, makeOperation())
    const second = flow.runWithAuthRetry(account.accountId, makeOperation())
    await waitForCall(calls, (call) => call.url.includes('/auth/token/refresh'))
    gate.resolve()

    expect(await Promise.all([first, second])).toEqual(['ACCESS_2', 'ACCESS_2'])
    expect(calls.filter((call) => call.url.includes('/auth/token/refresh'))).toHaveLength(1)
  })

  it('刷新失败时不重试原操作', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher } = createScriptedFetcher([
      refreshRoute(() => jsonResponse({ code: 401, message: 'expired' }, 401)),
    ])
    const flow = fixture.createFlow(fetcher)
    let attempts = 0

    await expect(flow.runWithAuthRetry(account.accountId, async () => {
      attempts += 1
      throw new ChannelSearchError('UNAUTHORIZED', 'buddy', '401')
    })).rejects.toMatchObject({ code: 'auth/reauth-required' })

    expect(attempts).toBe(1)
  })
})

describe('CodeBuddy 重新登录', () => {
  it('同渠道同厂商身份复用账号 ID、更新秘密并保持当前账号', async () => {
    const fixture = createBuddyAuthFixture()
    const firstFlow = fixture.createFlow(createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ]).fetcher)
    const firstStarted = await firstFlow.start()
    const firstTerminal = await waitForTerminal(firstFlow, firstStarted.flowId)
    const accountId = firstTerminal.account!.id

    const reauthFlow = fixture.createFlow(createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken({ accessToken: 'ACCESS_2', refreshToken: 'REFRESH_2' })),
      accountRoute(() => okAccount({ nickname: 'Nick Updated' })),
    ]).fetcher)
    const started = await reauthFlow.reauthenticate(accountId)
    const terminal = await waitForTerminal(reauthFlow, started.flowId)

    expect(terminal.status).toBe('completed')
    expect(terminal.account?.id).toBe(accountId)
    expect(terminal.account?.displayName).toBe('Nick Updated')
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(accountId)
    const entries = await fixture.store.listEntries('buddy')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.account?.secret).toMatchObject({
      accessToken: 'ACCESS_2',
      refreshToken: 'REFRESH_2',
    })
  })

  it('重新登录身份不一致时失败且不覆盖原账号', async () => {
    const fixture = createBuddyAuthFixture()
    const firstFlow = fixture.createFlow(createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ]).fetcher)
    const firstStarted = await firstFlow.start()
    const firstTerminal = await waitForTerminal(firstFlow, firstStarted.flowId)
    const accountId = firstTerminal.account!.id

    const reauthFlow = fixture.createFlow(createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken({ accessToken: 'ACCESS_2', refreshToken: 'REFRESH_2' })),
      accountRoute(() => okAccount({ uid: 'user-2', nickname: 'Other User' })),
    ]).fetcher)
    const started = await reauthFlow.reauthenticate(accountId)
    const terminal = await waitForTerminal(reauthFlow, started.flowId)

    expect(terminal.status).toBe('failed')
    expect(terminal.errorCode).toBe('auth/identity-mismatch')
    expect(terminal.account).toBeNull()
    const entries = await fixture.store.listEntries('buddy')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.account?.secret).toMatchObject({
      accessToken: 'ACCESS_1',
      refreshToken: 'REFRESH_1',
    })
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(accountId)
  })

  it('重新登录不存在的账号时不发任何网络请求', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher, calls } = createScriptedFetcher([stateRoute()])
    const flow = fixture.createFlow(fetcher)

    await expect(flow.reauthenticate('a000000000000')).rejects.toMatchObject({
      code: 'auth/account-not-found',
    })
    expect(calls).toHaveLength(0)
    expect(fixture.credentials.writes).toHaveLength(0)
  })

  it('重新登录非当前账号不会替换当前账号', async () => {
    const fixture = createBuddyAuthFixture()
    const firstFlow = fixture.createFlow(createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ]).fetcher)
    const firstStarted = await firstFlow.start()
    const firstTerminal = await waitForTerminal(firstFlow, firstStarted.flowId)
    const firstId = firstTerminal.account!.id

    const secondFlow = fixture.createFlow(createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken({ accessToken: 'ACCESS_2', refreshToken: 'REFRESH_2' })),
      accountRoute(() => okAccount({ uid: 'user-2', nickname: 'Nick Two' })),
    ]).fetcher)
    const secondStarted = await secondFlow.start()
    const secondTerminal = await waitForTerminal(secondFlow, secondStarted.flowId)
    const secondId = secondTerminal.account!.id

    const reauthFlow = fixture.createFlow(createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken({ accessToken: 'ACCESS_3', refreshToken: 'REFRESH_3' })),
      accountRoute(() => okAccount({ uid: 'user-2', nickname: 'Nick Two Updated' })),
    ]).fetcher)
    const started = await reauthFlow.reauthenticate(secondId)
    const terminal = await waitForTerminal(reauthFlow, started.flowId)

    expect(terminal.status).toBe('completed')
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(firstId)
  })
})

describe('CodeBuddy 安全边界与畸形响应', () => {
  it('token/account 上游错误正文不进入状态或错误对象', async () => {
    const fixture = createBuddyAuthFixture()
    const sentinel = 'NON_REAL_TOKEN_BODY_SENTINEL'
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => jsonResponse({ code: 500, message: sentinel }, 500)),
    ])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('failed')
    expect(terminal.errorCode).toBe('auth/failed')
    expect(JSON.stringify(terminal)).not.toContain(sentinel)
    expect(fixture.credentials.writes).toHaveLength(0)
  })

  it('token 200 但缺少 accessToken 时失败且不落码', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher, calls } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => jsonResponse({ code: 0, data: { refreshToken: 'REFRESH_X' } })),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('failed')
    expect(terminal.errorCode).toBe('auth/invalid-response')
    expect(calls.some((call) => call.url.includes('/login/account'))).toBe(false)
    expect(fixture.credentials.writes).toHaveLength(0)
  })

  it('account 非 200 时失败且不落码', async () => {
    const fixture = createBuddyAuthFixture()
    const sentinel = 'NON_REAL_ACCOUNT_BODY_SENTINEL'
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => jsonResponse({ code: 500, message: sentinel }, 500)),
    ])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('failed')
    expect(terminal.errorCode).toBe('auth/failed')
    expect(JSON.stringify(terminal)).not.toContain(sentinel)
    expect(fixture.credentials.writes).toHaveLength(0)
  })

  it('状态 DTO 只有七个脱敏字段', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher)
    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(Object.keys(terminal).sort()).toEqual([
      'account',
      'authUrl',
      'channel',
      'displayHint',
      'errorCode',
      'flowId',
      'status',
    ])
    expect(Object.keys(terminal.account!).sort()).toEqual([
      'channelId',
      'displayName',
      'endpointLabel',
      'id',
      'maskedIdentifier',
      'status',
    ])
  })

  it('buddy key 下的跨渠道伪造记录不会被覆盖', async () => {
    const fixture = createBuddyAuthFixture()
    const existing = await seedAccount(fixture)
    const key = accountRecordKey('buddy', existing.accountId)
    fixture.credentials.seed(key, {
      kind: 'grant',
      payload: {
        version: 1,
        channelId: 'workbuddy',
        accountId: existing.accountId,
        vendorAccountId: 'user-1',
        displayName: 'Forged WorkBuddy',
        maskedIdentifier: 'u***1',
        endpointLabel: 'www.workbuddy.ai',
        status: 'ready',
        secret: { accessToken: 'FORGED_ACCESS', refreshToken: 'FORGED_REFRESH' },
      },
    })
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('failed')
    expect(terminal.errorCode).toBe('auth/failed')
    expect(terminal.account).toBeNull()
    const forged = fixture.credentials.raw(key)
    expect((forged?.payload as Record<string, unknown>).channelId).toBe('workbuddy')
    expect(
      ((forged?.payload as Record<string, unknown>).secret as Record<string, unknown>).accessToken,
    ).toBe('FORGED_ACCESS')
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
  })

  it('状态中的 AccountSummary 类型可直接赋给共享 DTO', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher)
    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)
    const summary: AccountSummary = terminal.account!
    expect(summary.channelId).toBe('buddy')
  })
})
