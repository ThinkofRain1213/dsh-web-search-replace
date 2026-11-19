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
  type BuddyCapabilityCredential,
} from '../../src/host/channels/buddy/auth.ts'
import { accountRecordKey } from '../../src/host/accounts/store.ts'
import { ChannelSearchError, normalizeChannelSearchError } from '../../src/host/search/errors.ts'
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

/**
 * 模拟真实 fetch 的跨源重定向跟随：只有 `redirect:'error'` 才拒绝；
 * 其他设置会把同一请求（含原始头）发到 evil 目标。用于证明控制面请求
 * 不会把秘密转发给重定向目标。
 */
function createRedirectGuardFetcher(
  stage: 'state' | 'token' | 'account' | 'refresh',
  redirectTarget = 'https://evil.example/collect',
): { readonly fetcher: typeof fetch; readonly calls: FetchCall[] } {
  const calls: FetchCall[] = []
  async function follow(init: RequestInit): Promise<Response> {
    if (init.redirect === 'error') throw new TypeError('fetch failed: redirect mode is error')
    return await fetcher(redirectTarget, init)
  }
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const requestInit = init ?? {}
    calls.push({ url, init: requestInit })
    if (url.includes('evil.example')) return new Response('leaked', { status: 200 })
    if (stage === 'state' && url.includes('/v2/plugin/auth/state')) return await follow(requestInit)
    if (stage === 'token' && url.includes('/v2/plugin/auth/token') && !url.includes('/refresh')) {
      return await follow(requestInit)
    }
    if (stage === 'account' && url.includes('/v2/plugin/login/account')) {
      return await follow(requestInit)
    }
    if (stage === 'refresh' && url.includes('/v2/plugin/auth/token/refresh')) {
      return await follow(requestInit)
    }
    if (url.includes('/v2/plugin/auth/state')) {
      return jsonResponse({ code: 0, data: { state: STATE, authUrl: AUTH_URL } })
    }
    if (url.includes('/v2/plugin/auth/token') && !url.includes('/refresh')) return okToken()
    if (url.includes('/v2/plugin/login/account')) return okAccount()
    if (url.includes('/v2/plugin/auth/token/refresh')) {
      return okToken({ accessToken: 'ACCESS_2', refreshToken: 'REFRESH_2' })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { fetcher, calls }
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
    verifyCapability: async () => { /* 默认能力探测成功；需要失败/延迟的用例显式覆盖 */ },
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

  it('auth/state 只接受精确 CodeBuddy host 的 https authUrl', async () => {
    const fixture = createBuddyAuthFixture()
    const malicious = [
      '',
      'http://www.codebuddy.cn/login',
      'javascript:alert(1)',
      'https://evil.example/login',
      'https://codebuddy.cn.evil.example/login',
      'https://www.codebuddy.cn.evil.example/login',
      'https://www.codebuddy.cn:444/login',
      'https://user:pass@www.codebuddy.cn/login',
      'https://www.codebuddy.cn/login#@evil.example',
    ]
    for (const authUrl of malicious) {
      const { fetcher } = createScriptedFetcher([
        stateRoute(() => jsonResponse({ code: 0, data: { state: STATE, authUrl } })),
      ])
      const flow = fixture.createFlow(fetcher)
      const started = await flow.start().then(
        (status) => status,
        (error: unknown) => error,
      )
      if (!(started instanceof Error)) await flow.dispose()
      expect(started, authUrl).toMatchObject({ code: 'auth/invalid-response' })
      expect(fixture.credentials.writes).toHaveLength(0)
    }
  })

  it('auth/state 接受 copilot.tencent.com 的精确 https authUrl', async () => {
    const fixture = createBuddyAuthFixture()
    const copilotAuthUrl = 'https://copilot.tencent.com/login?platform=ide&state=state-abc'
    const { fetcher } = createScriptedFetcher([
      stateRoute(() => jsonResponse({
        code: 0,
        data: { state: STATE, authUrl: copilotAuthUrl },
      })),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    expect(started.authUrl).toBe(copilotAuthUrl)
    const terminal = await waitForTerminal(flow, started.flowId)
    expect(terminal.status).toBe('completed')
  })
})

describe('CodeBuddy 控制面重定向与秘密边界', () => {
  it('auth/state 跨源 302 不跟随，秘密不出源', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher, calls } = createRedirectGuardFetcher('state')
    const flow = fixture.createFlow(fetcher)

    const error = await flow.start().catch((failure: unknown) => failure)

    expect(error).toMatchObject({ code: 'auth/failed' })
    expect(calls.filter((call) => call.url.includes('evil.example'))).toHaveLength(0)
    expect(fixture.credentials.writes).toHaveLength(0)
  })

  it('token 轮询跨源 302 不跟随，秘密不出源', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher, calls } = createRedirectGuardFetcher('token')
    const flow = fixture.createFlow(fetcher, { authTimeoutMs: 50, pollIntervalMs: 10 })

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('timed_out')
    expect(calls.filter((call) => call.url.includes('evil.example'))).toHaveLength(0)
    expect(fixture.credentials.writes).toHaveLength(0)
  })

  it('account 轮询跨源 302 不跟随，Authorization 不出源', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher, calls } = createRedirectGuardFetcher('account')
    const flow = fixture.createFlow(fetcher, { authTimeoutMs: 50, pollIntervalMs: 10 })

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('timed_out')
    expect(calls.filter((call) => call.url.includes('evil.example'))).toHaveLength(0)
    expect(fixture.credentials.writes).toHaveLength(0)
  })

  it('refresh 跨源且降级到 http 的 302 不跟随，refreshToken 不出源', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createRedirectGuardFetcher(
      'refresh',
      'http://evil.example/collect',
    )
    const flow = fixture.createFlow(fetcher)

    const error = await flow.refresh(account.accountId).catch((failure: unknown) => failure)

    expect(error).toMatchObject({ code: 'auth/refresh-failed' })
    expect(calls.filter((call) => call.url.includes('evil.example'))).toHaveLength(0)
    const stored = await fixture.store.readEntry('buddy', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'ACCESS_1',
      refreshToken: 'REFRESH_1',
    })
  })
})

describe('CodeBuddy 保存前能力探测', () => {
  it('身份验证后、保存前调用 verifyCapability 并传入脱敏凭据', async () => {
    const fixture = createBuddyAuthFixture()
    let probed: BuddyCapabilityCredential | undefined
    let probedSignal: AbortSignal | undefined
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher, {
      verifyCapability: async (credential, signal) => {
        probed = credential
        probedSignal = signal
      },
    })

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('completed')
    expect(probed).toEqual({
      channelId: 'buddy',
      accessToken: 'ACCESS_1',
      vendorAccountId: 'user-1',
    })
    expect(probedSignal).toBeInstanceOf(AbortSignal)
    expect(await fixture.store.listEntries('buddy')).toHaveLength(1)
  })

  it('能力探测失败时不落码、不设当前', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher, {
      verifyCapability: async () => {
        throw new Error('account has no search permission')
      },
    })

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('failed')
    expect(terminal.errorCode).toBe('auth/failed')
    expect(terminal.account).toBeNull()
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(await fixture.store.listEntries('buddy')).toHaveLength(0)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
  })

  it('能力探测超时不落码、不设当前', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher, {
      verifyCapability: async () => {
        throw new DOMException('capability timed out', 'TimeoutError')
      },
    })

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('timed_out')
    expect(terminal.errorCode).toBe('auth/timeout')
    expect(terminal.account).toBeNull()
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
  })

  it('能力探测期间取消：不落码、不设当前', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher, {
      verifyCapability: async (_credential, signal) => {
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('capability aborted'))
            return
          }
          const timer = setTimeout(resolve, 1_000)
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('capability aborted'))
          }, { once: true })
        })
      },
    })

    const started = await flow.start()
    const cancelled = await flow.cancel(started.flowId)

    expect(cancelled.status).toBe('cancelled')
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(await fixture.store.listEntries('buddy')).toHaveLength(0)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
  })

  it('verifyCapability 不可省略', () => {
    const fixture = createBuddyAuthFixture()
    expect(() => new BuddyAuthFlow({
      store: fixture.store,
      accounts: fixture.service,
    } as never)).toThrow(TypeError)
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

  it('首个账号写当前失败时返回 auth/current-account-failed，账号保留但不设当前', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const probeEntered = deferred<void>()
    const probeRelease = deferred<void>()
    const flow = fixture.createFlow(fetcher, {
      verifyCapability: async () => {
        probeEntered.resolve()
        await probeRelease.promise
      },
    })

    const started = await flow.start()
    await probeEntered.promise
    fixture.settingsDouble.failNextWrite('settings write failed')
    probeRelease.resolve()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('failed')
    expect(terminal.errorCode).toBe('auth/current-account-failed')
    expect(terminal.account).not.toBeNull()
    expect(await fixture.store.listEntries('buddy')).toHaveLength(1)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
  })

  it('已有记录缺 accessToken 时不算可用账号，首个新账号仍设为当前', async () => {
    const fixture = createBuddyAuthFixture()
    const unusable = await fixture.store.saveAccount({
      channel: 'buddy',
      vendorAccountId: 'empty-secret-user',
      secret: {},
    })
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('completed')
    expect(terminal.account?.id).not.toBe(unusable.accountId)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(
      terminal.account?.id,
    )
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

describe('CodeBuddy dispose 覆盖全部在飞工作', () => {
  it('dispose 等待 reauthenticate 的预读 settle，且不启动新流程', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const originalRead = fixture.store.readEntry.bind(fixture.store)
    const entered = deferred<void>()
    const release = deferred<void>()
    let gate = true
    fixture.store.readEntry = async (channel, accountId) => {
      if (gate && channel === 'buddy' && accountId === account.accountId) {
        gate = false
        entered.resolve()
        await release.promise
      }
      return await originalRead(channel, accountId)
    }
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher)

    const reauthenticating = flow.reauthenticate(account.accountId).catch(
      (error: unknown) => error,
    )
    const writesBefore = fixture.credentials.writes.length
    await entered.promise
    let disposed = false
    const disposing = flow.dispose().then(() => { disposed = true })
    await flush()
    expect(disposed).toBe(false)

    release.resolve()
    await disposing
    expect(await reauthenticating).toMatchObject({ code: 'auth/disposed' })
    expect(fixture.credentials.writes).toHaveLength(writesBefore)
  })

  it('dispose 等待 runWithAuthRetry 的首次 credential resolve，且不启动 operation', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const originalRead = fixture.store.readEntry.bind(fixture.store)
    const entered = deferred<void>()
    const release = deferred<void>()
    let gate = true
    fixture.store.readEntry = async (channel, accountId) => {
      if (gate && channel === 'buddy' && accountId === account.accountId) {
        gate = false
        entered.resolve()
        await release.promise
      }
      return await originalRead(channel, accountId)
    }
    const { fetcher } = createScriptedFetcher([stateRoute()])
    const flow = fixture.createFlow(fetcher)
    let operationCalls = 0

    const running = flow.runWithAuthRetry(account.accountId, async () => {
      operationCalls += 1
      return 'ok'
    }).catch((error: unknown) => error)
    await entered.promise
    let disposed = false
    const disposing = flow.dispose().then(() => { disposed = true })
    await flush()
    expect(disposed).toBe(false)

    release.resolve()
    await disposing
    expect(await running).toMatchObject({ code: 'auth/disposed' })
    expect(operationCalls).toBe(0)
  })

  it('dispose 等待已启动的 operation settle，且不启动第二次 operation', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher } = createScriptedFetcher([stateRoute()])
    const flow = fixture.createFlow(fetcher)
    const entered = deferred<void>()
    const release = deferred<void>()
    let receivedSignal: AbortSignal | undefined
    let operationCalls = 0

    const running = flow.runWithAuthRetry(account.accountId, async (_credential, signal) => {
      operationCalls += 1
      receivedSignal = signal
      entered.resolve()
      await release.promise
      return 'result'
    }).catch((error: unknown) => error)
    await entered.promise
    let disposed = false
    const disposing = flow.dispose().then(() => { disposed = true })
    await flush()
    expect(disposed).toBe(false)

    release.resolve()
    await disposing
    expect(await running).toMatchObject({ code: 'auth/disposed' })
    expect(receivedSignal).toBeInstanceOf(AbortSignal)
    expect(operationCalls).toBe(1)
  })

  it('dispose 等待 401 刷新后的第二次 credential resolve，且不启动第二次 operation', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher } = createScriptedFetcher([
      refreshRoute(() => okToken({ accessToken: 'ACCESS_2', refreshToken: 'REFRESH_2' })),
    ])
    const flow = fixture.createFlow(fetcher)
    const originalRefresh = flow.refresh.bind(flow)
    let refreshDone = false
    flow.refresh = async (accountId: string) => {
      const result = await originalRefresh(accountId)
      refreshDone = true
      return result
    }
    const originalRead = fixture.store.readEntry.bind(fixture.store)
    const entered = deferred<void>()
    const release = deferred<void>()
    let gate = true
    fixture.store.readEntry = async (channel, accountId) => {
      if (refreshDone && gate && channel === 'buddy' && accountId === account.accountId) {
        gate = false
        entered.resolve()
        await release.promise
      }
      return await originalRead(channel, accountId)
    }
    let operationCalls = 0
    const running = flow.runWithAuthRetry(account.accountId, async () => {
      operationCalls += 1
      if (operationCalls === 1) {
        throw new ChannelSearchError('UNAUTHORIZED', 'buddy', '401', undefined, 401)
      }
      return 'ok'
    }).catch((error: unknown) => error)

    await entered.promise
    let disposed = false
    const disposing = flow.dispose().then(() => { disposed = true })
    await flush()
    expect(disposed).toBe(false)

    release.resolve()
    await disposing
    expect(await running).toMatchObject({ code: 'auth/disposed' })
    expect(operationCalls).toBe(1)
  })

  it('dispose 后 runWithAuthRetry 直接拒绝且不启动 operation', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher } = createScriptedFetcher([stateRoute()])
    const flow = fixture.createFlow(fetcher)
    await flow.dispose()
    let operationCalls = 0

    await expect(flow.runWithAuthRetry(account.accountId, async () => {
      operationCalls += 1
      return 'ok'
    })).rejects.toMatchObject({ code: 'auth/disposed' })
    expect(operationCalls).toBe(0)
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

  it('旧 401 迟到时 CAS 不覆盖已轮换的新记录状态', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(() => gate.promise),
    ])
    const flow = fixture.createFlow(fetcher)

    const refreshing = flow.refresh(account.accountId).catch((failure: unknown) => failure)
    await waitForCall(calls, (call) => call.url.includes('/auth/token/refresh'))
    await fixture.store.saveAccount({
      channel: 'buddy',
      vendorAccountId: 'user-1',
      secret: { accessToken: 'ACCESS_NEW', refreshToken: 'REFRESH_NEW' },
    })
    gate.resolve(jsonResponse({ code: 401, message: 'expired' }, 401))

    expect(await refreshing).toMatchObject({ code: 'auth/reauth-required' })
    const stored = await fixture.store.readEntry('buddy', account.accountId)
    expect(stored?.account?.status).toBe('ready')
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'ACCESS_NEW',
      refreshToken: 'REFRESH_NEW',
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

describe('CodeBuddy 取消落在持久化提交边界', () => {
  it('cancel 落在 saveAccount 的 modifyRecord 提交前：不写账号、不设当前', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher)
    const originalModify = fixture.credentials.modifyRecord.bind(fixture.credentials)
    const entered = deferred<void>()
    const release = deferred<void>()
    fixture.credentials.modifyRecord = async (key, mutate) => {
      entered.resolve()
      await release.promise
      return await originalModify(key, mutate)
    }

    const started = await flow.start()
    await entered.promise
    const cancelling = flow.cancel(started.flowId)
    release.resolve()
    const cancelled = await cancelling

    expect(cancelled.status).toBe('cancelled')
    expect(await fixture.store.listEntries('buddy')).toHaveLength(0)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
  })

  it('dispose 落在 saveAccount 的 modifyRecord 提交前：等待 settle 且不写账号', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher)
    const originalModify = fixture.credentials.modifyRecord.bind(fixture.credentials)
    const entered = deferred<void>()
    const release = deferred<void>()
    fixture.credentials.modifyRecord = async (key, mutate) => {
      entered.resolve()
      await release.promise
      return await originalModify(key, mutate)
    }

    const started = await flow.start()
    await entered.promise
    let disposed = false
    const disposing = flow.dispose().then(() => { disposed = true })
    await flush()
    expect(disposed).toBe(false)

    release.resolve()
    await disposing
    expect((await flow.status(started.flowId)).status).toBe('cancelled')
    expect(await fixture.store.listEntries('buddy')).toHaveLength(0)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
  })

  it('cancel 落在 setCurrent 的 configEditor 提交前：账号保留但不写当前', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher)
    const originalEdit = fixture.settingsDouble.editor.edit.bind(fixture.settingsDouble.editor)
    const entered = deferred<void>()
    const release = deferred<void>()
    fixture.settingsDouble.editor.edit = async (entry, change) => {
      entered.resolve()
      await release.promise
      return await originalEdit(entry, change)
    }

    const started = await flow.start()
    await entered.promise
    const cancelling = flow.cancel(started.flowId)
    release.resolve()
    const cancelled = await cancelling

    expect(cancelled.status).toBe('cancelled')
    expect(await fixture.store.listEntries('buddy')).toHaveLength(1)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
  })

  it('dispose 落在 setCurrent 的 configEditor 提交前：等待 settle 且不写当前', async () => {
    const fixture = createBuddyAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher)
    const originalEdit = fixture.settingsDouble.editor.edit.bind(fixture.settingsDouble.editor)
    const entered = deferred<void>()
    const release = deferred<void>()
    fixture.settingsDouble.editor.edit = async (entry, change) => {
      entered.resolve()
      await release.promise
      return await originalEdit(entry, change)
    }

    const started = await flow.start()
    await entered.promise
    let disposed = false
    const disposing = flow.dispose().then(() => { disposed = true })
    await flush()
    expect(disposed).toBe(false)

    release.resolve()
    await disposing
    expect((await flow.status(started.flowId)).status).toBe('cancelled')
    expect(await fixture.store.listEntries('buddy')).toHaveLength(1)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
  })

  it('取消重新登录不得用新秘密覆盖旧记录', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    await fixture.service.setCurrent('buddy', account.accountId)
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken({ accessToken: 'ACCESS_2', refreshToken: 'REFRESH_2' })),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createFlow(fetcher)
    const originalModify = fixture.credentials.modifyRecord.bind(fixture.credentials)
    const entered = deferred<void>()
    const release = deferred<void>()
    fixture.credentials.modifyRecord = async (key, mutate) => {
      entered.resolve()
      await release.promise
      return await originalModify(key, mutate)
    }

    const started = await flow.reauthenticate(account.accountId)
    await entered.promise
    const cancelling = flow.cancel(started.flowId)
    release.resolve()
    const cancelled = await cancelling

    expect(cancelled.status).toBe('cancelled')
    const stored = await fixture.store.readEntry('buddy', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'ACCESS_1',
      refreshToken: 'REFRESH_1',
    })
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(account.accountId)
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
      if (attempts === 1) {
        throw new ChannelSearchError('UNAUTHORIZED', 'buddy', 'upstream 401', undefined, 401)
      }
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

  it('仅业务 code=UNAUTHORIZED、没有可信 HTTP 401 时不刷新不重试', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)
    const businessError = new ChannelSearchError('UNAUTHORIZED', 'buddy', 'business code')
    let attempts = 0

    const error = await flow.runWithAuthRetry(account.accountId, async () => {
      attempts += 1
      throw businessError
    }).catch((failure: unknown) => failure)

    expect(error).toBe(businessError)
    expect(attempts).toBe(1)
    expect(calls).toHaveLength(0)
  })

  it('HTTP 403/429 即使带 UNAUTHORIZED 也不刷新不重试', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)

    for (const httpStatus of [403, 429]) {
      let attempts = 0
      const error = await flow.runWithAuthRetry(account.accountId, async () => {
        attempts += 1
        throw new ChannelSearchError('UNAUTHORIZED', 'buddy', 'not 401', undefined, httpStatus)
      }).catch((failure: unknown) => failure)
      expect(error).toMatchObject({ code: 'UNAUTHORIZED', httpStatus })
      expect(attempts).toBe(1)
    }
    expect(calls).toHaveLength(0)
  })

  it('共享 normalize 从实际 HTTP 401 产生的 UNAUTHORIZED 可以刷新重试', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(() => okToken({ accessToken: 'ACCESS_2', refreshToken: 'REFRESH_2' })),
    ])
    const flow = fixture.createFlow(fetcher)
    const unauthorized = normalizeChannelSearchError(
      { status: 401, code: 'UNAUTHORIZED', message: 'raw upstream text' },
      'buddy',
    )
    let attempts = 0

    const result = await flow.runWithAuthRetry(account.accountId, async () => {
      attempts += 1
      if (attempts === 1) throw unauthorized
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(attempts).toBe(2)
    expect(calls.filter((call) => call.url.includes('/auth/token/refresh'))).toHaveLength(1)
  })

  it('共享 normalize 从 HTTP 403 产生的 UNAUTHORIZED 不刷新不重试', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)
    const unauthorized = normalizeChannelSearchError(
      { status: 403, code: 'UNAUTHORIZED', message: 'forbidden' },
      'buddy',
    )
    let attempts = 0

    const error = await flow.runWithAuthRetry(account.accountId, async () => {
      attempts += 1
      throw unauthorized
    }).catch((failure: unknown) => failure)

    expect(error).toBe(unauthorized)
    expect(attempts).toBe(1)
    expect(calls).toHaveLength(0)
  })

  it('跨渠道 UNAUTHORIZED 不刷新、不重试', async () => {
    const fixture = createBuddyAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)
    const foreign = new ChannelSearchError(
      'UNAUTHORIZED',
      'workbuddy',
      'foreign 401',
      undefined,
      401,
    )
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
      throw new ChannelSearchError('UNAUTHORIZED', 'buddy', 'still 401', undefined, 401)
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
        if (attempts === 1) {
          throw new ChannelSearchError('UNAUTHORIZED', 'buddy', 'concurrent 401', undefined, 401)
        }
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
      throw new ChannelSearchError('UNAUTHORIZED', 'buddy', '401', undefined, 401)
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
