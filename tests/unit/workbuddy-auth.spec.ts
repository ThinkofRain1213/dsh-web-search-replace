/**
 * Task 10：WorkBuddy 国际版独立 external-link 授权、刷新与重新登录。
 *
 * 所有网络都由脚本化 fetcher 提供，时钟、随机 ID、登录 session ID 与请求超时
 * 信号都可注入；测试不接触真实厂商网络、真实凭据或真实浏览器。断言重点是：
 *
 * - 产品固定为 WorkBuddy 国际版：platform=workbuddy-ai、www.workbuddy.ai、
 *   5.5.2 国际版 UA，并按 appendSessionParams 语义装饰授权 URL；
 * - 账号、当前账号、flowId、刷新单飞、取消、dispose 与 CodeBuddy 完全隔离；
 * - CodeBuddy 的成功/ready/当前/凭据绝不使 WorkBuddy ready；
 * - 保存前必须完成 WorkBuddy Search 能力探测，失败/超时/取消不落码；
 * - 只有可信 httpStatus=401 且 channel=workbuddy 才刷新同账号并重试一次；
 * - 共享 RPC 只接受 buddy|workbuddy，产品分派在首次网络/账号工作前拒绝错渠道。
 */
import { describe, expect, it } from 'vitest'

import { BuddyAuthFlow, BuddyAuthError } from '../../src/host/channels/buddy/auth.ts'
import { dispatchBuddyAuthRpc } from '../../src/host/channels/buddy/auth-rpc.ts'
import {
  WORKBUDDY_AUTH_PRODUCT,
  WORKBUDDY_PLUGIN_VERSION,
  WorkbuddyAuthError,
  WorkbuddyAuthFlow,
  type WorkbuddyAuthFlowOptions,
  type WorkbuddyCapabilityCredential,
} from '../../src/host/channels/workbuddy/auth.ts'
import { dispatchWorkbuddyAuthRpc } from '../../src/host/channels/workbuddy/auth-rpc.ts'
import { accountRecordKey } from '../../src/host/accounts/store.ts'
import { ChannelSearchError } from '../../src/host/search/errors.ts'
import type { AccountSummary } from '../../src/shared/accounts.ts'
import {
  AuthFlowError,
  AuthRpcValidationError,
  assertAuthRpcPayload,
  isAuthFlowStatus,
  isAuthFlowStatusForChannel,
  type AuthFlowStatus,
} from '../../src/shared/auth.ts'
import { createAccountFixture, type AccountFixture } from './support/account-fixture.ts'

const AUTH_URL = 'https://www.workbuddy.ai/login/?platform=workbuddy-ai&state=wb-state'
const STATE = 'wb-state'
const WB_UA = 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2'
const WB_DOMAIN = 'www.workbuddy.ai'

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

/**
 * 模拟真实 fetch 的跨源重定向跟随：只有 `redirect:'error'` 才拒绝；
 * 其他设置会把同一请求（含原始头）发到 evil 目标。用于证明 WorkBuddy
 * 控制面请求不会把秘密转发给重定向目标。
 */
function createRedirectGuardFetcher(
  stage: 'state' | 'refresh',
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
    if (stage === 'state' && url.includes('/v2/plugin/auth/state')) {
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
      return okToken({ accessToken: 'WB_ACCESS_2', refreshToken: 'WB_REFRESH_2' })
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
    accessToken: 'WB_ACCESS_1',
    refreshToken: 'WB_REFRESH_1',
    expiresIn: 3600,
    tokenType: 'Bearer',
    domain: WB_DOMAIN,
    ...overrides,
  }
}

/** 默认账户数据。 */
function accountData(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    uid: 'wb-user-1',
    nickname: 'WorkBuddy One',
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
async function waitForTerminal(
  flow: { status(flowId: string): Promise<AuthFlowStatus> },
  flowId: string,
): Promise<AuthFlowStatus> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const status = await flow.status(flowId)
    if (status.status !== 'pending') return status
    await new Promise<void>((resolve) => { setTimeout(resolve, 1) })
  }
  throw new Error('auth flow did not settle')
}

/** 测试夹具：真实 AccountStore/AccountService + 内存 credentials + 假时钟。 */
interface TencentAuthFixture extends AccountFixture {
  readonly createWorkbuddyFlow: (
    fetcher: typeof fetch,
    overrides?: Partial<WorkbuddyAuthFlowOptions>,
  ) => WorkbuddyAuthFlow
  readonly createBuddyFlow: (
    fetcher: typeof fetch,
    overrides?: Record<string, unknown>,
  ) => BuddyAuthFlow
  readonly now: () => number
}

function createTencentAuthFixture(): TencentAuthFixture {
  const accounts = createAccountFixture()
  let now = 1_000_000
  let nextWorkbuddyFlow = 0
  let nextWorkbuddySession = 0
  let nextBuddyFlow = 0
  const clock = {
    now: () => now,
    sleep: async (ms: number) => { now += Math.max(1, ms) },
  }
  const createWorkbuddyFlow = (
    fetcher: typeof fetch,
    overrides: Partial<WorkbuddyAuthFlowOptions> = {},
  ): WorkbuddyAuthFlow => new WorkbuddyAuthFlow({
    store: accounts.store,
    accounts: accounts.service,
    fetcher,
    clock,
    randomId: () => `wb-flow-${++nextWorkbuddyFlow}`,
    randomSessionId: () => `wb-session-${++nextWorkbuddySession}`,
    pollIntervalMs: 10,
    authTimeoutMs: 60_000,
    requestTimeoutMs: 5_000,
    // 测试不让每个请求挂真实 60s 定时器；取消/超时由流程级 deadline 覆盖。
    timeoutSignal: () => new AbortController().signal,
    verifyCapability: async () => { /* 默认能力探测成功；需要失败/延迟的用例显式覆盖 */ },
    ...overrides,
  })
  const createBuddyFlow = (
    fetcher: typeof fetch,
    overrides: Record<string, unknown> = {},
  ): BuddyAuthFlow => new BuddyAuthFlow({
    store: accounts.store,
    accounts: accounts.service,
    fetcher,
    clock,
    randomId: () => `buddy-flow-${++nextBuddyFlow}`,
    pollIntervalMs: 10,
    authTimeoutMs: 60_000,
    requestTimeoutMs: 5_000,
    timeoutSignal: () => new AbortController().signal,
    verifyCapability: async () => { /* 测试能力探测成功 */ },
    ...overrides,
  })
  return {
    ...accounts,
    createWorkbuddyFlow,
    createBuddyFlow,
    now: () => now,
  }
}

/** 预置一个账号；默认 workbuddy。 */
async function seedAccount(
  fixture: TencentAuthFixture,
  options: {
    readonly channel?: 'buddy' | 'workbuddy'
    readonly vendor?: string
    readonly accessToken?: string
    readonly refreshToken?: string
  } = {},
) {
  return await fixture.store.saveAccount({
    channel: options.channel ?? 'workbuddy',
    vendorAccountId: options.vendor ?? 'wb-user-1',
    displayName: 'Seed User',
    secret: {
      accessToken: options.accessToken ?? 'WB_ACCESS_1',
      refreshToken: options.refreshToken ?? 'WB_REFRESH_1',
    },
  })
}

/** 断言 Client 可见对象不含任何令牌/秘密字段或值。 */
function expectNoSecret(value: unknown): void {
  const text = JSON.stringify(value)
  for (const marker of [
    'WB_ACCESS_1',
    'WB_ACCESS_2',
    'WB_REFRESH_1',
    'WB_REFRESH_2',
    'accessToken',
    'refreshToken',
    'secret',
  ]) {
    expect(text).not.toContain(marker)
  }
}

describe('WorkBuddy 产品参数与授权 URL', () => {
  it('固定 WorkBuddy 国际版产品参数，绝不沿用 CodeBuddy', () => {
    expect(WORKBUDDY_AUTH_PRODUCT).toEqual({
      platform: 'workbuddy-ai',
      endpoint: 'https://www.workbuddy.ai',
      apiDomain: 'www.workbuddy.ai',
      userAgent: WB_UA,
      authUrlHosts: ['www.workbuddy.ai'],
    })
    expect(WORKBUDDY_PLUGIN_VERSION).toBe('5.5.2')
  })

  it('构造不自动启动；start 使用 workbuddy-ai 产品参数并装饰授权 URL', async () => {
    const fixture = createTencentAuthFixture()
    const { fetcher, calls } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)
    expect(calls).toHaveLength(0)

    const started = await flow.start()

    expect(started).toMatchObject({
      flowId: 'wb-flow-1',
      channel: 'workbuddy',
      status: 'pending',
      account: null,
      errorCode: null,
    })
    expect(started.displayHint).toContain('WorkBuddy')
    expectNoSecret(started)

    const decorated = new URL(started.authUrl ?? '')
    expect(decorated.protocol).toBe('https:')
    expect(decorated.hostname).toBe(WB_DOMAIN)
    expect(decorated.pathname).toBe('/login/')
    expect(decorated.searchParams.get('platform')).toBe('workbuddy-ai')
    expect(decorated.searchParams.get('state')).toBe(STATE)
    expect(decorated.searchParams.get('version')).toBe('5.5.2')
    expect(decorated.searchParams.get('loginSessionId')).toBe('wb-session-1')

    const stateCall = calls[0]
    expect(stateCall?.url).toBe(
      'https://www.workbuddy.ai/v2/plugin/auth/state?platform=workbuddy-ai',
    )
    expect(stateCall?.init.method).toBe('POST')
    const headers = stateCall?.init.headers as Record<string, string>
    expect(headers['X-Domain']).toBe(WB_DOMAIN)
    expect(headers['X-No-Authorization']).toBe('true')
    expect(headers['X-No-User-Id']).toBe('true')
    expect(headers['X-No-Enterprise-Id']).toBe('true')
    expect(headers['X-No-Department-Info']).toBe('true')
    expect(headers['User-Agent']).toBe(WB_UA)

    const terminal = await waitForTerminal(flow, started.flowId)
    expect(terminal.status).toBe('completed')

    const tokenCall = calls.find((call) => call.url.includes('/auth/token'))
    expect(tokenCall?.url).toContain(`state=${STATE}`)
    expect((tokenCall?.init.headers as Record<string, string>)['User-Agent']).toBe(WB_UA)

    const accountCall = calls.find((call) => call.url.includes('/login/account'))
    expect(accountCall?.url).toContain(`state=${STATE}`)
    const accountHeaders = accountCall?.init.headers as Record<string, string>
    expect(accountHeaders.Authorization).toBe('Bearer WB_ACCESS_1')
    expect(accountHeaders['X-Domain']).toBe(WB_DOMAIN)
    expect(accountHeaders['User-Agent']).toBe(WB_UA)
    expect(JSON.stringify(calls.map((call) => call.url))).not.toContain('copilot.tencent.com')
  })

  it('auth/state 失败只返回固定安全错误，不创建流程也不写账号', async () => {
    const fixture = createTencentAuthFixture()
    const sentinel = 'NON_REAL_WORKBUDDY_UPSTREAM_SENTINEL'
    const { fetcher } = createScriptedFetcher([
      stateRoute(() => jsonResponse({ code: 500, message: sentinel }, 500)),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    const error = await flow.start().catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(WorkbuddyAuthError)
    expect(error).toMatchObject({ code: 'auth/failed' })
    expect(String((error as Error).message)).not.toContain(sentinel)
    expect(JSON.stringify(error)).not.toContain(sentinel)
    expect(fixture.credentials.writes).toHaveLength(0)
    await expect(flow.status('wb-flow-1')).rejects.toMatchObject({ code: 'auth/flow-not-found' })
  })

  it('authUrl 只接受精确 www.workbuddy.ai 的 https 地址', async () => {
    const fixture = createTencentAuthFixture()
    const malicious = [
      '',
      'http://www.workbuddy.ai/login',
      'javascript:alert(1)',
      'https://evil.example/login',
      'https://workbuddy.ai/login',
      'https://auth.workbuddy.ai/login',
      'https://api.workbuddy.ai/login',
      'https://www.workbuddy.cn/login',
      'https://www.workbuddy.ai.evil.example/login',
      'https://evil.example/www.workbuddy.ai/login',
      'https://www.workbuddy.ai:444/login',
      'https://user:pass@www.workbuddy.ai/login',
      'https://www.workbuddy.ai/login#@evil.example',
    ]
    for (const authUrl of malicious) {
      const { fetcher } = createScriptedFetcher([
        stateRoute(() => jsonResponse({ code: 0, data: { state: STATE, authUrl } })),
      ])
      const flow = fixture.createWorkbuddyFlow(fetcher)
      const started = await flow.start().then(
        (status) => status,
        (error: unknown) => error,
      )
      if (!(started instanceof Error)) await flow.dispose()
      expect(started, authUrl).toMatchObject({ code: 'auth/invalid-response' })
      expect(fixture.credentials.writes).toHaveLength(0)
    }
  })

  it('轮询遇到一次网络错误后继续，最终成功落码', async () => {
    const fixture = createTencentAuthFixture()
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
    const flow = fixture.createWorkbuddyFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('completed')
    expect(tokenAttempts).toBe(2)
    expect(fixture.credentials.writes).toHaveLength(1)
  })

  it('auth/state 跨源 302 不跟随，秘密不出源', async () => {
    const fixture = createTencentAuthFixture()
    const { fetcher, calls } = createRedirectGuardFetcher('state')
    const flow = fixture.createWorkbuddyFlow(fetcher)

    const error = await flow.start().catch((failure: unknown) => failure)

    expect(error).toMatchObject({ code: 'auth/failed' })
    expect(calls.filter((call) => call.url.includes('evil.example'))).toHaveLength(0)
    expect(fixture.credentials.writes).toHaveLength(0)
  })

  it('refresh 跨源且降级到 http 的 302 不跟随，refreshToken 不出源', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createRedirectGuardFetcher(
      'refresh',
      'http://evil.example/collect',
    )
    const flow = fixture.createWorkbuddyFlow(fetcher)

    const error = await flow.refresh(account.accountId).catch((failure: unknown) => failure)

    expect(error).toMatchObject({ code: 'auth/refresh-failed' })
    expect(calls.filter((call) => call.url.includes('evil.example'))).toHaveLength(0)
    const stored = await fixture.store.readEntry('workbuddy', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'WB_ACCESS_1',
      refreshToken: 'WB_REFRESH_1',
    })
  })
})

describe('WorkBuddy 独立账号与当前账号', () => {
  it('首个账号只写 workbuddy grant，并只设 workbuddy 当前账号', async () => {
    const fixture = createTencentAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('completed')
    expect(terminal.account).toMatchObject({
      channelId: 'workbuddy',
      displayName: 'WorkBuddy One',
      endpointLabel: WB_DOMAIN,
      status: 'ready',
      maskedIdentifier: 'w***1',
    })
    const accountId = terminal.account!.id
    const entry = await fixture.store.readEntry('workbuddy', accountId)
    expect(entry?.account).toMatchObject({
      channelId: 'workbuddy',
      accountId,
      vendorAccountId: 'wb-user-1',
      displayName: 'WorkBuddy One',
      status: 'ready',
    })
    expect(entry?.account?.secret).toMatchObject({
      accessToken: 'WB_ACCESS_1',
      refreshToken: 'WB_REFRESH_1',
    })
    expect(fixture.settingsDouble.getState().workbuddy.currentAccountId).toBe(accountId)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
    expect(fixture.credentials.writes).toHaveLength(1)
    expect(fixture.credentials.writes[0]).toBe(
      `dsh-web-search-channels/workbuddy-${accountId}`,
    )
    expect(fixture.credentials.keys().some((key) => key.includes('/buddy-'))).toBe(false)
    expect(await fixture.store.listEntries('buddy')).toHaveLength(0)
  })

  it('CodeBuddy 成功登录/ready/当前/凭据绝不使 WorkBuddy ready 或当前', async () => {
    const fixture = createTencentAuthFixture()
    const buddyFetcher = createScriptedFetcher([
      {
        when: (url) => url.includes('/v2/plugin/auth/state'),
        respond: () => jsonResponse({
          code: 0,
          data: {
            state: 'buddy-state',
            authUrl: 'https://www.codebuddy.cn/login/?platform=ide&state=buddy-state',
          },
        }),
      },
      tokenRoute(() => jsonResponse({
        code: 0,
        data: {
          accessToken: 'BUDDY_ACCESS_1',
          refreshToken: 'BUDDY_REFRESH_1',
          expiresIn: 3600,
          tokenType: 'Bearer',
          domain: 'copilot.tencent.com',
        },
      })),
      accountRoute(() => jsonResponse({
        code: 0,
        data: { uid: 'buddy-user-1', nickname: 'Buddy One', enterpriseId: '', type: 'personal' },
      })),
    ])
    const buddyFlow = fixture.createBuddyFlow(buddyFetcher.fetcher)
    const buddyStarted = await buddyFlow.start()
    const buddyTerminal = await waitForTerminal(buddyFlow, buddyStarted.flowId)
    expect(buddyTerminal.status).toBe('completed')
    const buddyId = buddyTerminal.account!.id
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(buddyId)

    // CodeBuddy 已 ready 且是 buddy 当前账号，但 WorkBuddy 仍然没有 ready 账号。
    expect(await fixture.store.listEntries('workbuddy')).toHaveLength(0)
    expect(await fixture.service.getCurrent('workbuddy')).toBeNull()

    const workbuddyFetcher = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const workbuddyFlow = fixture.createWorkbuddyFlow(workbuddyFetcher.fetcher)
    const started = await workbuddyFlow.start()
    const terminal = await waitForTerminal(workbuddyFlow, started.flowId)

    expect(terminal.status).toBe('completed')
    expect(terminal.account?.channelId).toBe('workbuddy')
    expect(fixture.settingsDouble.getState().workbuddy.currentAccountId).toBe(
      terminal.account?.id,
    )
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(buddyId)
    const buddyEntry = await fixture.store.readEntry('buddy', buddyId)
    expect(buddyEntry?.account?.secret).toMatchObject({
      accessToken: 'BUDDY_ACCESS_1',
      refreshToken: 'BUDDY_REFRESH_1',
    })
    expect(await fixture.store.listEntries('buddy')).toHaveLength(1)
    expect(await fixture.store.listEntries('workbuddy')).toHaveLength(1)
  })

  it('后续 WorkBuddy 账号成功不自动替换当前账号', async () => {
    const fixture = createTencentAuthFixture()
    const firstFlow = fixture.createWorkbuddyFlow(createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ]).fetcher)
    const firstStarted = await firstFlow.start()
    const firstTerminal = await waitForTerminal(firstFlow, firstStarted.flowId)
    const firstId = firstTerminal.account!.id

    const secondFlow = fixture.createWorkbuddyFlow(createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken({ accessToken: 'WB_ACCESS_2', refreshToken: 'WB_REFRESH_2' })),
      accountRoute(() => okAccount({ uid: 'wb-user-2', nickname: 'WorkBuddy Two' })),
    ]).fetcher)
    const secondStarted = await secondFlow.start()
    const secondTerminal = await waitForTerminal(secondFlow, secondStarted.flowId)

    expect(secondTerminal.status).toBe('completed')
    expect(secondTerminal.account?.id).not.toBe(firstId)
    expect(fixture.settingsDouble.getState().workbuddy.currentAccountId).toBe(firstId)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
  })

  it('WorkBuddy 刷新不读取 CodeBuddy 账号', async () => {
    const fixture = createTencentAuthFixture()
    const buddy = await seedAccount(fixture, {
      channel: 'buddy',
      vendor: 'buddy-user-1',
      accessToken: 'BUDDY_ACCESS',
      refreshToken: 'BUDDY_REFRESH',
    })
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okToken())])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    await expect(flow.refresh(buddy.accountId)).rejects.toMatchObject({
      code: 'auth/account-not-found',
    })
    expect(calls).toHaveLength(0)
    const stored = await fixture.store.readEntry('buddy', buddy.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'BUDDY_ACCESS',
      refreshToken: 'BUDDY_REFRESH',
    })
  })
})

describe('WorkBuddy 保存前能力探测', () => {
  it('身份验证后、保存前调用 verifyCapability 并传入 WorkBuddy 凭据', async () => {
    const fixture = createTencentAuthFixture()
    let probed: WorkbuddyCapabilityCredential | undefined
    let probedSignal: AbortSignal | undefined
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher, {
      verifyCapability: async (credential, signal) => {
        probed = credential
        probedSignal = signal
      },
    })

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('completed')
    expect(probed).toEqual({
      channelId: 'workbuddy',
      accessToken: 'WB_ACCESS_1',
      vendorAccountId: 'wb-user-1',
    })
    expect(probedSignal).toBeInstanceOf(AbortSignal)
    expect(await fixture.store.listEntries('workbuddy')).toHaveLength(1)
  })

  it('能力探测失败时不落码、不设当前', async () => {
    const fixture = createTencentAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher, {
      verifyCapability: async () => {
        throw new Error('account has no WorkBuddy search permission')
      },
    })

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('failed')
    expect(terminal.errorCode).toBe('auth/failed')
    expect(terminal.account).toBeNull()
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(await fixture.store.listEntries('workbuddy')).toHaveLength(0)
    expect(fixture.settingsDouble.getState().workbuddy.currentAccountId).toBeNull()
  })

  it('能力探测超时不落码、不设当前', async () => {
    const fixture = createTencentAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher, {
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
    expect(fixture.settingsDouble.getState().workbuddy.currentAccountId).toBeNull()
  })

  it('能力探测期间取消：不落码、不设当前', async () => {
    const fixture = createTencentAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher, {
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
    expect(await fixture.store.listEntries('workbuddy')).toHaveLength(0)
    expect(fixture.settingsDouble.getState().workbuddy.currentAccountId).toBeNull()
  })

  it('verifyCapability 不可省略', () => {
    const fixture = createTencentAuthFixture()
    expect(() => new WorkbuddyAuthFlow({
      store: fixture.store,
      accounts: fixture.service,
    } as never)).toThrow(TypeError)
  })
})

describe('WorkBuddy 取消、超时与卸载', () => {
  it('取消后迟到的 token 响应不得写账号或当前账号', async () => {
    const fixture = createTencentAuthFixture()
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => gate.promise),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    const started = await flow.start()
    await waitForCall(calls, (call) => call.url.includes('/auth/token'))

    const cancelling = flow.cancel(started.flowId)
    gate.resolve(okToken())
    const cancelled = await cancelling
    await flush()

    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.errorCode).toBe('auth/cancelled')
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(await fixture.store.listEntries('workbuddy')).toHaveLength(0)
    expect(fixture.settingsDouble.getState().workbuddy.currentAccountId).toBeNull()
    expect((await flow.status(started.flowId)).status).toBe('cancelled')
  })

  it('轮询超时进入 timed_out 且不写账号', async () => {
    const fixture = createTencentAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => jsonResponse({ code: 11217 }, 400)),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher, {
      authTimeoutMs: 100,
      pollIntervalMs: 10,
    })

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('timed_out')
    expect(terminal.errorCode).toBe('auth/timeout')
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(fixture.settingsDouble.getState().workbuddy.currentAccountId).toBeNull()
  })

  it('dispose 停止轮询、等待 settle，迟到响应不写账号；dispose 后拒绝新任务', async () => {
    const fixture = createTencentAuthFixture()
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => gate.promise),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    const started = await flow.start()
    await waitForCall(calls, (call) => call.url.includes('/auth/token'))

    const disposing = flow.dispose()
    gate.resolve(okToken())
    await disposing
    await flush()

    expect((await flow.status(started.flowId)).status).toBe('cancelled')
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(fixture.settingsDouble.getState().workbuddy.currentAccountId).toBeNull()
    await expect(flow.start()).rejects.toMatchObject({ code: 'auth/disposed' })
    await expect(flow.reauthenticate('a000000000000')).rejects.toMatchObject({
      code: 'auth/disposed',
    })
  })

  it('cancel 对已完成流程幂等返回 completed，不改变已落码账号', async () => {
    const fixture = createTencentAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)
    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    const cancelled = await flow.cancel(started.flowId)

    expect(cancelled.status).toBe('completed')
    expect(cancelled.account).toEqual(terminal.account)
    expect(await fixture.store.listEntries('workbuddy')).toHaveLength(1)
  })
})

describe('WorkBuddy 刷新单飞与旧刷新保护', () => {
  it('刷新请求使用 WorkBuddy 产品头与 X-Refresh-Token', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(() => okToken({ accessToken: 'WB_ACCESS_2', refreshToken: 'WB_REFRESH_2' })),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    await flow.refresh(account.accountId)

    const call = calls.find((candidate) => candidate.url.includes('/auth/token/refresh'))
    expect(call?.url).toBe('https://www.workbuddy.ai/v2/plugin/auth/token/refresh')
    expect(call?.init.method).toBe('POST')
    const headers = call?.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer WB_ACCESS_1')
    expect(headers['X-Refresh-Token']).toBe('WB_REFRESH_1')
    expect(headers['X-Auth-Refresh-Source']).toBe('ide-main')
    expect(headers['X-Domain']).toBe(WB_DOMAIN)
    expect(headers['User-Agent']).toBe(WB_UA)
  })

  it('并发刷新同一账号只发一次网络请求，双方拿到同一 AccountSummary', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture)
    const gate = deferred<void>()
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(async () => {
        await gate.promise
        return okToken({ accessToken: 'WB_ACCESS_2', refreshToken: 'WB_REFRESH_2' })
      }),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    const first = flow.refresh(account.accountId)
    const second = flow.refresh(account.accountId)
    await waitForCall(calls, (call) => call.url.includes('/auth/token/refresh'))
    gate.resolve()

    const [left, right] = await Promise.all([first, second])
    expect(left).toEqual(right)
    expect(left.id).toBe(account.accountId)
    expect(calls.filter((call) => call.url.includes('/auth/token/refresh'))).toHaveLength(1)

    const stored = await fixture.store.readEntry('workbuddy', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'WB_ACCESS_2',
      refreshToken: 'WB_REFRESH_2',
    })
    expect(stored?.account?.status).toBe('ready')
  })

  it('旧刷新迟到时以 modifyRecord 当前记录为准，不覆盖新 refreshToken', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture)
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => gate.promise)])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    const refreshing = flow.refresh(account.accountId)
    await waitForCall(calls, (call) => call.url.includes('/auth/token/refresh'))

    await fixture.store.saveAccount({
      channel: 'workbuddy',
      vendorAccountId: 'wb-user-1',
      secret: { accessToken: 'WB_ACCESS_NEW', refreshToken: 'WB_REFRESH_NEW' },
    })
    gate.resolve(okToken({ accessToken: 'WB_ACCESS_2', refreshToken: 'WB_REFRESH_2' }))
    const summary = await refreshing

    expect(summary.id).toBe(account.accountId)
    const stored = await fixture.store.readEntry('workbuddy', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'WB_ACCESS_NEW',
      refreshToken: 'WB_REFRESH_NEW',
    })
  })

  it('刷新明确 401 时标记 reauth_required、抛固定错误且不重试', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture)
    const sentinel = 'NON_REAL_WORKBUDDY_REFRESH_SENTINEL'
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(() => jsonResponse({ code: 401, message: sentinel }, 401)),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    const error = await flow.refresh(account.accountId).catch((failure: unknown) => failure)

    expect(error).toMatchObject({ code: 'auth/reauth-required' })
    expect(String((error as Error).message)).not.toContain(sentinel)
    expect(JSON.stringify(error)).not.toContain(sentinel)
    expect(calls.filter((call) => call.url.includes('/auth/token/refresh'))).toHaveLength(1)
    const stored = await fixture.store.readEntry('workbuddy', account.accountId)
    expect(stored?.account?.status).toBe('reauth_required')
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'WB_ACCESS_1',
      refreshToken: 'WB_REFRESH_1',
    })
  })

  it('旧 401 迟到时 CAS 不覆盖已轮换的新记录状态', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture)
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => gate.promise)])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    const refreshing = flow.refresh(account.accountId).catch((failure: unknown) => failure)
    await waitForCall(calls, (call) => call.url.includes('/auth/token/refresh'))
    await fixture.store.saveAccount({
      channel: 'workbuddy',
      vendorAccountId: 'wb-user-1',
      secret: { accessToken: 'WB_ACCESS_NEW', refreshToken: 'WB_REFRESH_NEW' },
    })
    gate.resolve(jsonResponse({ code: 401, message: 'expired' }, 401))

    expect(await refreshing).toMatchObject({ code: 'auth/reauth-required' })
    const stored = await fixture.store.readEntry('workbuddy', account.accountId)
    expect(stored?.account?.status).toBe('ready')
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'WB_ACCESS_NEW',
      refreshToken: 'WB_REFRESH_NEW',
    })
  })

  it('刷新暂时失败标记 temporarily_unavailable、不写秘密且不重试', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(() => jsonResponse({ code: 502, message: 'upstream down' }, 502)),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    await expect(flow.refresh(account.accountId)).rejects.toMatchObject({
      code: 'auth/refresh-failed',
    })

    expect(calls.filter((call) => call.url.includes('/auth/token/refresh'))).toHaveLength(1)
    const stored = await fixture.store.readEntry('workbuddy', account.accountId)
    expect(stored?.account?.status).toBe('temporarily_unavailable')
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'WB_ACCESS_1',
      refreshToken: 'WB_REFRESH_1',
    })
  })

  it('无 refreshToken 直接进入 reauth_required 且不发网络', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture, { refreshToken: '' })
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okToken())])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    await expect(flow.refresh(account.accountId)).rejects.toMatchObject({
      code: 'auth/reauth-required',
    })
    expect(calls).toHaveLength(0)
    const stored = await fixture.store.readEntry('workbuddy', account.accountId)
    expect(stored?.account?.status).toBe('reauth_required')
  })

  it('刷新响应未下发新 refreshToken 时保留旧 refreshToken', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher } = createScriptedFetcher([
      refreshRoute(() => okToken({ accessToken: 'WB_ACCESS_2', refreshToken: '' })),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    const summary = await flow.refresh(account.accountId)

    expect(summary.id).toBe(account.accountId)
    const stored = await fixture.store.readEntry('workbuddy', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'WB_ACCESS_2',
      refreshToken: 'WB_REFRESH_1',
    })
  })

  it('刷新响应畸形时保持原秘密，不写入空令牌', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher } = createScriptedFetcher([
      refreshRoute(() => jsonResponse({ code: 0, data: {} })),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    await expect(flow.refresh(account.accountId)).rejects.toMatchObject({
      code: 'auth/refresh-failed',
    })
    const stored = await fixture.store.readEntry('workbuddy', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'WB_ACCESS_1',
      refreshToken: 'WB_REFRESH_1',
    })
  })

  it('dispose 取消在飞刷新并等待 settle，迟到响应不写凭据', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture)
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => gate.promise)])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    const refreshing = flow.refresh(account.accountId).catch((error: unknown) => error)
    await waitForCall(calls, (call) => call.url.includes('/auth/token/refresh'))

    const disposing = flow.dispose()
    gate.resolve(okToken({ accessToken: 'WB_ACCESS_2', refreshToken: 'WB_REFRESH_2' }))
    await disposing
    const error = await refreshing

    expect(error).toMatchObject({ code: 'auth/disposed' })
    const stored = await fixture.store.readEntry('workbuddy', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'WB_ACCESS_1',
      refreshToken: 'WB_REFRESH_1',
    })
    await expect(flow.refresh(account.accountId)).rejects.toMatchObject({
      code: 'auth/disposed',
    })
  })
})

describe('WorkBuddy 严格 401 同账号重试一次', () => {
  it('可信 HTTP 401 且 channel=workbuddy 时刷新同一账号并重试原操作一次', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture)
    const buddy = await seedAccount(fixture, {
      channel: 'buddy',
      vendor: 'wb-user-1',
      accessToken: 'BUDDY_ACCESS_1',
      refreshToken: 'BUDDY_REFRESH_1',
    })
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(() => okToken({ accessToken: 'WB_ACCESS_2', refreshToken: 'WB_REFRESH_2' })),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)
    const seen: string[] = []
    let attempts = 0

    const result = await flow.runWithAuthRetry(account.accountId, async (credential) => {
      expect(credential.channelId).toBe('workbuddy')
      expect(credential.accountId).toBe(account.accountId)
      seen.push(credential.accessToken)
      attempts += 1
      if (attempts === 1) {
        throw new ChannelSearchError('UNAUTHORIZED', 'workbuddy', 'upstream 401', undefined, 401)
      }
      return 'search-ok'
    })

    expect(result).toBe('search-ok')
    expect(seen).toEqual(['WB_ACCESS_1', 'WB_ACCESS_2'])
    expect(calls.filter((call) => call.url.includes('/auth/token/refresh'))).toHaveLength(1)
    const stored = await fixture.store.readEntry('workbuddy', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'WB_ACCESS_2',
      refreshToken: 'WB_REFRESH_2',
    })
    const buddyStored = await fixture.store.readEntry('buddy', buddy.accountId)
    expect(buddyStored?.account?.secret).toMatchObject({
      accessToken: 'BUDDY_ACCESS_1',
      refreshToken: 'BUDDY_REFRESH_1',
    })
    expect(calls.every((call) => !call.url.includes('copilot.tencent.com'))).toBe(true)
  })

  it('跨渠道 CodeBuddy 401 不刷新、不重试', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okToken())])
    const flow = fixture.createWorkbuddyFlow(fetcher)
    const foreign = new ChannelSearchError(
      'UNAUTHORIZED',
      'buddy',
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

  it('403/429、无 httpStatus 的业务 UNAUTHORIZED 与 TIMEOUT 都不刷新不重试', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okToken())])
    const flow = fixture.createWorkbuddyFlow(fetcher)
    const failures = [
      new ChannelSearchError('UNAUTHORIZED', 'workbuddy', '403', undefined, 403),
      new ChannelSearchError('UNAUTHORIZED', 'workbuddy', '429', undefined, 429),
      new ChannelSearchError('UNAUTHORIZED', 'workbuddy', 'business code'),
      new ChannelSearchError('TIMEOUT', 'workbuddy', 'timeout'),
      new ChannelSearchError('SEARCH_FAILED', 'workbuddy', 'unknown'),
    ]

    for (const failure of failures) {
      let attempts = 0
      const error = await flow.runWithAuthRetry(account.accountId, async () => {
        attempts += 1
        throw failure
      }).catch((caught: unknown) => caught)
      expect(error).toBe(failure)
      expect(attempts).toBe(1)
    }
    expect(calls).toHaveLength(0)
  })

  it('重试仍 401 时不再刷新，原操作最多两次', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(() => okToken({ accessToken: 'WB_ACCESS_2', refreshToken: 'WB_REFRESH_2' })),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)
    let attempts = 0

    await expect(flow.runWithAuthRetry(account.accountId, async () => {
      attempts += 1
      throw new ChannelSearchError('UNAUTHORIZED', 'workbuddy', 'still 401', undefined, 401)
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    expect(attempts).toBe(2)
    expect(calls.filter((call) => call.url.includes('/auth/token/refresh'))).toHaveLength(1)
  })

  it('并发 401 共享同一账号单飞刷新', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture)
    const gate = deferred<void>()
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(async () => {
        await gate.promise
        return okToken({ accessToken: 'WB_ACCESS_2', refreshToken: 'WB_REFRESH_2' })
      }),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)
    const makeOperation = () => {
      let attempts = 0
      return async (credential: { readonly accessToken: string }) => {
        attempts += 1
        if (attempts === 1) {
          throw new ChannelSearchError(
            'UNAUTHORIZED',
            'workbuddy',
            'concurrent 401',
            undefined,
            401,
          )
        }
        return credential.accessToken
      }
    }

    const first = flow.runWithAuthRetry(account.accountId, makeOperation())
    const second = flow.runWithAuthRetry(account.accountId, makeOperation())
    await waitForCall(calls, (call) => call.url.includes('/auth/token/refresh'))
    gate.resolve()

    expect(await Promise.all([first, second])).toEqual(['WB_ACCESS_2', 'WB_ACCESS_2'])
    expect(calls.filter((call) => call.url.includes('/auth/token/refresh'))).toHaveLength(1)
  })

  it('刷新失败时不重试原操作', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher } = createScriptedFetcher([
      refreshRoute(() => jsonResponse({ code: 401, message: 'expired' }, 401)),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)
    let attempts = 0

    await expect(flow.runWithAuthRetry(account.accountId, async () => {
      attempts += 1
      throw new ChannelSearchError('UNAUTHORIZED', 'workbuddy', '401', undefined, 401)
    })).rejects.toMatchObject({ code: 'auth/reauth-required' })

    expect(attempts).toBe(1)
  })
})

describe('WorkBuddy 重新登录', () => {
  it('同渠道同厂商身份复用账号 ID、更新秘密并保持当前账号', async () => {
    const fixture = createTencentAuthFixture()
    const firstFlow = fixture.createWorkbuddyFlow(createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ]).fetcher)
    const firstStarted = await firstFlow.start()
    const firstTerminal = await waitForTerminal(firstFlow, firstStarted.flowId)
    const accountId = firstTerminal.account!.id

    const reauthFlow = fixture.createWorkbuddyFlow(createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken({ accessToken: 'WB_ACCESS_2', refreshToken: 'WB_REFRESH_2' })),
      accountRoute(() => okAccount({ nickname: 'WorkBuddy Updated' })),
    ]).fetcher)
    const started = await reauthFlow.reauthenticate(accountId)
    const terminal = await waitForTerminal(reauthFlow, started.flowId)

    expect(terminal.status).toBe('completed')
    expect(terminal.account?.id).toBe(accountId)
    expect(terminal.account?.displayName).toBe('WorkBuddy Updated')
    expect(fixture.settingsDouble.getState().workbuddy.currentAccountId).toBe(accountId)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
    const entries = await fixture.store.listEntries('workbuddy')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.account?.secret).toMatchObject({
      accessToken: 'WB_ACCESS_2',
      refreshToken: 'WB_REFRESH_2',
    })
  })

  it('重新登录身份不一致时失败且不覆盖原账号', async () => {
    const fixture = createTencentAuthFixture()
    const firstFlow = fixture.createWorkbuddyFlow(createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ]).fetcher)
    const firstStarted = await firstFlow.start()
    const firstTerminal = await waitForTerminal(firstFlow, firstStarted.flowId)
    const accountId = firstTerminal.account!.id

    const reauthFlow = fixture.createWorkbuddyFlow(createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken({ accessToken: 'WB_ACCESS_2', refreshToken: 'WB_REFRESH_2' })),
      accountRoute(() => okAccount({ uid: 'wb-user-2', nickname: 'Other WorkBuddy' })),
    ]).fetcher)
    const started = await reauthFlow.reauthenticate(accountId)
    const terminal = await waitForTerminal(reauthFlow, started.flowId)

    expect(terminal.status).toBe('failed')
    expect(terminal.errorCode).toBe('auth/identity-mismatch')
    expect(terminal.account).toBeNull()
    const entries = await fixture.store.listEntries('workbuddy')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.account?.secret).toMatchObject({
      accessToken: 'WB_ACCESS_1',
      refreshToken: 'WB_REFRESH_1',
    })
    expect(fixture.settingsDouble.getState().workbuddy.currentAccountId).toBe(accountId)
  })

  it('重新登录不存在的账号时不发任何网络请求', async () => {
    const fixture = createTencentAuthFixture()
    const { fetcher, calls } = createScriptedFetcher([stateRoute()])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    await expect(flow.reauthenticate('a000000000000')).rejects.toMatchObject({
      code: 'auth/account-not-found',
    })
    expect(calls).toHaveLength(0)
    expect(fixture.credentials.writes).toHaveLength(0)
  })
})

describe('CodeBuddy 与 WorkBuddy 两渠道并存隔离', () => {
  it('两流程各自落码/设当前，flowId 状态与取消互不影响', async () => {
    const fixture = createTencentAuthFixture()
    const buddyGate = deferred<Response>()
    const workbuddyGate = deferred<Response>()
    const buddyFetcher = createScriptedFetcher([
      {
        when: (url) => url.includes('/v2/plugin/auth/state'),
        respond: () => jsonResponse({
          code: 0,
          data: {
            state: 'buddy-state',
            authUrl: 'https://www.codebuddy.cn/login/?platform=ide&state=buddy-state',
          },
        }),
      },
      tokenRoute(() => buddyGate.promise),
      accountRoute(() => jsonResponse({
        code: 0,
        data: { uid: 'buddy-user-1', nickname: 'Buddy One', enterpriseId: '', type: 'personal' },
      })),
    ])
    const workbuddyFetcher = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => workbuddyGate.promise),
      accountRoute(() => okAccount()),
    ])
    const buddyFlow = fixture.createBuddyFlow(buddyFetcher.fetcher)
    const workbuddyFlow = fixture.createWorkbuddyFlow(workbuddyFetcher.fetcher)

    const buddyStarted = await buddyFlow.start()
    const workbuddyStarted = await workbuddyFlow.start()
    await waitForCall(buddyFetcher.calls, (call) => call.url.includes('/auth/token'))
    await waitForCall(workbuddyFetcher.calls, (call) => call.url.includes('/auth/token'))

    expect(buddyStarted.flowId).toBe('buddy-flow-1')
    expect(workbuddyStarted.flowId).toBe('wb-flow-1')
    await expect(workbuddyFlow.status(buddyStarted.flowId)).rejects.toMatchObject({
      code: 'auth/flow-not-found',
    })
    await expect(buddyFlow.status(workbuddyStarted.flowId)).rejects.toMatchObject({
      code: 'auth/flow-not-found',
    })

    const cancelling = workbuddyFlow.cancel(workbuddyStarted.flowId)
    workbuddyGate.resolve(okToken())
    expect((await cancelling).status).toBe('cancelled')
    expect((await buddyFlow.status(buddyStarted.flowId)).status).toBe('pending')

    buddyGate.resolve(jsonResponse({
      code: 0,
      data: {
        accessToken: 'BUDDY_ACCESS_1',
        refreshToken: 'BUDDY_REFRESH_1',
        expiresIn: 3600,
        tokenType: 'Bearer',
        domain: 'copilot.tencent.com',
      },
    }))
    const buddyTerminal = await waitForTerminal(buddyFlow, buddyStarted.flowId)
    expect(buddyTerminal.status).toBe('completed')

    expect(await fixture.store.listEntries('buddy')).toHaveLength(1)
    expect(await fixture.store.listEntries('workbuddy')).toHaveLength(0)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(
      buddyTerminal.account?.id,
    )
    expect(fixture.settingsDouble.getState().workbuddy.currentAccountId).toBeNull()
    expect(buddyFetcher.calls.some((call) => call.url.includes('workbuddy.ai'))).toBe(false)
    expect(workbuddyFetcher.calls.some((call) => call.url.includes('copilot.tencent.com'))).toBe(
      false,
    )
  })

  it('两渠道刷新单飞 map、账号与秘密完全独立', async () => {
    const fixture = createTencentAuthFixture()
    const buddy = await seedAccount(fixture, {
      channel: 'buddy',
      vendor: 'shared-vendor',
      accessToken: 'BUDDY_ACCESS_1',
      refreshToken: 'BUDDY_REFRESH_1',
    })
    const workbuddy = await seedAccount(fixture, {
      channel: 'workbuddy',
      vendor: 'shared-vendor',
      accessToken: 'WB_ACCESS_1',
      refreshToken: 'WB_REFRESH_1',
    })
    expect(buddy.accountId).not.toBe(workbuddy.accountId)

    const buddyGate = deferred<void>()
    const workbuddyGate = deferred<void>()
    const buddyFetcher = createScriptedFetcher([
      refreshRoute(async () => {
        await buddyGate.promise
        return jsonResponse({
          code: 0,
          data: {
            accessToken: 'BUDDY_ACCESS_2',
            refreshToken: 'BUDDY_REFRESH_2',
            expiresIn: 3600,
            tokenType: 'Bearer',
            domain: 'copilot.tencent.com',
          },
        })
      }),
    ])
    const workbuddyFetcher = createScriptedFetcher([
      refreshRoute(async () => {
        await workbuddyGate.promise
        return okToken({ accessToken: 'WB_ACCESS_2', refreshToken: 'WB_REFRESH_2' })
      }),
    ])
    const buddyFlow = fixture.createBuddyFlow(buddyFetcher.fetcher)
    const workbuddyFlow = fixture.createWorkbuddyFlow(workbuddyFetcher.fetcher)

    const buddyRefreshing = buddyFlow.refresh(buddy.accountId)
    const workbuddyRefreshing = workbuddyFlow.refresh(workbuddy.accountId)
    await waitForCall(buddyFetcher.calls, (call) => call.url.includes('/auth/token/refresh'))
    await waitForCall(workbuddyFetcher.calls, (call) => call.url.includes('/auth/token/refresh'))

    buddyGate.resolve()
    workbuddyGate.resolve()
    await Promise.all([buddyRefreshing, workbuddyRefreshing])

    expect(buddyFetcher.calls.filter((call) => call.url.includes('/refresh'))).toHaveLength(1)
    expect(workbuddyFetcher.calls.filter((call) => call.url.includes('/refresh'))).toHaveLength(1)
    const buddyStored = await fixture.store.readEntry('buddy', buddy.accountId)
    const workbuddyStored = await fixture.store.readEntry('workbuddy', workbuddy.accountId)
    expect(buddyStored?.account?.secret).toMatchObject({
      accessToken: 'BUDDY_ACCESS_2',
      refreshToken: 'BUDDY_REFRESH_2',
    })
    expect(workbuddyStored?.account?.secret).toMatchObject({
      accessToken: 'WB_ACCESS_2',
      refreshToken: 'WB_REFRESH_2',
    })
  })

  it('两渠道使用相同 accountId 时刷新单飞仍按渠道隔离', async () => {
    const fixture = createTencentAuthFixture()
    const sharedAccountId = 'a000000000001'
    fixture.credentials.seed(accountRecordKey('buddy', sharedAccountId), {
      kind: 'grant',
      payload: {
        version: 1,
        channelId: 'buddy',
        accountId: sharedAccountId,
        vendorAccountId: 'shared-vendor',
        displayName: 'Buddy Shared',
        maskedIdentifier: 's***r',
        endpointLabel: 'copilot.tencent.com',
        status: 'ready',
        secret: { accessToken: 'BUDDY_ACCESS_1', refreshToken: 'BUDDY_REFRESH_1' },
      },
    })
    fixture.credentials.seed(accountRecordKey('workbuddy', sharedAccountId), {
      kind: 'grant',
      payload: {
        version: 1,
        channelId: 'workbuddy',
        accountId: sharedAccountId,
        vendorAccountId: 'shared-vendor',
        displayName: 'WorkBuddy Shared',
        maskedIdentifier: 's***r',
        endpointLabel: WB_DOMAIN,
        status: 'ready',
        secret: { accessToken: 'WB_ACCESS_1', refreshToken: 'WB_REFRESH_1' },
      },
    })

    const buddyGate = deferred<void>()
    const workbuddyGate = deferred<void>()
    const buddyFetcher = createScriptedFetcher([
      refreshRoute(async () => {
        await buddyGate.promise
        return jsonResponse({
          code: 0,
          data: {
            accessToken: 'BUDDY_ACCESS_2',
            refreshToken: 'BUDDY_REFRESH_2',
            expiresIn: 3600,
            tokenType: 'Bearer',
            domain: 'copilot.tencent.com',
          },
        })
      }),
    ])
    const workbuddyFetcher = createScriptedFetcher([
      refreshRoute(async () => {
        await workbuddyGate.promise
        return okToken({ accessToken: 'WB_ACCESS_2', refreshToken: 'WB_REFRESH_2' })
      }),
    ])
    const buddyFlow = fixture.createBuddyFlow(buddyFetcher.fetcher)
    const workbuddyFlow = fixture.createWorkbuddyFlow(workbuddyFetcher.fetcher)

    const buddyRefreshing = buddyFlow.refresh(sharedAccountId)
    const workbuddyRefreshing = workbuddyFlow.refresh(sharedAccountId)
    await waitForCall(buddyFetcher.calls, (call) => call.url.includes('/auth/token/refresh'))
    await waitForCall(workbuddyFetcher.calls, (call) => call.url.includes('/auth/token/refresh'))
    buddyGate.resolve()
    workbuddyGate.resolve()
    await Promise.all([buddyRefreshing, workbuddyRefreshing])

    expect(buddyFetcher.calls.filter((call) => call.url.includes('/refresh'))).toHaveLength(1)
    expect(workbuddyFetcher.calls.filter((call) => call.url.includes('/refresh'))).toHaveLength(1)
    const buddyStored = await fixture.store.readEntry('buddy', sharedAccountId)
    const workbuddyStored = await fixture.store.readEntry('workbuddy', sharedAccountId)
    expect(buddyStored?.account?.secret).toMatchObject({
      accessToken: 'BUDDY_ACCESS_2',
      refreshToken: 'BUDDY_REFRESH_2',
    })
    expect(workbuddyStored?.account?.secret).toMatchObject({
      accessToken: 'WB_ACCESS_2',
      refreshToken: 'WB_REFRESH_2',
    })
  })

  it('dispose 一个渠道的 flow 不影响另一渠道的 flow', async () => {
    const fixture = createTencentAuthFixture()
    const buddyFetcher = createScriptedFetcher([
      {
        when: (url) => url.includes('/v2/plugin/auth/state'),
        respond: () => jsonResponse({
          code: 0,
          data: {
            state: 'buddy-state',
            authUrl: 'https://www.codebuddy.cn/login/?platform=ide&state=buddy-state',
          },
        }),
      },
      tokenRoute(() => jsonResponse({
        code: 0,
        data: {
          accessToken: 'BUDDY_ACCESS_1',
          refreshToken: 'BUDDY_REFRESH_1',
          expiresIn: 3600,
          tokenType: 'Bearer',
          domain: 'copilot.tencent.com',
        },
      })),
      accountRoute(() => jsonResponse({
        code: 0,
        data: { uid: 'buddy-user-1', nickname: 'Buddy One', enterpriseId: '', type: 'personal' },
      })),
    ])
    const workbuddyFetcher = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const buddyFlow = fixture.createBuddyFlow(buddyFetcher.fetcher)
    const workbuddyFlow = fixture.createWorkbuddyFlow(workbuddyFetcher.fetcher)

    await workbuddyFlow.dispose()
    await expect(workbuddyFlow.start()).rejects.toMatchObject({ code: 'auth/disposed' })

    const buddyStarted = await buddyFlow.start()
    const buddyTerminal = await waitForTerminal(buddyFlow, buddyStarted.flowId)
    expect(buddyTerminal.status).toBe('completed')
    expect(buddyTerminal.account?.channelId).toBe('buddy')
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(
      buddyTerminal.account?.id,
    )
    expect(fixture.settingsDouble.getState().workbuddy.currentAccountId).toBeNull()
    expect(await fixture.store.listEntries('workbuddy')).toHaveLength(0)
    expect(workbuddyFetcher.calls).toHaveLength(0)
  })
})

describe('WorkBuddy 授权 RPC 分派与通用错误边界', () => {
  it('dispatchWorkbuddyAuthRpc 接受 workbuddy payload 并返回脱敏状态', async () => {
    const fixture = createTencentAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    const started = await dispatchWorkbuddyAuthRpc(flow, 'auth.start', {
      channel: 'workbuddy',
    }) as AuthFlowStatus
    expect(started.channel).toBe('workbuddy')
    expect(started.status).toBe('pending')
    expectNoSecret(started)

    const terminal = await waitForTerminal(flow, started.flowId)
    const queried = await dispatchWorkbuddyAuthRpc(flow, 'auth.status', {
      channel: 'workbuddy',
      flowId: started.flowId,
    }) as AuthFlowStatus
    expect(queried.status).toBe('completed')
    expect(queried.account?.channelId).toBe('workbuddy')
  })

  it('WorkBuddy dispatcher 收到 buddy payload 时在任何网络/账号工作前拒绝', async () => {
    const fixture = createTencentAuthFixture()
    const { fetcher, calls } = createScriptedFetcher([stateRoute()])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    const error = await dispatchWorkbuddyAuthRpc(flow, 'auth.start', {
      channel: 'buddy',
    }).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(AuthRpcValidationError)
    expect(error).toMatchObject({ code: 'auth/invalid' })
    expect(calls).toHaveLength(0)
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(fixture.settingsDouble.edits).toHaveLength(0)
  })

  it('Buddy dispatcher 收到 workbuddy payload 时在任何网络/账号工作前拒绝', async () => {
    const fixture = createTencentAuthFixture()
    const { fetcher, calls } = createScriptedFetcher([stateRoute()])
    const flow = fixture.createBuddyFlow(fetcher)

    const error = await dispatchBuddyAuthRpc(flow, 'auth.start', {
      channel: 'workbuddy',
    }).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(AuthRpcValidationError)
    expect(error).toMatchObject({ code: 'auth/invalid' })
    expect(calls).toHaveLength(0)
    expect(fixture.credentials.writes).toHaveLength(0)
  })

  it('拒绝未知键、非法 accountId 与未知渠道', () => {
    expect(() => assertAuthRpcPayload('auth.start', { channel: 'workbuddy' })).not.toThrow()
    expect(() => assertAuthRpcPayload('auth.start', { channel: 'buddy' })).not.toThrow()
    expect(() => assertAuthRpcPayload('auth.start', { channel: 'qoder' })).not.toThrow()
    expect(() => assertAuthRpcPayload('auth.start', { channel: 'qodercn' })).toThrow(
      AuthRpcValidationError,
    )
    expect(() => assertAuthRpcPayload('auth.start', {
      channel: 'workbuddy',
      extra: true,
    })).toThrow(AuthRpcValidationError)
    expect(() => assertAuthRpcPayload('auth.refresh', {
      channel: 'workbuddy',
      accountId: 'Bad_ID',
    })).toThrow(AuthRpcValidationError)
    expect(() => assertAuthRpcPayload('auth.status', {
      channel: 'workbuddy',
      flowId: 'Bad_ID',
    })).toThrow(AuthRpcValidationError)
  })

  it('结果守卫拒绝错渠道状态与夹带秘密的对象', () => {
    const account: AccountSummary = {
      id: 'a000000000000',
      displayName: 'Account',
      channelId: 'workbuddy',
      endpointLabel: WB_DOMAIN,
      status: 'ready',
      maskedIdentifier: 'w***1',
    }
    const status: AuthFlowStatus = {
      flowId: 'flow-1',
      channel: 'workbuddy',
      status: 'completed',
      authUrl: null,
      displayHint: 'hint',
      account,
      errorCode: null,
    }
    expect(isAuthFlowStatus(status)).toBe(true)
    expect(isAuthFlowStatusForChannel(status, 'workbuddy')).toBe(true)
    expect(isAuthFlowStatusForChannel(status, 'buddy')).toBe(false)
    expect(isAuthFlowStatus({ ...status, channel: 'buddy' })).toBe(false)
    expect(isAuthFlowStatus({ ...status, account: { ...account, channelId: 'buddy' } })).toBe(false)
    expect(isAuthFlowStatus({ ...status, accessToken: 'LEAK' })).toBe(false)
    expect(isAuthFlowStatus({ ...status, account: { ...account, secret: 'LEAK' } })).toBe(false)
  })

  it('dispatcher 对错误渠道/夹带秘密的结果返回固定 auth/internal，不泄漏对象', async () => {
    const fixture = createTencentAuthFixture()
    const wrongChannelFlow = {
      async start() {
        return {
          flowId: 'flow-1',
          channel: 'buddy',
          status: 'completed',
          authUrl: null,
          displayHint: 'hint',
          account: null,
          errorCode: null,
        }
      },
    } as unknown as WorkbuddyAuthFlow
    const leakingFlow = {
      async start() {
        return {
          flowId: 'flow-1',
          channel: 'workbuddy',
          status: 'completed',
          authUrl: null,
          displayHint: 'hint',
          account: null,
          errorCode: null,
          accessToken: 'LEAK',
        }
      },
    } as unknown as WorkbuddyAuthFlow

    for (const flow of [wrongChannelFlow, leakingFlow]) {
      const error = await dispatchWorkbuddyAuthRpc(flow, 'auth.start', {
        channel: 'workbuddy',
      }).catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(WorkbuddyAuthError)
      expect(error).toMatchObject({ code: 'auth/internal' })
      expect(JSON.stringify(error)).not.toContain('LEAK')
    }
  })

  it('Buddy/WorkBuddy 错误都是通用 AuthFlowError 子类且无 cause', () => {
    const buddy = new BuddyAuthError('auth/failed', 'CodeBuddy 授权失败')
    const workbuddy = new WorkbuddyAuthError('auth/failed', 'WorkBuddy 授权失败')
    expect(buddy).toBeInstanceOf(AuthFlowError)
    expect(workbuddy).toBeInstanceOf(AuthFlowError)
    expect(buddy.cause).toBeUndefined()
    expect(workbuddy.cause).toBeUndefined()
    expect(buddy.name).toBe('BuddyAuthError')
    expect(workbuddy.name).toBe('WorkbuddyAuthError')
  })
})

describe('WorkBuddy 取消落在持久化提交边界', () => {
  it('cancel 落在 saveAccount 的 modifyRecord 提交前：不写账号、不设当前', async () => {
    const fixture = createTencentAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)
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
    expect(await fixture.store.listEntries('workbuddy')).toHaveLength(0)
    expect(fixture.settingsDouble.getState().workbuddy.currentAccountId).toBeNull()
  })

  it('dispose 落在 setCurrent 的 configEditor 提交前：等待 settle 且不写当前', async () => {
    const fixture = createTencentAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)
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
    expect(await fixture.store.listEntries('workbuddy')).toHaveLength(1)
    expect(fixture.settingsDouble.getState().workbuddy.currentAccountId).toBeNull()
  })

  it('runWithAuthRetry 的 operation 收到可 abort signal；dispose 不启动第二次', async () => {
    const fixture = createTencentAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher } = createScriptedFetcher([stateRoute()])
    const flow = fixture.createWorkbuddyFlow(fetcher)
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
    const disposing = flow.dispose()
    await flush()
    release.resolve()
    await disposing

    expect(await running).toMatchObject({ code: 'auth/disposed' })
    expect(receivedSignal?.aborted).toBe(true)
    expect(operationCalls).toBe(1)
  })
})

describe('WorkBuddy 安全边界与畸形响应', () => {
  it('状态 DTO 只有七个脱敏字段，AccountSummary 只有六个', async () => {
    const fixture = createTencentAuthFixture()
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)
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

  it('token/account 上游错误正文不进入状态或错误对象', async () => {
    const fixture = createTencentAuthFixture()
    const sentinel = 'NON_REAL_WORKBUDDY_TOKEN_SENTINEL'
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => jsonResponse({ code: 500, message: sentinel }, 500)),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('failed')
    expect(terminal.errorCode).toBe('auth/failed')
    expect(JSON.stringify(terminal)).not.toContain(sentinel)
    expect(fixture.credentials.writes).toHaveLength(0)
  })

  it('workbuddy key 下的 buddy 伪造记录不会被覆盖', async () => {
    const fixture = createTencentAuthFixture()
    const existing = await seedAccount(fixture)
    const key = accountRecordKey('workbuddy', existing.accountId)
    fixture.credentials.seed(key, {
      kind: 'grant',
      payload: {
        version: 1,
        channelId: 'buddy',
        accountId: existing.accountId,
        vendorAccountId: 'wb-user-1',
        displayName: 'Forged Buddy',
        maskedIdentifier: 'w***1',
        endpointLabel: 'copilot.tencent.com',
        status: 'ready',
        secret: { accessToken: 'FORGED_ACCESS', refreshToken: 'FORGED_REFRESH' },
      },
    })
    const { fetcher } = createScriptedFetcher([
      stateRoute(),
      tokenRoute(() => okToken()),
      accountRoute(() => okAccount()),
    ])
    const flow = fixture.createWorkbuddyFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('failed')
    expect(terminal.errorCode).toBe('auth/failed')
    expect(terminal.account).toBeNull()
    const forged = fixture.credentials.raw(key)
    expect((forged?.payload as Record<string, unknown>).channelId).toBe('buddy')
    expect(
      ((forged?.payload as Record<string, unknown>).secret as Record<string, unknown>).accessToken,
    ).toBe('FORGED_ACCESS')
    expect(fixture.settingsDouble.getState().workbuddy.currentAccountId).toBeNull()
  })
})
