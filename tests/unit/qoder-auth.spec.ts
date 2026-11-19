/**
 * Task 11：Qoder 国际版独立设备授权、刷新、重新登录与签名配置。
 *
 * 所有网络都由脚本化 fetcher 提供；时钟、随机 flowId、设备会话（PKCE/nonce/
 * machineId）与请求超时信号都可注入。测试不接触真实厂商网络、真实凭据或真实
 * 浏览器。断言重点：
 *
 * - 设备授权使用国际版 `qoder.com` / `openapi.qoder.sh` 与精确 clientId，
 *   绝不出现中国版 clientId、`qoder.cn` 或 `gateway.qoder.com.cn`；
 * - 授权、刷新、重新登录只能由显式方法/RPC 触发；构造不自动启动；
 * - 成功只经 AccountStore 落 qoder grant（含签名所需 securityOauthToken、
 *   machineId、refreshToken 与过期材料），首个账号经 AccountService 设为当前；
 * - center/api2 端点偏好只属于搜索，授权/账号/刷新绝不读取或依赖它；
 * - 取消、超时、dispose 后没有迟到写入；取消落在 saveAccount/configEditor
 *   提交边界；
 * - 刷新按账号单飞，旧刷新不得覆盖新记录；
 * - 只有可信 HTTP 401 且 channel=qoder 才刷新同账号并重试原操作一次；
 * - Client 可见状态只含脱敏 flowId/状态/授权 URL/说明/AccountSummary。
 */
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  QODER_AUTH_URL_HOSTS,
  QODER_DEVICE_AUTH_BASE,
  QODER_DEVICE_OPEN_API_BASE,
  QODER_DEVICE_POLL_PATH,
  QODER_DEVICE_REFRESH_PATH,
  QODER_DEVICE_SELECT_PATH,
  QODER_INTERNATIONAL_CLIENT_ID,
  QoderDeviceAuthClient,
  QoderDeviceTokenError,
  buildQoderAuthUrl,
  buildQoderPollUrl,
  createQoderDeviceSession,
  createQoderPkce,
  normalizeQoderAuthUrl,
  parseQoderTokenPayload,
  type QoderDeviceSession,
} from '../../src/host/channels/qoder/auth-flow.ts'
import {
  QoderInternationalAuthError,
  QoderInternationalAuthFlow,
  type QoderCapabilityCredential,
  type QoderInternationalAuthFlowOptions,
} from '../../src/host/channels/qoder/auth.ts'
import { dispatchQoderInternationalAuthRpc } from '../../src/host/channels/qoder/auth-rpc.ts'
import { accountRecordKey } from '../../src/host/accounts/store.ts'
import { ChannelSearchError, normalizeChannelSearchError } from '../../src/host/search/errors.ts'
import type { AccountSummary } from '../../src/shared/accounts.ts'
import {
  assertAuthRpcPayload,
  AuthRpcValidationError,
  type AuthFlowStatus,
} from '../../src/shared/auth.ts'
import { createAccountFixture, type AccountFixture } from './support/account-fixture.ts'

const VERIFIER = 'V'.repeat(43)
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')

const SESSION: QoderDeviceSession = {
  pkce: { verifier: VERIFIER, challenge: CHALLENGE },
  nonce: 'nonce-abc',
  machineId: 'machine-abc',
}

const CHINA_CLIENT_ID = '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa'

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

/** 设备码轮询路由。 */
function pollRoute(response: () => Response | Promise<Response>): Route {
  return {
    when: (url) => url.includes(QODER_DEVICE_POLL_PATH),
    respond: response,
  }
}

/** 续期路由。 */
function refreshRoute(response: () => Response | Promise<Response>): Route {
  return {
    when: (url) => url.includes(QODER_DEVICE_REFRESH_PATH),
    respond: response,
  }
}

/** 设备码成功响应（真实字段名：token / refresh_token / user_id / user_name）。 */
function tokenBody(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    token: 'ACCESS_1',
    refresh_token: 'REFRESH_1',
    expires_at: '2030-01-01T00:00:00Z',
    refresh_token_expires_at: '2030-02-01T00:00:00Z',
    user_id: 'uid-1',
    user_name: 'Qoder User',
    ...overrides,
  }
}

/** 续期成功响应（真实字段名：device_token）。 */
function refreshBody(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    device_token: 'ACCESS_2',
    refresh_token: 'REFRESH_2',
    ...overrides,
  }
}

/** 默认成功响应。 */
function okToken(overrides: Readonly<Record<string, unknown>> = {}): Response {
  return jsonResponse(tokenBody(overrides))
}

/** 默认成功续期响应。 */
function okRefresh(overrides: Readonly<Record<string, unknown>> = {}): Response {
  return jsonResponse(refreshBody(overrides))
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
  flow: QoderInternationalAuthFlow,
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
interface QoderAuthFixture extends AccountFixture {
  readonly createFlow: (
    fetcher: typeof fetch,
    overrides?: Partial<QoderInternationalAuthFlowOptions>,
  ) => QoderInternationalAuthFlow
  readonly now: () => number
}

function createQoderAuthFixture(
  initial?: Parameters<typeof createAccountFixture>[0],
): QoderAuthFixture {
  const accounts = createAccountFixture(initial)
  let now = 1_000_000
  let nextFlow = 0
  const clock = {
    now: () => now,
    sleep: async (ms: number) => { now += Math.max(1, ms) },
  }
  const createFlow = (
    fetcher: typeof fetch,
    overrides: Partial<QoderInternationalAuthFlowOptions> = {},
  ): QoderInternationalAuthFlow => new QoderInternationalAuthFlow({
    store: accounts.store,
    accounts: accounts.service,
    fetcher,
    clock,
    randomId: () => `flow-${++nextFlow}`,
    createDeviceSession: () => SESSION,
    pollIntervalMs: 10,
    authTimeoutMs: 60_000,
    requestTimeoutMs: 5_000,
    // 测试不让每个请求挂真实 30s 定时器；取消/超时由流程级 deadline 覆盖。
    timeoutSignal: () => new AbortController().signal,
    verifyCapability: async () => { /* 默认能力探测成功；需要失败/延迟的用例显式覆盖 */ },
    ...overrides,
  })
  return { ...accounts, createFlow, now: () => now }
}

/** 预置一个账号；默认 qoder。 */
async function seedAccount(
  fixture: QoderAuthFixture,
  options: {
    readonly channel?: 'qoder' | 'qodercn' | 'buddy' | 'workbuddy'
    readonly vendor?: string
    readonly token?: string
    readonly refreshToken?: string
    readonly machineId?: string
    readonly uid?: string
  } = {},
) {
  return await fixture.store.saveAccount({
    channel: options.channel ?? 'qoder',
    vendorAccountId: options.vendor ?? 'uid-1',
    displayName: 'Seed Qoder',
    secret: {
      securityOauthToken: options.token ?? 'ACCESS_1',
      machineId: options.machineId ?? 'machine-abc',
      refreshToken: options.refreshToken ?? 'REFRESH_1',
      uid: options.uid ?? options.vendor ?? 'uid-1',
    },
  })
}

/**
 * 断言 Client 可见对象不含任何令牌/秘密字段或值。
 *
 * 规格 §7.2 的窄例外只允许 Qoder `machine_id` 作为发起流程授权 URL 的
 * `machine_id` 查询参数出现；授权 URL 之外仍按秘密值检查。
 *
 * ⚠️ `machineId` 是设备授权协议的一部分：真实 `machine_id` 查询参数必须出现在
 * 授权 URL 里（服务端据此绑定设备，续期也要原样回传），参考实现同样如此。
 * 因此这里只检查它**不以凭据字段/值**出现在状态的其他位置；授权 URL 的
 * `machine_id` 由 `expectMachineIdOnlyInAuthUrl` 专门验证。
 */
function expectNoSecret(value: unknown): void {
  const text = JSON.stringify(value)
  for (const marker of [
    'ACCESS_1',
    'ACCESS_2',
    'REFRESH_1',
    'REFRESH_2',
    'uid-1',
    'securityOauthToken',
    'refreshToken',
    'machineId',
    'secret',
  ]) {
    expect(text).not.toContain(marker)
  }
  if (typeof value === 'object' && value !== null && 'authUrl' in value) {
    const { authUrl, ...rest } = value as Record<string, unknown>
    expect(JSON.stringify(rest)).not.toContain('machine-abc')
    if (typeof authUrl === 'string') {
      expect(new URL(authUrl).searchParams.get('machine_id')).toBe('machine-abc')
    }
  }
}

/**
 * 规格 §7.2 的窄例外：`machine_id` 只允许作为本次 flow 授权 URL 的
 * `machine_id` 查询参数出现，且该 URL 只有协议固定参数。
 */
function expectMachineIdOnlyInAuthUrl(
  value: unknown,
  authUrl: string | null,
  machineId = SESSION.machineId,
): void {
  const serialized = JSON.stringify(value) ?? ''
  const occurrences = serialized.split(machineId).length - 1
  if (authUrl === null) {
    expect(occurrences, serialized).toBe(0)
    return
  }
  expect(occurrences, serialized).toBe(1)
  const parsed = new URL(authUrl)
  expect([...parsed.searchParams.keys()].sort()).toEqual([
    'challenge',
    'challenge_method',
    'client_id',
    'machine_id',
    'nonce',
  ])
  expect(parsed.searchParams.getAll('machine_id')).toEqual([machineId])
}

describe('Qoder 国际版设备授权协议参数', () => {
  it('使用国际版授权 host、openapi host 与精确 clientId，绝不含中国版参数', () => {
    expect(QODER_DEVICE_AUTH_BASE).toBe('https://qoder.com')
    expect(QODER_DEVICE_OPEN_API_BASE).toBe('https://openapi.qoder.sh')
    expect(QODER_INTERNATIONAL_CLIENT_ID).toBe('e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb')
    expect(QODER_AUTH_URL_HOSTS).toEqual(['qoder.com'])

    const authUrl = buildQoderAuthUrl(SESSION)
    expect(authUrl.startsWith(`https://qoder.com${QODER_DEVICE_SELECT_PATH}?`)).toBe(true)
    expect(authUrl).toContain(`client_id=${QODER_INTERNATIONAL_CLIENT_ID}`)
    expect(authUrl).toContain('challenge_method=S256')
    expect(authUrl).toContain(`challenge=${CHALLENGE}`)
    expect(authUrl).toContain(`nonce=${SESSION.nonce}`)
    expect(authUrl).toContain(`machine_id=${SESSION.machineId}`)
    expect(authUrl).not.toContain(CHINA_CLIENT_ID)
    expect(authUrl).not.toContain('qoder.cn')
    expect(authUrl).not.toContain('gateway.qoder.com.cn')

    const pollUrl = buildQoderPollUrl(SESSION)
    expect(pollUrl.startsWith(`https://openapi.qoder.sh${QODER_DEVICE_POLL_PATH}?`)).toBe(true)
    expect(pollUrl).toContain(`nonce=${SESSION.nonce}`)
    expect(pollUrl).toContain(`verifier=${VERIFIER}`)
    expect(pollUrl).toContain('challenge_method=S256')
    expect(pollUrl).not.toContain(CHINA_CLIENT_ID)
    expect(pollUrl).not.toContain('qoder.cn')
  })

  it('PKCE verifier 长度 43..128、challenge 为无 padding 的 base64url S256', () => {
    const pkce = createQoderPkce()
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43)
    expect(pkce.verifier.length).toBeLessThanOrEqual(128)
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9\-._~]+$/)
    expect(pkce.challenge).toBe(
      createHash('sha256').update(pkce.verifier).digest('base64url'),
    )
    expect(pkce.challenge).not.toContain('=')
  })

  it('PKCE 与设备会话可注入确定性随机源', () => {
    const bytes = (length: number) => new Uint8Array(length).fill(7)
    const pkce = createQoderPkce({ bytes, length: () => 43 })
    expect(pkce.verifier).toBe('H'.repeat(43))
    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'))

    const session = createQoderDeviceSession({
      pkce,
      nonce: 'injected-nonce',
      machineId: 'injected-machine',
    })
    expect(session).toEqual({ pkce, nonce: 'injected-nonce', machineId: 'injected-machine' })
  })

  it('授权 URL 只接受精确 qoder.com 的 https 地址', () => {
    expect(normalizeQoderAuthUrl(buildQoderAuthUrl(SESSION))).toBe(buildQoderAuthUrl(SESSION))
    for (const value of [
      '',
      'http://qoder.com/device/selectAccounts',
      'javascript:alert(1)',
      'https://evil.example/device/selectAccounts',
      'https://qoder.com.evil.example/device/selectAccounts',
      'https://evil-qoder.com/device/selectAccounts',
      'https://qoder.com:444/device/selectAccounts',
      'https://user:pass@qoder.com/device/selectAccounts',
      'https://qoder.com/device/selectAccounts#@evil.example',
      'https://qoder.cn/device/selectAccounts',
      'https://openapi.qoder.com.cn/device/selectAccounts',
      'https://gateway.qoder.com.cn/device/selectAccounts',
    ]) {
      expect(normalizeQoderAuthUrl(value), value).toBeUndefined()
    }
  })

  it('token 响应按真实字段解析 token/device_token、refresh 与身份', () => {
    expect(parseQoderTokenPayload(tokenBody())).toMatchObject({
      accessToken: 'ACCESS_1',
      refreshToken: 'REFRESH_1',
      uid: 'uid-1',
      userName: 'Qoder User',
      expiresAt: Date.parse('2030-01-01T00:00:00Z'),
      refreshTokenExpiresAt: Date.parse('2030-02-01T00:00:00Z'),
    })
    expect(parseQoderTokenPayload({ device_token: 'D', refreshToken: 'R' })).toMatchObject({
      accessToken: 'D',
      refreshToken: 'R',
    })
    expect(parseQoderTokenPayload({ access_token: 'A' }).accessToken).toBe('A')
    expect(parseQoderTokenPayload({}).accessToken).toBe('')
    expect(parseQoderTokenPayload(null).accessToken).toBe('')
  })
})

describe('Qoder 设备码轮询与续期客户端', () => {
  /** 构造可注入时钟的客户端。 */
  function createClient(fetcher: typeof fetch) {
    let now = 1_000_000
    const clock = {
      now: () => now,
      sleep: async (ms: number) => { now += Math.max(1, ms) },
    }
    const client = new QoderDeviceAuthClient({
      fetcher,
      clock,
      requestTimeoutMs: 5_000,
      timeoutSignal: () => new AbortController().signal,
    })
    return { client, now: () => now }
  }

  it('404 表示用户尚未授权，继续轮询；200 拿到 token 后返回', async () => {
    let attempts = 0
    const { fetcher, calls } = createScriptedFetcher([
      pollRoute(() => {
        attempts += 1
        if (attempts < 3) return new Response('{"errorCode":"NotFound"}', { status: 404 })
        return okToken()
      }),
    ])
    const { client, now } = createClient(fetcher)

    const payload = await client.pollDeviceToken(SESSION, {
      signal: new AbortController().signal,
      deadline: now() + 60_000,
      pollIntervalMs: 10,
    })

    expect(attempts).toBe(3)
    expect(payload.accessToken).toBe('ACCESS_1')
    expect(calls[0]!.url).toBe(buildQoderPollUrl(SESSION))
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.init.redirect).toBe('error')
    expect((calls[0]!.init.headers as Record<string, string>).Accept).toBe('application/json')
  })

  it('2xx 但尚无 token 时继续轮询', async () => {
    let attempts = 0
    const { fetcher } = createScriptedFetcher([
      pollRoute(() => {
        attempts += 1
        if (attempts < 2) return jsonResponse({})
        return okToken()
      }),
    ])
    const { client, now } = createClient(fetcher)

    await client.pollDeviceToken(SESSION, {
      signal: new AbortController().signal,
      deadline: now() + 60_000,
      pollIntervalMs: 10,
    })
    expect(attempts).toBe(2)
  })

  it('非 404 的失败状态立即失败，且不把上游正文带进错误', async () => {
    const sentinel = 'NON_REAL_QODER_POLL_BODY_SENTINEL'
    const { fetcher } = createScriptedFetcher([
      pollRoute(() => new Response(JSON.stringify({ message: sentinel }), { status: 500 })),
    ])
    const { client, now } = createClient(fetcher)

    const error = await client.pollDeviceToken(SESSION, {
      signal: new AbortController().signal,
      deadline: now() + 60_000,
      pollIntervalMs: 10,
    }).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(QoderDeviceTokenError)
    expect(error).toMatchObject({ code: 'failed' })
    expect(String((error as Error).message)).not.toContain(sentinel)
    expect(JSON.stringify(error)).not.toContain(sentinel)
    expect((error as { cause?: unknown }).cause).toBeUndefined()
  })

  it('轮询遇到一次网络错误后继续，最终成功', async () => {
    let attempts = 0
    const { fetcher } = createScriptedFetcher([
      pollRoute(() => {
        attempts += 1
        if (attempts === 1) throw new TypeError('network down')
        return okToken()
      }),
    ])
    const { client, now } = createClient(fetcher)

    const payload = await client.pollDeviceToken(SESSION, {
      signal: new AbortController().signal,
      deadline: now() + 60_000,
      pollIntervalMs: 10,
    })
    expect(payload.accessToken).toBe('ACCESS_1')
    expect(attempts).toBe(2)
  })

  it('整体 deadline 到期后抛 timeout', async () => {
    const { fetcher } = createScriptedFetcher([
      pollRoute(() => new Response('{"errorCode":"NotFound"}', { status: 404 })),
    ])
    const { client, now } = createClient(fetcher)

    await expect(client.pollDeviceToken(SESSION, {
      signal: new AbortController().signal,
      deadline: now() + 25,
      pollIntervalMs: 10,
    })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('调用方取消后立即抛 cancelled，且不再发请求', async () => {
    const { fetcher, calls } = createScriptedFetcher([pollRoute(() => okToken())])
    const { client, now } = createClient(fetcher)
    const controller = new AbortController()
    controller.abort()

    await expect(client.pollDeviceToken(SESSION, {
      signal: controller.signal,
      deadline: now() + 60_000,
      pollIntervalMs: 10,
    })).rejects.toMatchObject({ code: 'cancelled' })
    expect(calls).toHaveLength(0)
  })

  it('续期按真实协议 POST refresh，body 为 refresh_token + machine_id', async () => {
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okRefresh())])
    const { client } = createClient(fetcher)

    const payload = await client.refresh({
      refreshToken: 'REFRESH_1',
      machineId: 'machine-abc',
      signal: new AbortController().signal,
    })

    expect(payload).toMatchObject({ accessToken: 'ACCESS_2', refreshToken: 'REFRESH_2' })
    const call = calls[0]!
    expect(call.url).toBe(`${QODER_DEVICE_OPEN_API_BASE}${QODER_DEVICE_REFRESH_PATH}`)
    expect(call.init.method).toBe('POST')
    expect(call.init.redirect).toBe('error')
    const headers = call.init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Accept).toBe('application/json')
    expect(headers['User-Agent']).toBe('qoder/1.0.0')
    expect(JSON.parse(String(call.init.body))).toEqual({
      refresh_token: 'REFRESH_1',
      machine_id: 'machine-abc',
    })
  })

  it('续期 401/403 归为 reauth-required，5xx/网络失败归为 temporary', async () => {
    for (const status of [401, 403]) {
      const { fetcher } = createScriptedFetcher([
        refreshRoute(() => new Response('denied', { status })),
      ])
      const { client } = createClient(fetcher)
      await expect(client.refresh({
        refreshToken: 'REFRESH_1',
        machineId: 'machine-abc',
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'reauth-required' })
    }

    const { fetcher: failing } = createScriptedFetcher([
      refreshRoute(() => new Response('boom', { status: 503 })),
    ])
    await expect(createClient(failing).client.refresh({
      refreshToken: 'REFRESH_1',
      machineId: 'machine-abc',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'temporary' })

    const { fetcher: network } = createScriptedFetcher([
      refreshRoute(() => { throw new TypeError('network down') }),
    ])
    await expect(createClient(network).client.refresh({
      refreshToken: 'REFRESH_1',
      machineId: 'machine-abc',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'temporary' })
  })

  it('续期 200 但缺少 device_token 时视为必须重新登录', async () => {
    const { fetcher } = createScriptedFetcher([refreshRoute(() => jsonResponse({}))])
    const { client } = createClient(fetcher)

    await expect(client.refresh({
      refreshToken: 'REFRESH_1',
      machineId: 'machine-abc',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'reauth-required' })
  })
})

describe('Qoder 国际版授权生命周期', () => {
  it('构造时不自动启动；start 返回脱敏 flowId、pending 与国际版授权 URL', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher, calls } = createScriptedFetcher([
      pollRoute(() => okToken()),
    ])
    const flow = fixture.createFlow(fetcher)
    expect(calls).toHaveLength(0)

    const started = await flow.start()

    expect(started).toEqual({
      flowId: 'flow-1',
      channel: 'qoder',
      status: 'pending',
      authUrl: buildQoderAuthUrl(SESSION),
      displayHint: expect.stringContaining('浏览器'),
      account: null,
      errorCode: null,
    })
    expectNoSecret(started)
    expect(started.authUrl).not.toContain(CHINA_CLIENT_ID)
    expect(started.authUrl).not.toContain('qoder.cn')

    const terminal = await waitForTerminal(flow, started.flowId)
    expect(terminal.status).toBe('completed')
  })

  it('成功后只写 qoder grant，首个账号设为当前，签名秘密全部进入记录', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('completed')
    expect(terminal.errorCode).toBeNull()
    expect(terminal.account).toMatchObject({
      channelId: 'qoder',
      displayName: 'Qoder User',
      endpointLabel: 'center.qoder.sh',
      status: 'ready',
      maskedIdentifier: 'u***1',
    })
    expect(terminal.account?.id).toMatch(/^a[0-9a-f]{12}$/)
    expectNoSecret(terminal)

    const accountId = terminal.account!.id
    const entry = await fixture.store.readEntry('qoder', accountId)
    expect(entry?.account).toMatchObject({
      channelId: 'qoder',
      accountId,
      vendorAccountId: 'uid-1',
      displayName: 'Qoder User',
      status: 'ready',
    })
    expect(entry?.account?.secret).toMatchObject({
      securityOauthToken: 'ACCESS_1',
      machineId: 'machine-abc',
      refreshToken: 'REFRESH_1',
      expiresAtMs: Date.parse('2030-01-01T00:00:00Z'),
      refreshExpiresAtMs: Date.parse('2030-02-01T00:00:00Z'),
      uid: 'uid-1',
    })
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBe(accountId)
    expect(fixture.credentials.writes).toHaveLength(1)
    expect(fixture.credentials.writes[0]).toBe(`dsh-web-search-channels/qoder-${accountId}`)
  })

  it('已有活动流程时拒绝第二个 start，取消后不再拒绝', async () => {
    const fixture = createQoderAuthFixture()
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([pollRoute(() => gate.promise)])
    const flow = fixture.createFlow(fetcher)

    const first = await flow.start()
    await waitForCall(calls, (call) => call.url.includes(QODER_DEVICE_POLL_PATH))

    await expect(flow.start()).rejects.toMatchObject({ code: 'auth/flow-active' })

    const cancelling = flow.cancel(first.flowId)
    gate.resolve(okToken())
    const cancelled = await cancelling
    expect(cancelled.status).toBe('cancelled')

    const secondFlow = fixture.createFlow(createScriptedFetcher([
      pollRoute(() => okToken()),
    ]).fetcher)
    const second = await secondFlow.start()
    expect(second.status).toBe('pending')
    expect((await waitForTerminal(secondFlow, second.flowId)).status).toBe('completed')
  })

  it('start 携带 accountId 时走重新登录并复用账号 ID', async () => {
    const fixture = createQoderAuthFixture()
    const firstFlow = fixture.createFlow(createScriptedFetcher([pollRoute(() => okToken())]).fetcher)
    const firstStarted = await firstFlow.start()
    const firstTerminal = await waitForTerminal(firstFlow, firstStarted.flowId)
    const accountId = firstTerminal.account!.id

    const reauthFlow = fixture.createFlow(createScriptedFetcher([
      pollRoute(() => okToken({ token: 'ACCESS_2', refresh_token: 'REFRESH_2' })),
    ]).fetcher)
    const started = await reauthFlow.start({ accountId })
    const terminal = await waitForTerminal(reauthFlow, started.flowId)

    expect(terminal.status).toBe('completed')
    expect(terminal.account?.id).toBe(accountId)
    expect(await fixture.store.listEntries('qoder')).toHaveLength(1)
  })

  it('后续账号成功不自动替换当前账号', async () => {
    const fixture = createQoderAuthFixture()
    const firstFlow = fixture.createFlow(createScriptedFetcher([
      pollRoute(() => okToken()),
    ]).fetcher)
    const firstStarted = await firstFlow.start()
    const firstTerminal = await waitForTerminal(firstFlow, firstStarted.flowId)
    const firstId = firstTerminal.account!.id

    const secondFlow = fixture.createFlow(createScriptedFetcher([
      pollRoute(() => okToken({
        token: 'ACCESS_2',
        refresh_token: 'REFRESH_2',
        user_id: 'uid-2',
        user_name: 'Qoder Two',
      })),
    ]).fetcher)
    const secondStarted = await secondFlow.start()
    const secondTerminal = await waitForTerminal(secondFlow, secondStarted.flowId)

    expect(secondTerminal.status).toBe('completed')
    expect(secondTerminal.account?.id).not.toBe(firstId)
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBe(firstId)
    expect((await fixture.store.listEntries('qoder')).map(entry => entry.accountId).sort()).toEqual(
      [firstId, secondTerminal.account!.id].sort(),
    )
  })

  it('同厂商身份重复登录复用账号 ID 并更新秘密（身份去重）', async () => {
    const fixture = createQoderAuthFixture()
    const firstFlow = fixture.createFlow(createScriptedFetcher([pollRoute(() => okToken())]).fetcher)
    const firstStarted = await firstFlow.start()
    const firstTerminal = await waitForTerminal(firstFlow, firstStarted.flowId)
    const accountId = firstTerminal.account!.id

    const secondFlow = fixture.createFlow(createScriptedFetcher([
      pollRoute(() => okToken({
        token: 'ACCESS_2',
        refresh_token: 'REFRESH_2',
        user_name: 'Qoder Renamed',
      })),
    ]).fetcher)
    const secondStarted = await secondFlow.start()
    const secondTerminal = await waitForTerminal(secondFlow, secondStarted.flowId)

    expect(secondTerminal.status).toBe('completed')
    expect(secondTerminal.account?.id).toBe(accountId)
    expect(secondTerminal.account?.displayName).toBe('Qoder Renamed')
    expect(await fixture.store.listEntries('qoder')).toHaveLength(1)
    const entry = await fixture.store.readEntry('qoder', accountId)
    expect(entry?.account?.secret).toMatchObject({
      securityOauthToken: 'ACCESS_2',
      refreshToken: 'REFRESH_2',
      machineId: 'machine-abc',
      uid: 'uid-1',
    })
  })

  it('缺少 user_id 时失败且不落码', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([
      pollRoute(() => okToken({ user_id: '', user_name: '' })),
    ])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('failed')
    expect(terminal.errorCode).toBe('auth/invalid-response')
    expect(terminal.account).toBeNull()
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBeNull()
  })

  it('只写 qoder：buddy/workbuddy/qodercn 账号与当前账号完全不受影响', async () => {
    const fixture = createQoderAuthFixture()
    const buddy = await seedAccount(fixture, {
      channel: 'buddy',
      vendor: 'buddy-user',
      token: 'BUDDY_TOKEN',
      refreshToken: 'BUDDY_REFRESH',
    })
    const workbuddy = await seedAccount(fixture, {
      channel: 'workbuddy',
      vendor: 'wb-user',
      token: 'WB_TOKEN',
      refreshToken: 'WB_REFRESH',
    })
    const qodercn = await seedAccount(fixture, {
      channel: 'qodercn',
      vendor: 'cn-user',
      token: 'CN_TOKEN',
      refreshToken: 'CN_REFRESH',
    })
    const { fetcher, calls } = createScriptedFetcher([pollRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('completed')
    for (const [channel, seeded] of [
      ['buddy', buddy],
      ['workbuddy', workbuddy],
      ['qodercn', qodercn],
    ] as const) {
      const stored = await fixture.store.readEntry(channel, seeded.accountId)
      expect(stored?.account?.secret).toMatchObject({
        securityOauthToken: channel === 'buddy' ? 'BUDDY_TOKEN'
          : channel === 'workbuddy' ? 'WB_TOKEN' : 'CN_TOKEN',
      })
      expect(fixture.settingsDouble.getState()[channel].currentAccountId).toBeNull()
    }
    const qoderWrites = fixture.credentials.writes.filter(key => key.includes('/qoder-'))
    expect(qoderWrites).toHaveLength(1)
    expect(fixture.credentials.writes.filter(key => !key.includes('/qoder-'))).toHaveLength(3)
    expect(calls.every(call => call.url.startsWith('https://openapi.qoder.sh'))).toBe(true)
    expect(calls.some(call => call.url.includes('qoder.cn'))).toBe(false)
  })

  it('已有记录缺签名材料时不算可用账号，首个新账号仍设为当前', async () => {
    const fixture = createQoderAuthFixture()
    const unusable = await fixture.store.saveAccount({
      channel: 'qoder',
      vendorAccountId: 'empty-secret-user',
      secret: {},
    })
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('completed')
    expect(terminal.account?.id).not.toBe(unusable.accountId)
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBe(terminal.account?.id)
  })

  it('首个账号写当前失败时返回 auth/current-account-failed，账号保留但不设当前', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
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
    expect(await fixture.store.listEntries('qoder')).toHaveLength(1)
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBeNull()
  })

  it('授权过程绝不读取 center/api2 搜索端点偏好', async () => {
    const fixture = createQoderAuthFixture({
      qoder: { currentAccountId: null, endpointPreference: 'api2' },
    })
    const { fetcher, calls } = createScriptedFetcher([pollRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('completed')
    for (const call of calls) {
      const host = new URL(call.url).hostname
      expect(host).toBe('openapi.qoder.sh')
    }
    expect(calls.some(call => call.url.includes('center.qoder.sh'))).toBe(false)
    expect(calls.some(call => call.url.includes('api2.qoder.sh'))).toBe(false)
    expect(fixture.settingsDouble.getState().qoder.endpointPreference).toBe('api2')
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBe(terminal.account?.id)
  })

  it('搜索换域不改变授权账号或签名秘密', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)
    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)
    const accountId = terminal.account!.id
    const before = await fixture.store.readEntry('qoder', accountId)

    await fixture.settings.updateSearch({ endpointPreference: 'center' })
    await fixture.settings.updateSearch({ endpointPreference: 'api2' })

    const after = await fixture.store.readEntry('qoder', accountId)
    expect(after?.account?.secret).toEqual(before?.account?.secret)
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBe(accountId)
  })
})

describe('Qoder 保存前能力探测', () => {
  it('身份验证后、保存前调用 verifyCapability 并传入签名凭据与 signal', async () => {
    const fixture = createQoderAuthFixture()
    let probed: QoderCapabilityCredential | undefined
    let probedSignal: AbortSignal | undefined
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
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
      channelId: 'qoder',
      vendorAccountId: 'uid-1',
      credential: {
        securityOauthToken: 'ACCESS_1',
        machineId: 'machine-abc',
        uid: 'uid-1',
      },
    })
    expect(probedSignal).toBeInstanceOf(AbortSignal)
    expect(await fixture.store.listEntries('qoder')).toHaveLength(1)
  })

  it('能力探测失败时不落码、不设当前', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher, {
      verifyCapability: async () => {
        throw new Error('account has no qoder search permission')
      },
    })

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('failed')
    expect(terminal.errorCode).toBe('auth/failed')
    expect(terminal.account).toBeNull()
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(await fixture.store.listEntries('qoder')).toHaveLength(0)
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBeNull()
  })

  it('能力探测超时不落码、不设当前', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
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
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBeNull()
  })

  it('能力探测期间取消：不落码、不设当前', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
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
    expect(await fixture.store.listEntries('qoder')).toHaveLength(0)
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBeNull()
  })

  it('verifyCapability 不可省略', () => {
    const fixture = createQoderAuthFixture()
    expect(() => new QoderInternationalAuthFlow({
      store: fixture.store,
      accounts: fixture.service,
    } as never)).toThrow(TypeError)
  })
})

describe('Qoder 取消、超时与卸载', () => {
  it('取消后迟到的 token 响应不得写账号或当前账号', async () => {
    const fixture = createQoderAuthFixture()
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([pollRoute(() => gate.promise)])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    await waitForCall(calls, (call) => call.url.includes(QODER_DEVICE_POLL_PATH))

    const cancelling = flow.cancel(started.flowId)
    gate.resolve(okToken())
    const cancelled = await cancelling
    await flush()

    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.errorCode).toBe('auth/cancelled')
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(await fixture.store.listEntries('qoder')).toHaveLength(0)
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBeNull()
    expect((await flow.status(started.flowId)).status).toBe('cancelled')
  })

  it('cancel 对已完成流程幂等返回 completed，不改变已落码账号', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)
    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    const cancelled = await flow.cancel(started.flowId)

    expect(cancelled.status).toBe('completed')
    expect(cancelled.account).toEqual(terminal.account)
    expect(await fixture.store.listEntries('qoder')).toHaveLength(1)
  })

  it('未知 flowId 的 cancel/status 返回 flow-not-found', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)

    await expect(flow.cancel('flow-404')).rejects.toMatchObject({ code: 'auth/flow-not-found' })
    await expect(flow.status('flow-404')).rejects.toMatchObject({ code: 'auth/flow-not-found' })
  })

  it('轮询超时进入 timed_out 且不写账号', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher, calls } = createScriptedFetcher([
      pollRoute(() => new Response('{"errorCode":"NotFound"}', { status: 404 })),
    ])
    const flow = fixture.createFlow(fetcher, { authTimeoutMs: 100, pollIntervalMs: 10 })

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('timed_out')
    expect(terminal.errorCode).toBe('auth/timeout')
    expect(calls.filter((call) => call.url.includes(QODER_DEVICE_POLL_PATH)).length)
      .toBeGreaterThan(1)
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBeNull()
  })

  it('dispose 停止轮询、等待 settle，迟到响应不写账号；dispose 后拒绝新任务', async () => {
    const fixture = createQoderAuthFixture()
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([pollRoute(() => gate.promise)])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    await waitForCall(calls, (call) => call.url.includes(QODER_DEVICE_POLL_PATH))

    const disposing = flow.dispose()
    gate.resolve(okToken())
    await disposing
    await flush()

    expect((await flow.status(started.flowId)).status).toBe('cancelled')
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBeNull()
    await expect(flow.start()).rejects.toMatchObject({ code: 'auth/disposed' })
    await expect(flow.reauthenticate('a000000000000')).rejects.toMatchObject({
      code: 'auth/disposed',
    })
  })

  it('dispose 等待 reauthenticate 的预读 settle，且不启动新流程', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const originalRead = fixture.store.readEntry.bind(fixture.store)
    const entered = deferred<void>()
    const release = deferred<void>()
    let gate = true
    fixture.store.readEntry = async (channel, accountId) => {
      if (gate && channel === 'qoder' && accountId === account.accountId) {
        gate = false
        entered.resolve()
        await release.promise
      }
      return await originalRead(channel, accountId)
    }
    const { fetcher, calls } = createScriptedFetcher([pollRoute(() => okToken())])
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
    expect(calls).toHaveLength(0)
    expect(fixture.credentials.writes).toHaveLength(writesBefore)
  })

  it('dispose 等待 runWithAuthRetry 的首次 credential resolve，且不启动 operation', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const originalRead = fixture.store.readEntry.bind(fixture.store)
    const entered = deferred<void>()
    const release = deferred<void>()
    let gate = true
    fixture.store.readEntry = async (channel, accountId) => {
      if (gate && channel === 'qoder' && accountId === account.accountId) {
        gate = false
        entered.resolve()
        await release.promise
      }
      return await originalRead(channel, accountId)
    }
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
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
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
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
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher } = createScriptedFetcher([refreshRoute(() => okRefresh())])
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
      if (refreshDone && gate && channel === 'qoder' && accountId === account.accountId) {
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
        throw new ChannelSearchError('UNAUTHORIZED', 'qoder', '401', undefined, 401)
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
})

describe('Qoder 刷新单飞与旧刷新保护', () => {
  it('刷新使用国际版协议并轮换 securityOauthToken/refreshToken，保留 machineId/uid', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okRefresh())])
    const flow = fixture.createFlow(fetcher)

    const summary = await flow.refresh(account.accountId)

    expect(summary.id).toBe(account.accountId)
    expect(summary.channelId).toBe('qoder')
    const call = calls.find((candidate) => candidate.url.includes(QODER_DEVICE_REFRESH_PATH))
    expect(call?.url).toBe(`${QODER_DEVICE_OPEN_API_BASE}${QODER_DEVICE_REFRESH_PATH}`)
    expect(call?.init.method).toBe('POST')
    const stored = await fixture.store.readEntry('qoder', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      securityOauthToken: 'ACCESS_2',
      refreshToken: 'REFRESH_2',
      machineId: 'machine-abc',
      uid: 'uid-1',
    })
    expect(stored?.account?.status).toBe('ready')
  })

  it('并发刷新同一账号只发一次网络请求，双方拿到同一 AccountSummary', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const gate = deferred<void>()
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(async () => {
        await gate.promise
        return okRefresh()
      }),
    ])
    const flow = fixture.createFlow(fetcher)

    const first = flow.refresh(account.accountId)
    const second = flow.refresh(account.accountId)
    await waitForCall(calls, (call) => call.url.includes(QODER_DEVICE_REFRESH_PATH))
    gate.resolve()

    const [left, right] = await Promise.all([first, second])
    expect(left).toEqual(right)
    expect(calls.filter((call) => call.url.includes(QODER_DEVICE_REFRESH_PATH))).toHaveLength(1)
    const stored = await fixture.store.readEntry('qoder', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      securityOauthToken: 'ACCESS_2',
      refreshToken: 'REFRESH_2',
    })
  })

  it('旧刷新迟到时以 modifyRecord 当前记录为准，不覆盖新 refreshToken', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => gate.promise)])
    const flow = fixture.createFlow(fetcher)

    const refreshing = flow.refresh(account.accountId)
    await waitForCall(calls, (call) => call.url.includes(QODER_DEVICE_REFRESH_PATH))

    await fixture.store.saveAccount({
      channel: 'qoder',
      vendorAccountId: 'uid-1',
      secret: {
        securityOauthToken: 'ACCESS_NEW',
        machineId: 'machine-abc',
        refreshToken: 'REFRESH_NEW',
        uid: 'uid-1',
      },
    })
    gate.resolve(okRefresh())
    const summary = await refreshing

    expect(summary.id).toBe(account.accountId)
    const stored = await fixture.store.readEntry('qoder', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      securityOauthToken: 'ACCESS_NEW',
      refreshToken: 'REFRESH_NEW',
    })
  })

  it('刷新明确 401 时标记 reauth_required、抛固定错误且不重试', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const sentinel = 'NON_REAL_QODER_REFRESH_SENTINEL'
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(() => jsonResponse({ message: sentinel }, 401)),
    ])
    const flow = fixture.createFlow(fetcher)

    const error = await flow.refresh(account.accountId).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(QoderInternationalAuthError)
    expect(error).toMatchObject({ code: 'auth/reauth-required' })
    expect(String((error as Error).message)).not.toContain(sentinel)
    expect(JSON.stringify(error)).not.toContain(sentinel)
    expect(JSON.stringify(error)).not.toContain('machine-abc')
    expect((error as { cause?: unknown }).cause).toBeUndefined()
    expect(calls.filter((call) => call.url.includes(QODER_DEVICE_REFRESH_PATH))).toHaveLength(1)
    const stored = await fixture.store.readEntry('qoder', account.accountId)
    expect(stored?.account?.status).toBe('reauth_required')
    expect(stored?.account?.secret).toMatchObject({
      securityOauthToken: 'ACCESS_1',
      refreshToken: 'REFRESH_1',
    })
  })

  it('旧 401 迟到时 CAS 不覆盖已轮换的新记录状态', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => gate.promise)])
    const flow = fixture.createFlow(fetcher)

    const refreshing = flow.refresh(account.accountId).catch((failure: unknown) => failure)
    await waitForCall(calls, (call) => call.url.includes(QODER_DEVICE_REFRESH_PATH))
    await fixture.store.saveAccount({
      channel: 'qoder',
      vendorAccountId: 'uid-1',
      secret: {
        securityOauthToken: 'ACCESS_NEW',
        machineId: 'machine-abc',
        refreshToken: 'REFRESH_NEW',
        uid: 'uid-1',
      },
    })
    gate.resolve(new Response('expired', { status: 401 }))

    expect(await refreshing).toMatchObject({ code: 'auth/reauth-required' })
    const stored = await fixture.store.readEntry('qoder', account.accountId)
    expect(stored?.account?.status).toBe('ready')
    expect(stored?.account?.secret).toMatchObject({
      securityOauthToken: 'ACCESS_NEW',
      refreshToken: 'REFRESH_NEW',
    })
  })

  it('刷新暂时失败标记 temporarily_unavailable、不写秘密且不重试', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(() => jsonResponse({ message: 'upstream down' }, 502)),
    ])
    const flow = fixture.createFlow(fetcher)

    await expect(flow.refresh(account.accountId)).rejects.toMatchObject({
      code: 'auth/refresh-failed',
    })
    expect(calls.filter((call) => call.url.includes(QODER_DEVICE_REFRESH_PATH))).toHaveLength(1)
    const stored = await fixture.store.readEntry('qoder', account.accountId)
    expect(stored?.account?.status).toBe('temporarily_unavailable')
    expect(stored?.account?.secret).toMatchObject({
      securityOauthToken: 'ACCESS_1',
      refreshToken: 'REFRESH_1',
    })
  })

  it('无 refreshToken 直接进入 reauth_required 且不发网络', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture, { refreshToken: '' })
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okRefresh())])
    const flow = fixture.createFlow(fetcher)

    await expect(flow.refresh(account.accountId)).rejects.toMatchObject({
      code: 'auth/reauth-required',
    })
    expect(calls).toHaveLength(0)
    const stored = await fixture.store.readEntry('qoder', account.accountId)
    expect(stored?.account?.status).toBe('reauth_required')
  })

  it('刷新响应未下发新 refreshToken 时保留旧 refreshToken', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher } = createScriptedFetcher([
      refreshRoute(() => okRefresh({ refresh_token: undefined })),
    ])
    const flow = fixture.createFlow(fetcher)

    const summary = await flow.refresh(account.accountId)

    expect(summary.id).toBe(account.accountId)
    const stored = await fixture.store.readEntry('qoder', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      securityOauthToken: 'ACCESS_2',
      refreshToken: 'REFRESH_1',
      machineId: 'machine-abc',
      uid: 'uid-1',
    })
  })

  it('刷新不存在或跨渠道账号返回 account-not-found，且不触碰其他渠道记录', async () => {
    const fixture = createQoderAuthFixture()
    const foreign = await seedAccount(fixture, {
      channel: 'qodercn',
      vendor: 'cn-user',
      token: 'CN_ACCESS',
      refreshToken: 'CN_REFRESH',
    })
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okRefresh())])
    const flow = fixture.createFlow(fetcher)

    await expect(flow.refresh(foreign.accountId)).rejects.toMatchObject({
      code: 'auth/account-not-found',
    })
    expect(calls).toHaveLength(0)
    const stored = await fixture.store.readEntry('qodercn', foreign.accountId)
    expect(stored?.account?.secret).toMatchObject({
      securityOauthToken: 'CN_ACCESS',
      refreshToken: 'CN_REFRESH',
    })
  })

  it('刷新响应畸形时保持原秘密，不写入空令牌', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher } = createScriptedFetcher([refreshRoute(() => jsonResponse({}))])
    const flow = fixture.createFlow(fetcher)

    await expect(flow.refresh(account.accountId)).rejects.toMatchObject({
      code: 'auth/reauth-required',
    })
    const stored = await fixture.store.readEntry('qoder', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      securityOauthToken: 'ACCESS_1',
      refreshToken: 'REFRESH_1',
    })
  })

  it('dispose 取消在飞刷新并等待 settle，迟到响应不写凭据', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const gate = deferred<Response>()
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => gate.promise)])
    const flow = fixture.createFlow(fetcher)

    const refreshing = flow.refresh(account.accountId).catch((error: unknown) => error)
    await waitForCall(calls, (call) => call.url.includes(QODER_DEVICE_REFRESH_PATH))

    const disposing = flow.dispose()
    gate.resolve(okRefresh())
    await disposing
    const error = await refreshing

    expect(error).toMatchObject({ code: 'auth/disposed' })
    const stored = await fixture.store.readEntry('qoder', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      securityOauthToken: 'ACCESS_1',
      refreshToken: 'REFRESH_1',
    })
    await expect(flow.refresh(account.accountId)).rejects.toMatchObject({
      code: 'auth/disposed',
    })
  })
})

describe('Qoder 重新登录', () => {
  it('同渠道同厂商身份复用账号 ID、更新秘密并保持当前账号', async () => {
    const fixture = createQoderAuthFixture()
    const firstFlow = fixture.createFlow(createScriptedFetcher([pollRoute(() => okToken())]).fetcher)
    const firstStarted = await firstFlow.start()
    const firstTerminal = await waitForTerminal(firstFlow, firstStarted.flowId)
    const accountId = firstTerminal.account!.id

    const reauthFlow = fixture.createFlow(createScriptedFetcher([
      pollRoute(() => okToken({
        token: 'ACCESS_2',
        refresh_token: 'REFRESH_2',
        user_name: 'Qoder Updated',
      })),
    ]).fetcher)
    const started = await reauthFlow.reauthenticate(accountId)
    const terminal = await waitForTerminal(reauthFlow, started.flowId)

    expect(terminal.status).toBe('completed')
    expect(terminal.account?.id).toBe(accountId)
    expect(terminal.account?.displayName).toBe('Qoder Updated')
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBe(accountId)
    const entries = await fixture.store.listEntries('qoder')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.account?.secret).toMatchObject({
      securityOauthToken: 'ACCESS_2',
      refreshToken: 'REFRESH_2',
    })
  })

  it('重新登录身份不一致时失败且不覆盖原账号', async () => {
    const fixture = createQoderAuthFixture()
    const firstFlow = fixture.createFlow(createScriptedFetcher([pollRoute(() => okToken())]).fetcher)
    const firstStarted = await firstFlow.start()
    const firstTerminal = await waitForTerminal(firstFlow, firstStarted.flowId)
    const accountId = firstTerminal.account!.id

    const reauthFlow = fixture.createFlow(createScriptedFetcher([
      pollRoute(() => okToken({
        token: 'ACCESS_2',
        refresh_token: 'REFRESH_2',
        user_id: 'uid-2',
        user_name: 'Other User',
      })),
    ]).fetcher)
    const started = await reauthFlow.reauthenticate(accountId)
    const terminal = await waitForTerminal(reauthFlow, started.flowId)

    expect(terminal.status).toBe('failed')
    expect(terminal.errorCode).toBe('auth/identity-mismatch')
    expect(terminal.account).toBeNull()
    const entries = await fixture.store.listEntries('qoder')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.account?.secret).toMatchObject({
      securityOauthToken: 'ACCESS_1',
      refreshToken: 'REFRESH_1',
    })
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBe(accountId)
  })

  it('重新登录不存在的账号时不发任何网络请求', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher, calls } = createScriptedFetcher([pollRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)

    await expect(flow.reauthenticate('a000000000000')).rejects.toMatchObject({
      code: 'auth/account-not-found',
    })
    expect(calls).toHaveLength(0)
    expect(fixture.credentials.writes).toHaveLength(0)
  })
})

describe('Qoder 401 同账号重试一次', () => {
  it('可信 qoder+HTTP 401 时刷新同一账号并重试原操作一次', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okRefresh())])
    const flow = fixture.createFlow(fetcher)
    const seen: string[] = []
    let attempts = 0

    const result = await flow.runWithAuthRetry(account.accountId, async (credential) => {
      expect(credential.channelId).toBe('qoder')
      expect(credential.accountId).toBe(account.accountId)
      seen.push(credential.credential.securityOauthToken)
      attempts += 1
      if (attempts === 1) {
        throw new ChannelSearchError('UNAUTHORIZED', 'qoder', 'upstream 401', undefined, 401)
      }
      return 'search-ok'
    })

    expect(result).toBe('search-ok')
    expect(seen).toEqual(['ACCESS_1', 'ACCESS_2'])
    expect(calls.filter((call) => call.url.includes(QODER_DEVICE_REFRESH_PATH))).toHaveLength(1)
    const stored = await fixture.store.readEntry('qoder', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      securityOauthToken: 'ACCESS_2',
      refreshToken: 'REFRESH_2',
    })
  })

  it('非 401 错误不刷新、不重试', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okRefresh())])
    const flow = fixture.createFlow(fetcher)
    const timeoutError = new ChannelSearchError('TIMEOUT', 'qoder', 'upstream timeout')
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
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okRefresh())])
    const flow = fixture.createFlow(fetcher)
    const businessError = new ChannelSearchError('UNAUTHORIZED', 'qoder', 'business code')
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
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okRefresh())])
    const flow = fixture.createFlow(fetcher)

    for (const httpStatus of [403, 429]) {
      let attempts = 0
      const error = await flow.runWithAuthRetry(account.accountId, async () => {
        attempts += 1
        throw new ChannelSearchError('UNAUTHORIZED', 'qoder', 'not 401', undefined, httpStatus)
      }).catch((failure: unknown) => failure)
      expect(error).toMatchObject({ code: 'UNAUTHORIZED', httpStatus })
      expect(attempts).toBe(1)
    }
    expect(calls).toHaveLength(0)
  })

  it('跨渠道 401 不刷新、不重试', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okRefresh())])
    const flow = fixture.createFlow(fetcher)
    const foreign = new ChannelSearchError('UNAUTHORIZED', 'qodercn', 'foreign 401', undefined, 401)
    let attempts = 0

    const error = await flow.runWithAuthRetry(account.accountId, async () => {
      attempts += 1
      throw foreign
    }).catch((failure: unknown) => failure)

    expect(error).toBe(foreign)
    expect(attempts).toBe(1)
    expect(calls).toHaveLength(0)
  })

  it('共享 normalize 从实际 HTTP 401 产生的 UNAUTHORIZED 可以刷新重试', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okRefresh())])
    const flow = fixture.createFlow(fetcher)
    const unauthorized = normalizeChannelSearchError(
      { status: 401, code: 'UNAUTHORIZED', message: 'raw upstream text' },
      'qoder',
    )
    let attempts = 0

    const result = await flow.runWithAuthRetry(account.accountId, async () => {
      attempts += 1
      if (attempts === 1) throw unauthorized
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(attempts).toBe(2)
    expect(calls.filter((call) => call.url.includes(QODER_DEVICE_REFRESH_PATH))).toHaveLength(1)
  })

  it('共享 normalize 从 HTTP 403 产生的 UNAUTHORIZED 不刷新不重试', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okRefresh())])
    const flow = fixture.createFlow(fetcher)
    const unauthorized = normalizeChannelSearchError(
      { status: 403, code: 'UNAUTHORIZED', message: 'forbidden' },
      'qoder',
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

  it('重试仍 401 时不再刷新，原操作最多两次', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([refreshRoute(() => okRefresh())])
    const flow = fixture.createFlow(fetcher)
    let attempts = 0

    await expect(flow.runWithAuthRetry(account.accountId, async () => {
      attempts += 1
      throw new ChannelSearchError('UNAUTHORIZED', 'qoder', 'still 401', undefined, 401)
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    expect(attempts).toBe(2)
    expect(calls.filter((call) => call.url.includes(QODER_DEVICE_REFRESH_PATH))).toHaveLength(1)
  })

  it('并发 401 共享同一账号单飞刷新', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const gate = deferred<void>()
    const { fetcher, calls } = createScriptedFetcher([
      refreshRoute(async () => {
        await gate.promise
        return okRefresh()
      }),
    ])
    const flow = fixture.createFlow(fetcher)
    const makeOperation = () => {
      let attempts = 0
      return async (credential: { readonly credential: { readonly securityOauthToken: string } }) => {
        attempts += 1
        if (attempts === 1) {
          throw new ChannelSearchError('UNAUTHORIZED', 'qoder', 'concurrent 401', undefined, 401)
        }
        return credential.credential.securityOauthToken
      }
    }

    const first = flow.runWithAuthRetry(account.accountId, makeOperation())
    const second = flow.runWithAuthRetry(account.accountId, makeOperation())
    await waitForCall(calls, (call) => call.url.includes(QODER_DEVICE_REFRESH_PATH))
    gate.resolve()

    expect(await Promise.all([first, second])).toEqual(['ACCESS_2', 'ACCESS_2'])
    expect(calls.filter((call) => call.url.includes(QODER_DEVICE_REFRESH_PATH))).toHaveLength(1)
  })

  it('刷新失败时不重试原操作', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher } = createScriptedFetcher([
      refreshRoute(() => jsonResponse({ message: 'expired' }, 401)),
    ])
    const flow = fixture.createFlow(fetcher)
    let attempts = 0

    await expect(flow.runWithAuthRetry(account.accountId, async () => {
      attempts += 1
      throw new ChannelSearchError('UNAUTHORIZED', 'qoder', '401', undefined, 401)
    })).rejects.toMatchObject({ code: 'auth/reauth-required' })

    expect(attempts).toBe(1)
  })
})

describe('Qoder 取消落在持久化提交边界', () => {
  it('cancel 落在 saveAccount 的 modifyRecord 提交前：不写账号、不设当前', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
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
    expect(await fixture.store.listEntries('qoder')).toHaveLength(0)
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBeNull()
  })

  it('dispose 落在 saveAccount 的 modifyRecord 提交前：等待 settle 且不写账号', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
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
    expect(await fixture.store.listEntries('qoder')).toHaveLength(0)
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBeNull()
  })

  it('cancel 落在 setCurrent 的 configEditor 提交前：账号保留但不写当前', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
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
    expect(await fixture.store.listEntries('qoder')).toHaveLength(1)
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBeNull()
  })

  it('dispose 落在 setCurrent 的 configEditor 提交前：等待 settle 且不写当前', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
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
    expect(await fixture.store.listEntries('qoder')).toHaveLength(1)
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBeNull()
  })

  it('取消重新登录不得用新秘密覆盖旧记录', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    await fixture.service.setCurrent('qoder', account.accountId)
    const { fetcher } = createScriptedFetcher([
      pollRoute(() => okToken({ token: 'ACCESS_2', refresh_token: 'REFRESH_2' })),
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
    const stored = await fixture.store.readEntry('qoder', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      securityOauthToken: 'ACCESS_1',
      refreshToken: 'REFRESH_1',
    })
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBe(account.accountId)
  })
})

describe('Qoder 授权 RPC 分派与安全边界', () => {
  it('dispatchQoderInternationalAuthRpc 接受 qoder payload 并返回脱敏状态', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)

    const started = await dispatchQoderInternationalAuthRpc(flow, 'auth.start', {
      channel: 'qoder',
    }) as AuthFlowStatus
    expect(started.channel).toBe('qoder')
    expect(started.status).toBe('pending')
    expectNoSecret(started)

    const terminal = await waitForTerminal(flow, started.flowId)
    const queried = await dispatchQoderInternationalAuthRpc(flow, 'auth.status', {
      channel: 'qoder',
      flowId: started.flowId,
    }) as AuthFlowStatus
    expect(queried.status).toBe('completed')
    expect(queried.account?.channelId).toBe('qoder')
  })

  it('Qoder dispatcher 收到 buddy/qodercn payload 时在任何网络/账号工作前拒绝', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher, calls } = createScriptedFetcher([pollRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)

    for (const channel of ['buddy', 'qodercn'] as const) {
      const error = await dispatchQoderInternationalAuthRpc(flow, 'auth.start', {
        channel,
      } as never).catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(AuthRpcValidationError)
      expect(error).toMatchObject({ code: 'auth/invalid' })
    }
    expect(calls).toHaveLength(0)
    expect(fixture.credentials.writes).toHaveLength(0)
    expect(fixture.settingsDouble.edits).toHaveLength(0)
  })

  it('共享 auth 契约接受 qoder，仍拒绝 qodercn 与未知渠道', () => {
    expect(() => assertAuthRpcPayload('auth.start', { channel: 'qoder' })).not.toThrow()
    expect(() => assertAuthRpcPayload('auth.refresh', {
      channel: 'qoder',
      accountId: 'a000000000000',
    })).not.toThrow()
    for (const channel of ['qodercn', 'deepseek', '']) {
      expect(() => assertAuthRpcPayload('auth.start', { channel })).toThrow(
        AuthRpcValidationError,
      )
    }
  })

  it('结果守卫拒绝错渠道状态与夹带秘密的对象', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)

    flow.start = async () => ({
      flowId: 'flow-1',
      channel: 'qodercn',
      status: 'pending',
      authUrl: 'https://qoder.com/device/selectAccounts',
      displayHint: 'hint',
      account: null,
      errorCode: null,
    }) as unknown as AuthFlowStatus
    await expect(dispatchQoderInternationalAuthRpc(flow, 'auth.start', {
      channel: 'qoder',
    })).rejects.toMatchObject({ code: 'auth/internal' })

    flow.start = async () => ({
      flowId: 'flow-2',
      channel: 'qoder',
      status: 'pending',
      authUrl: 'https://qoder.com/device/selectAccounts',
      displayHint: 'hint',
      account: null,
      errorCode: null,
      accessToken: 'LEAK',
    }) as unknown as AuthFlowStatus
    await expect(dispatchQoderInternationalAuthRpc(flow, 'auth.start', {
      channel: 'qoder',
    })).rejects.toMatchObject({ code: 'auth/internal' })
  })

  it('状态 DTO 只有七个脱敏字段，AccountSummary 只有六个', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
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

  it('上游错误正文不进入状态或错误对象，错误无 cause', async () => {
    const fixture = createQoderAuthFixture()
    const sentinel = 'NON_REAL_QODER_UPSTREAM_SENTINEL'
    const { fetcher } = createScriptedFetcher([
      pollRoute(() => new Response(JSON.stringify({ message: sentinel }), { status: 500 })),
    ])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('failed')
    expect(terminal.errorCode).toBe('auth/failed')
    expect(JSON.stringify(terminal)).not.toContain(sentinel)
    expect(fixture.credentials.writes).toHaveLength(0)
  })

  it('qoder key 下的跨渠道伪造记录不会被覆盖', async () => {
    const fixture = createQoderAuthFixture()
    const existing = await seedAccount(fixture)
    const key = accountRecordKey('qoder', existing.accountId)
    fixture.credentials.seed(key, {
      kind: 'grant',
      payload: {
        version: 1,
        channelId: 'qodercn',
        accountId: existing.accountId,
        vendorAccountId: 'uid-1',
        displayName: 'Forged QoderCN',
        maskedIdentifier: 'u***1',
        endpointLabel: 'gateway.qoder.com.cn',
        status: 'ready',
        secret: {
          securityOauthToken: 'FORGED_CN_ACCESS',
          machineId: 'forged-machine',
        },
      },
    })
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)

    expect(terminal.status).toBe('failed')
    expect(terminal.errorCode).toBe('auth/failed')
    expect(terminal.account).toBeNull()
    const forged = fixture.credentials.raw(key)
    expect((forged?.payload as Record<string, unknown>).channelId).toBe('qodercn')
    expect(
      ((forged?.payload as Record<string, unknown>).secret as Record<string, unknown>)
        .securityOauthToken,
    ).toBe('FORGED_CN_ACCESS')
    expect(fixture.settingsDouble.getState().qoder.currentAccountId).toBeNull()
  })

  it('所有控制面请求都不含中国版 clientId、qoder.cn 或 gateway', async () => {
    const fixture = createQoderAuthFixture()
    const account = await seedAccount(fixture)
    const { fetcher, calls } = createScriptedFetcher([
      pollRoute(() => okToken()),
      refreshRoute(() => okRefresh()),
    ])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    await waitForTerminal(flow, started.flowId)
    await flow.refresh(account.accountId)

    const text = calls.map(call => call.url).join('\n')
    expect(text).not.toContain(CHINA_CLIENT_ID)
    expect(text).not.toContain('qoder.cn')
    expect(text).not.toContain('gateway.qoder.com.cn')
    expect(text).not.toContain('center.qoder.sh')
    expect(text).not.toContain('api2.qoder.sh')
    for (const call of calls) expect(call.init.redirect).toBe('error')
  })

  it('授权错误基类无 cause，且固定文案不含秘密', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([
      pollRoute(() => new Response('boom', { status: 500 })),
    ])
    const flow = fixture.createFlow(fetcher)

    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)
    const error = new QoderInternationalAuthError('auth/failed', terminal.errorCode ?? 'failed')
    expect(error.cause).toBeUndefined()
    expect(Object.keys(error)).toContain('code')
  })
})

describe('Qoder machine_id 的 Client 边界', () => {
  it('pending 与完成/失败/取消/超时终态只把 machine_id 放在本流程 authUrl', async () => {
    const completedFixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([
      pollRoute(() => okToken()),
      refreshRoute(() => okRefresh()),
    ])
    const completedFlow = completedFixture.createFlow(fetcher)
    const started = await completedFlow.start()
    expectMachineIdOnlyInAuthUrl(started, started.authUrl)

    const completed = await waitForTerminal(completedFlow, started.flowId)
    expect(completed.status).toBe('completed')
    expect(completed.authUrl).not.toBeNull()
    expectMachineIdOnlyInAuthUrl(completed, completed.authUrl)
    expectMachineIdOnlyInAuthUrl(await completedFlow.status(started.flowId), completed.authUrl)

    const refreshed = await completedFlow.refresh(completed.account!.id)
    expectMachineIdOnlyInAuthUrl(refreshed, null)

    const failureFixture = createQoderAuthFixture()
    const failedFlow = failureFixture.createFlow(createScriptedFetcher([
      pollRoute(() => new Response('boom', { status: 500 })),
    ]).fetcher)
    const failedStarted = await failedFlow.start()
    const failed = await waitForTerminal(failedFlow, failedStarted.flowId)
    expect(failed.status).toBe('failed')
    expect(failed.authUrl).not.toBeNull()
    expectMachineIdOnlyInAuthUrl(failed, failed.authUrl)

    const gate = deferred<Response>()
    const { fetcher: cancelFetcher, calls: cancelCalls } = createScriptedFetcher([
      pollRoute(() => gate.promise),
    ])
    const cancellingFlow = failureFixture.createFlow(cancelFetcher)
    const cancelStarted = await cancellingFlow.start()
    await waitForCall(cancelCalls, (call) => call.url.includes(QODER_DEVICE_POLL_PATH))
    const cancelling = cancellingFlow.cancel(cancelStarted.flowId)
    gate.resolve(okToken())
    const cancelled = await cancelling
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.authUrl).not.toBeNull()
    expectMachineIdOnlyInAuthUrl(cancelled, cancelled.authUrl)

    const timeoutFlow = failureFixture.createFlow(
      createScriptedFetcher([
        pollRoute(() => new Response('{"errorCode":"NotFound"}', { status: 404 })),
      ]).fetcher,
      { authTimeoutMs: 100, pollIntervalMs: 10 },
    )
    const timeoutStarted = await timeoutFlow.start()
    const timedOut = await waitForTerminal(timeoutFlow, timeoutStarted.flowId)
    expect(timedOut.status).toBe('timed_out')
    expect(timedOut.authUrl).not.toBeNull()
    expectMachineIdOnlyInAuthUrl(timedOut, timedOut.authUrl)

    expect(failureFixture.credentials.writes).toHaveLength(0)
    expect(await failureFixture.store.listEntries('qoder')).toHaveLength(0)
    expect(JSON.stringify(failureFixture.settingsDouble.getState()))
      .not.toContain(SESSION.machineId)
  })

  it('authUrl 不持久化；grant 保存 machine_id，普通配置与账号投影不包含它', async () => {
    const fixture = createQoderAuthFixture()
    const { fetcher } = createScriptedFetcher([pollRoute(() => okToken())])
    const flow = fixture.createFlow(fetcher)
    const started = await flow.start()
    const terminal = await waitForTerminal(flow, started.flowId)
    const accountId = terminal.account!.id
    const authUrl = started.authUrl
    expect(authUrl).not.toBeNull()

    const raw = fixture.credentials.raw(accountRecordKey('qoder', accountId))
    const rawText = JSON.stringify(raw)
    expect(rawText).toContain(SESSION.machineId)
    expect(rawText).not.toContain('authUrl')
    expect(rawText).not.toContain(authUrl!)
    expect(rawText).not.toContain(SESSION.nonce)
    expect(rawText).not.toContain('challenge')

    const settingsText = JSON.stringify(fixture.settingsDouble.getState())
    expect(settingsText).not.toContain(SESSION.machineId)
    expect(settingsText).not.toContain('authUrl')
    expect(settingsText).not.toContain(authUrl!)

    const summaries = await fixture.service.list('qoder')
    expect(summaries).toHaveLength(1)
    for (const summary of summaries) expectMachineIdOnlyInAuthUrl(summary, null)
    expectMachineIdOnlyInAuthUrl(await fixture.service.getCurrent('qoder'), null)
  })

  it('每次 start 都新建设备会话，两个流程的 authUrl 与 grant 各自只含自己的 machine_id', async () => {
    const fixture = createQoderAuthFixture()
    const sessions: QoderDeviceSession[] = [
      { ...SESSION, machineId: 'machine-first' },
      { ...SESSION, machineId: 'machine-second' },
    ]
    let generated = 0
    const createDeviceSession = (): QoderDeviceSession => {
      const session = sessions[generated]
      generated += 1
      return session
    }

    const firstFlow = fixture.createFlow(
      createScriptedFetcher([pollRoute(() => okToken())]).fetcher,
      { createDeviceSession },
    )
    const firstStarted = await firstFlow.start()
    expectMachineIdOnlyInAuthUrl(firstStarted, firstStarted.authUrl, 'machine-first')
    const firstTerminal = await waitForTerminal(firstFlow, firstStarted.flowId)
    expect(firstTerminal.status).toBe('completed')

    const secondFlow = fixture.createFlow(
      createScriptedFetcher([
        pollRoute(() => okToken({ user_id: 'uid-2', user_name: 'Qoder Second' })),
      ]).fetcher,
      { createDeviceSession },
    )
    const secondStarted = await secondFlow.start()
    expectMachineIdOnlyInAuthUrl(secondStarted, secondStarted.authUrl, 'machine-second')
    const secondTerminal = await waitForTerminal(secondFlow, secondStarted.flowId)
    expect(secondTerminal.status).toBe('completed')

    expect(generated).toBe(2)
    expect(firstTerminal.account?.id).not.toBe(secondTerminal.account?.id)

    const firstRecordText = JSON.stringify(
      fixture.credentials.raw(accountRecordKey('qoder', firstTerminal.account!.id)),
    )
    const secondRecordText = JSON.stringify(
      fixture.credentials.raw(accountRecordKey('qoder', secondTerminal.account!.id)),
    )
    expect(firstRecordText).toContain('machine-first')
    expect(firstRecordText).not.toContain('machine-second')
    expect(secondRecordText).toContain('machine-second')
    expect(secondRecordText).not.toContain('machine-first')
  })
})
