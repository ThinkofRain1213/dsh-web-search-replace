/**
 * Task 2：管理 RPC 的传输形状、严格校验与统一结果。
 *
 * Host 通过 `connection.fetch.register({ path, methods, requestBody, fetch })`
 * 注册精确路由；Client 通过 `connection.rpc.call('/api', 'web-search-channels',
 * { method, payload }, signal)` 调用。测试直接搭一条与真实 Connection 相同的
 * client-request/server-response 信封，避免只测单侧。
 */
import { describe, expect, it } from 'vitest'

import { BuddyAuthFlow } from '../../src/host/channels/buddy/auth.ts'
import { WorkbuddyAuthFlow } from '../../src/host/channels/workbuddy/auth.ts'
import { registerManagementRpc } from '../../src/host/rpc.ts'
import { DEFAULT_SEARCH_SETTINGS, type SearchSettingsSnapshot } from '../../src/shared/contracts.ts'
import {
  AccountRpcValidationError,
  type AccountCollection,
  type AccountSummary,
  type ClearAccountsResult,
} from '../../src/shared/accounts.ts'
import {
  AuthRpcValidationError,
  isAccountSummary,
  isAuthFlowStatus,
  type AuthChannel,
  type AuthFlowStatus,
} from '../../src/shared/auth.ts'
import {
  callManagementRpc,
  MANAGEMENT_RPC_ENDPOINT,
  MANAGEMENT_RPC_PATH,
  type ManagementRpcConnection,
  type ManagementRpcRoute,
  type RpcResult,
} from '../../src/shared/rpc.ts'
import { createAccountFixture, type AccountFixture } from './support/account-fixture.ts'

/** 构造一个最小 JSON 响应。 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 一个授权流程与它收到的请求 URL；用于证明 Host 按 channel 精确分派。 */
interface RpcAuthFlowFixture {
  readonly flow: BuddyAuthFlow | WorkbuddyAuthFlow
  readonly calls: string[]
}

/**
 * 用真实 AccountStore/AccountService 构造一个 CodeBuddy 授权流程。
 *
 * tokenReady=false 时 token 轮询永远返回 11217，用于 cancel 测试。
 */
function createBuddyAuthForRpc(
  fixture: AccountFixture,
  options: { readonly tokenReady?: boolean } = {},
): RpcAuthFlowFixture {
  let now = 1_000_000
  let flowSequence = 0
  let accountSequence = 0
  const calls: string[] = []
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/v2/plugin/auth/state')) {
      return json({
        code: 0,
        data: {
          state: 'rpc-state',
          authUrl: 'https://www.codebuddy.cn/login/?platform=ide&state=rpc-state',
        },
      })
    }
    if (url.includes('/v2/plugin/auth/token/refresh')) {
      return json({
        code: 0,
        data: {
          accessToken: 'RPC_ACCESS_2',
          refreshToken: 'RPC_REFRESH_2',
          expiresIn: 3600,
          tokenType: 'Bearer',
          domain: 'copilot.tencent.com',
        },
      })
    }
    if (url.includes('/v2/plugin/auth/token')) {
      if (options.tokenReady === false) return json({ code: 11217 }, 400)
      accountSequence += 1
      return json({
        code: 0,
        data: {
          accessToken: `RPC_ACCESS_${accountSequence}`,
          refreshToken: `RPC_REFRESH_${accountSequence}`,
          expiresIn: 3600,
          tokenType: 'Bearer',
          domain: 'copilot.tencent.com',
        },
      })
    }
    if (url.includes('/v2/plugin/login/account')) {
      return json({
        code: 0,
        data: {
          uid: 'rpc-user',
          nickname: 'RPC User',
          enterpriseId: '',
          type: 'personal',
        },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  const flow = new BuddyAuthFlow({
    store: fixture.store,
    accounts: fixture.service,
    fetcher,
    clock: { now: () => now, sleep: async (ms) => { now += Math.max(1, ms) } },
    randomId: () => `rpc-flow-${++flowSequence}`,
    pollIntervalMs: 10,
    authTimeoutMs: 60_000,
    timeoutSignal: () => new AbortController().signal,
    verifyCapability: async () => { /* RPC 契约测试不执行真实能力探测 */ },
  })
  return { flow, calls }
}

/**
 * 用真实 AccountStore/AccountService 构造一个 WorkBuddy 授权流程。
 *
 * tokenReady=false 时 token 轮询永远返回 11217，用于 cancel 测试。
 */
function createWorkbuddyAuthForRpc(
  fixture: AccountFixture,
  options: { readonly tokenReady?: boolean } = {},
): RpcAuthFlowFixture {
  let now = 2_000_000
  let flowSequence = 0
  let sessionSequence = 0
  let accountSequence = 0
  const calls: string[] = []
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/v2/plugin/auth/state')) {
      return json({
        code: 0,
        data: {
          state: 'rpc-wb-state',
          authUrl: 'https://www.workbuddy.ai/login/?platform=workbuddy-ai&state=rpc-wb-state',
        },
      })
    }
    if (url.includes('/v2/plugin/auth/token/refresh')) {
      return json({
        code: 0,
        data: {
          accessToken: 'WB_RPC_ACCESS_2',
          refreshToken: 'WB_RPC_REFRESH_2',
          expiresIn: 3600,
          tokenType: 'Bearer',
          domain: 'www.workbuddy.ai',
        },
      })
    }
    if (url.includes('/v2/plugin/auth/token')) {
      if (options.tokenReady === false) return json({ code: 11217 }, 400)
      accountSequence += 1
      return json({
        code: 0,
        data: {
          accessToken: `WB_RPC_ACCESS_${accountSequence}`,
          refreshToken: `WB_RPC_REFRESH_${accountSequence}`,
          expiresIn: 3600,
          tokenType: 'Bearer',
          domain: 'www.workbuddy.ai',
        },
      })
    }
    if (url.includes('/v2/plugin/login/account')) {
      return json({
        code: 0,
        data: {
          uid: 'rpc-wb-user',
          nickname: 'RPC WorkBuddy',
          enterpriseId: '',
          type: 'personal',
        },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  const flow = new WorkbuddyAuthFlow({
    store: fixture.store,
    accounts: fixture.service,
    fetcher,
    clock: { now: () => now, sleep: async (ms) => { now += Math.max(1, ms) } },
    randomId: () => `rpc-wb-flow-${++flowSequence}`,
    randomSessionId: () => `rpc-wb-session-${++sessionSequence}`,
    pollIntervalMs: 10,
    authTimeoutMs: 60_000,
    timeoutSignal: () => new AbortController().signal,
    verifyCapability: async () => { /* RPC 契约测试不执行真实能力探测 */ },
  })
  return { flow, calls }
}

/** 一个最小但真实的 connection 双端：注册路由 + 用 rpc.call 发信封。 */
function createRpcHarness(options: {
  readonly withBuddyAuth?: boolean
  readonly withWorkbuddyAuth?: boolean
  readonly tokenReady?: boolean
} = {}) {
  const fixture = createAccountFixture()
  const settings = fixture.settings
  const double = fixture.settingsDouble
  const routes = new Map<string, ManagementRpcRoute>()
  const connection: ManagementRpcConnection = {
    fetch: {
      register(route: ManagementRpcRoute) {
        routes.set(route.path, route)
        return async () => {
          routes.delete(route.path)
        }
      },
    },
    rpc: {
      async call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) {
        const path = `${channel}/${endpoint}`
        const route = routes.get(path)
        if (route === undefined) throw new Error(`route not registered: ${path}`)
        const response = await route.fetch(new Request(`http://127.0.0.1${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: 'test-rpc-id',
            method: endpoint,
            payload,
          }),
          ...signal === undefined ? {} : { signal },
        }))
        const body = await response.json() as { result: RpcResult<unknown> }
        return body.result
      },
    },
  }
  const buddyFixture = options.withBuddyAuth === true
    ? createBuddyAuthForRpc(fixture, { tokenReady: options.tokenReady })
    : undefined
  const workbuddyFixture = options.withWorkbuddyAuth === true
    ? createWorkbuddyAuthForRpc(fixture, { tokenReady: options.tokenReady })
    : undefined
  const authFlows = {
    ...buddyFixture === undefined ? {} : { buddy: buddyFixture.flow },
    ...workbuddyFixture === undefined ? {} : { workbuddy: workbuddyFixture.flow },
  }
  const dispose = registerManagementRpc(connection, settings, fixture.service, authFlows)
  return {
    connection,
    settings,
    double,
    routes,
    dispose,
    store: fixture.store,
    service: fixture.service,
    buddyAuth: buddyFixture?.flow,
    workbuddyAuth: workbuddyFixture?.flow,
    buddyCalls: buddyFixture?.calls ?? [],
    workbuddyCalls: workbuddyFixture?.calls ?? [],
  }
}

/** 轮询 RPC 授权状态直到终态。 */
async function waitForRpcAuthStatus(
  connection: ManagementRpcConnection,
  channel: AuthChannel,
  flowId: string,
): Promise<AuthFlowStatus> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const result = await callManagementRpc(connection, 'auth.status', {
      channel,
      flowId,
    })
    if (!result.ok) throw new Error(`auth.status failed: ${result.error.code}`)
    if (result.value.status !== 'pending') return result.value
    await new Promise<void>((resolve) => { setTimeout(resolve, 1) })
  }
  throw new Error('auth flow did not settle')
}

/** 直接调用已注册路由，绕开 Client 校验以测试 Host 的防御。 */
async function rawCall(
  harness: ReturnType<typeof createRpcHarness>,
  body: unknown,
  init: { method?: string; contentType?: string } = {},
) {
  const route = harness.routes.get(MANAGEMENT_RPC_PATH)
  if (route === undefined) throw new Error('management route was not registered')
  const method = init.method ?? 'POST'
  const headers = { 'content-type': init.contentType ?? 'application/json' }
  const requestInit: RequestInit = method === 'GET' || method === 'HEAD'
    ? { method, headers }
    : { method, headers, body: typeof body === 'string' ? body : JSON.stringify(body) }
  const response = await route.fetch(new Request(`http://127.0.0.1${MANAGEMENT_RPC_PATH}`, requestInit))
  return response
}

describe('管理 RPC 路由注册', () => {
  it('复用精确路径 /api/web-search-channels 与 POST 缓冲请求体', () => {
    const { routes } = createRpcHarness()
    const route = routes.get(MANAGEMENT_RPC_PATH)
    expect(route).toBeDefined()
    expect(route?.path).toBe('/api/web-search-channels')
    expect(route?.methods).toEqual(['POST'])
    expect(route?.requestBody).toBe('buffered')
    expect(MANAGEMENT_RPC_PATH).toBe(`/api/${MANAGEMENT_RPC_ENDPOINT}`)
  })

  it('disposer 移除路由', async () => {
    const { routes, dispose } = createRpcHarness()
    expect(routes.has(MANAGEMENT_RPC_PATH)).toBe(true)
    await dispose()
    expect(routes.has(MANAGEMENT_RPC_PATH)).toBe(false)
  })
})

describe('settings.get', () => {
  it('返回默认非秘密快照', async () => {
    const { connection } = createRpcHarness()

    const result = await callManagementRpc(connection, 'settings.get', {})

    expect(result).toEqual({ ok: true, value: DEFAULT_SEARCH_SETTINGS })
  })

  it('只投影非秘密字段，不返回 token/secret', async () => {
    const { connection } = createRpcHarness()

    const result = await callManagementRpc(connection, 'settings.get', {})
    expect(result.ok).toBe(true)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/token|secret|password|cookie/i)
    if (result.ok) {
      expect(Object.keys(result.value).sort()).toEqual(['buddy', 'qoder', 'qodercn', 'search', 'workbuddy'])
    }
  })
})

describe('settings.update', () => {
  it('写入开关与渠道并返回重读后的快照', async () => {
    const { connection, double } = createRpcHarness()

    const result = await callManagementRpc(connection, 'settings.update', {
      patch: { enabled: true, channel: 'qodercn' },
    })

    expect(result).toEqual({
      ok: true,
      value: {
        ...DEFAULT_SEARCH_SETTINGS,
        search: { enabled: true, channel: 'qodercn' },
      },
    })
    expect(double.getState().search).toEqual({ enabled: true, channel: 'qodercn' })
  })

  it('写入 Qoder 国际版端点偏好', async () => {
    const { connection } = createRpcHarness()

    const result = await callManagementRpc(connection, 'settings.update', {
      patch: { endpointPreference: 'center' },
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.qoder.endpointPreference).toBe('center')
  })

  it('Host 拒绝非法渠道并保持旧值', async () => {
    const harness = createRpcHarness()
    const response = await rawCall(harness, {
      type: 'client-request',
      rpcId: 'raw-1',
      method: MANAGEMENT_RPC_ENDPOINT,
      payload: { method: 'settings.update', payload: { patch: { channel: 'deepseek' } } },
    })
    const body = await response.json() as { result: { ok: boolean; error?: { code: string; details: unknown } } }

    expect(body.result.ok).toBe(false)
    expect(body.result.error?.code).toBe('settings/invalid')
    expect(typeof body.result.error?.details).toBe('object')
    expect(harness.double.edits).toHaveLength(0)
  })

  it('Host 拒绝 settings.update 的未知顶层键且不写配置', async () => {
    const harness = createRpcHarness()
    const response = await rawCall(harness, {
      type: 'client-request',
      rpcId: 'raw-update-extra-key',
      method: MANAGEMENT_RPC_ENDPOINT,
      payload: {
        method: 'settings.update',
        payload: { patch: { enabled: true }, buddy: { currentAccountId: 'other' } },
      },
    })
    const body = await response.json() as { result: { ok: boolean } }

    expect(body.result.ok).toBe(false)
    expect(harness.double.edits).toHaveLength(0)
  })

  it('Host 拒绝非法端点偏好并保持旧值', async () => {
    const harness = createRpcHarness()
    const response = await rawCall(harness, {
      type: 'client-request',
      rpcId: 'raw-2',
      method: MANAGEMENT_RPC_ENDPOINT,
      payload: { method: 'settings.update', payload: { patch: { endpointPreference: 'gateway' } } },
    })
    const body = await response.json() as { result: { ok: boolean; error?: { code: string } } }

    expect(body.result.ok).toBe(false)
    expect(body.result.error?.code).toBe('settings/invalid')
    expect(harness.double.edits).toHaveLength(0)
  })

  it('Host 拒绝通过 settings.update 跨渠道写 currentAccountId', async () => {
    const harness = createRpcHarness()
    const response = await rawCall(harness, {
      type: 'client-request',
      rpcId: 'raw-8',
      method: MANAGEMENT_RPC_ENDPOINT,
      payload: {
        method: 'settings.update',
        payload: { patch: { buddy: { currentAccountId: 'account-1' } } },
      },
    })
    const body = await response.json() as { result: { ok: boolean; error?: { code: string } } }

    expect(body.result.ok).toBe(false)
    expect(body.result.error?.code).toBe('settings/invalid')
    expect(harness.double.edits).toHaveLength(0)
  })

  it('写失败返回统一错误结果且不发布新快照', async () => {
    const { connection, double, settings } = createRpcHarness()
    double.failNextWrite('disk full')

    const result = await callManagementRpc(connection, 'settings.update', {
      patch: { enabled: true },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('settings/internal')
      expect(result.error.message).toBe('settings operation failed')
      expect(typeof result.error.details).toBe('object')
    }
    expect(settings.getSnapshot()).toEqual(DEFAULT_SEARCH_SETTINGS)
  })

  it('settings/internal 使用固定通用消息且不回显依赖异常', async () => {
    const { connection, double } = createRpcHarness()
    const nonRealSentinel = 'NON_REAL_SENSITIVE_TEST_SENTINEL'
    double.failNextWrite(nonRealSentinel)

    const result = await callManagementRpc(connection, 'settings.update', {
      patch: { enabled: true },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('settings/internal')
    expect(JSON.stringify(result).includes(nonRealSentinel)).toBe(false)
    expect(result.error.message).toBe('settings operation failed')
  })
})

describe('settings.setCurrentAccount', () => {
  it('写入指定渠道的稳定 slug 并返回快照', async () => {
    const { connection } = createRpcHarness()

    const result = await callManagementRpc(connection, 'settings.setCurrentAccount', {
      channel: 'workbuddy',
      accountId: 'account-1',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.workbuddy.currentAccountId).toBe('account-1')
      expect(result.value.buddy.currentAccountId).toBeNull()
      expect(result.value.qoder.currentAccountId).toBeNull()
      expect(result.value.qodercn.currentAccountId).toBeNull()
    }
  })

  it('接受 null 清除当前账号', async () => {
    const { connection } = createRpcHarness()
    await callManagementRpc(connection, 'settings.setCurrentAccount', {
      channel: 'buddy',
      accountId: 'account-1',
    })

    const cleared = await callManagementRpc(connection, 'settings.setCurrentAccount', {
      channel: 'buddy',
      accountId: null,
    })

    expect(cleared.ok).toBe(true)
    if (cleared.ok) expect(cleared.value.buddy.currentAccountId).toBeNull()
  })

  it('Host 拒绝非法渠道与非法 slug', async () => {
    const harness = createRpcHarness()

    for (const call of [
      { channel: 'deepseek', accountId: 'account-1' },
      { channel: 'buddy', accountId: 'Account_1' },
      { channel: 'buddy', accountId: '' },
    ]) {
      const response = await rawCall(harness, {
        type: 'client-request',
        rpcId: 'raw-3',
        method: MANAGEMENT_RPC_ENDPOINT,
        payload: { method: 'settings.setCurrentAccount', payload: call },
      })
      const body = await response.json() as { result: { ok: boolean; error?: { code: string } } }
      expect(body.result.ok).toBe(false)
      expect(body.result.error?.code).toBe('settings/invalid')
    }
    expect(harness.double.edits).toHaveLength(0)
  })

  it('Host 拒绝 setCurrentAccount 中的额外渠道键', async () => {
    const harness = createRpcHarness()
    const response = await rawCall(harness, {
      type: 'client-request',
      rpcId: 'raw-9',
      method: MANAGEMENT_RPC_ENDPOINT,
      payload: {
        method: 'settings.setCurrentAccount',
        payload: { channel: 'buddy', accountId: 'account-1', workbuddy: { currentAccountId: 'other' } },
      },
    })
    const body = await response.json() as { result: { ok: boolean; error?: { code: string } } }

    expect(body.result.ok).toBe(false)
    expect(body.result.error?.code).toBe('settings/invalid')
    expect(harness.double.edits).toHaveLength(0)
  })
})

describe('Host 防御与信封校验', () => {
  it('未知 method 返回 bad-request 且不影响配置', async () => {
    const harness = createRpcHarness()
    const response = await rawCall(harness, {
      type: 'client-request',
      rpcId: 'raw-4',
      method: MANAGEMENT_RPC_ENDPOINT,
      payload: { method: 'settings.delete', payload: {} },
    })
    const body = await response.json() as { result: { ok: boolean; error?: { code: string; message: string } } }

    expect(body.result.ok).toBe(false)
    expect(body.result.error?.code).toBe('bad-request')
    expect(body.result.error?.message).toMatch(/unknown method/i)
    expect(harness.double.edits).toHaveLength(0)
  })

  it('缺少 rpcId、错误 type、错误 endpoint 或缺少 payload 都被拒绝', async () => {
    const harness = createRpcHarness()
    for (const body of [
      { type: 'client-request', method: MANAGEMENT_RPC_ENDPOINT, payload: { method: 'settings.get', payload: {} } },
      { type: 'wrong', rpcId: 'raw-5', method: MANAGEMENT_RPC_ENDPOINT, payload: { method: 'settings.get', payload: {} } },
      { type: 'client-request', rpcId: 'raw-6', method: 'other-endpoint', payload: { method: 'settings.get', payload: {} } },
      { type: 'client-request', rpcId: 'raw-7', method: MANAGEMENT_RPC_ENDPOINT },
    ]) {
      const response = await rawCall(harness, body)
      const parsed = await response.json() as { result: { ok: boolean; error?: { code: string; details: unknown } } }
      expect(parsed.result.ok).toBe(false)
      expect(parsed.result.error?.code).toBe('gateway/bad-request')
      expect(typeof parsed.result.error?.details).toBe('object')
    }
    expect(harness.double.edits).toHaveLength(0)
  })

  it('非 POST、非 JSON content-type、非 JSON body 分别返回 405/415/400', async () => {
    const harness = createRpcHarness()

    const wrongMethod = await rawCall(harness, {}, { method: 'GET' })
    expect(wrongMethod.status).toBe(405)

    const wrongType = await rawCall(harness, {}, { contentType: 'text/plain' })
    expect(wrongType.status).toBe(415)

    const wrongBody = await rawCall(harness, 'not json', { contentType: 'application/json' })
    expect(wrongBody.status).toBe(400)
  })
})

describe('callManagementRpc 客户端校验', () => {
  it('Client 拒绝 settings.update 的未知顶层键且不发请求', () => {
    const { connection } = createRpcHarness()
    let requestCount = 0
    const call = connection.rpc.call
    connection.rpc.call = async (...args) => {
      requestCount += 1
      return call(...args)
    }

    expect(() => callManagementRpc(connection, 'settings.update', {
      patch: { enabled: true },
      buddy: { currentAccountId: 'other' },
    } as never)).toThrow(/settings\.update|payload/i)
    expect(requestCount).toBe(0)
  })

  it('拒绝未知 method 与非法 payload，不发出请求', () => {
    const { connection } = createRpcHarness()

    expect(() => (callManagementRpc as any)(connection, 'settings.delete', {})).toThrow(/method|方法/i)
    expect(() => callManagementRpc(connection, 'settings.update', {
      patch: { channel: 'deepseek' },
    } as never)).toThrow(/channel|渠道/i)
    expect(() => callManagementRpc(connection, 'settings.setCurrentAccount', {
      channel: 'buddy',
      accountId: 'Account_1',
    } as never)).toThrow(/slug|account|账号/i)
  })
})

describe('accounts.* 共享 Client 契约', () => {
  it('五个账号方法都经 callManagementRpc 的统一 envelope 有效调用', async () => {
    const { connection, store, double } = createRpcHarness()
    const first = await store.saveAccount({
      channel: 'buddy',
      vendorAccountId: 'first@example.test',
      displayName: 'First',
      secret: { accessToken: 'MGMT_TOKEN_A' },
    })
    const second = await store.saveAccount({
      channel: 'buddy',
      vendorAccountId: 'second@example.test',
      displayName: 'Second',
      secret: { accessToken: 'MGMT_TOKEN_B' },
    })

    const list = await callManagementRpc(connection, 'accounts.list', { channel: 'buddy' })
    expect(list.ok).toBe(true)
    if (list.ok) {
      const summaries: readonly AccountSummary[] = list.value
      expect(summaries.map(summary => summary.id).sort()).toEqual(
        [first.accountId, second.accountId].sort(),
      )
    }

    const set = await callManagementRpc(connection, 'accounts.setCurrent', {
      channel: 'buddy',
      accountId: first.accountId,
    })
    expect(set.ok).toBe(true)
    if (set.ok) {
      const current: AccountSummary | null = set.value
      expect(current?.id).toBe(first.accountId)
    }

    const current = await callManagementRpc(connection, 'accounts.current', { channel: 'buddy' })
    expect(current.ok).toBe(true)
    if (current.ok) {
      const summary: AccountSummary | null = current.value
      expect(summary?.id).toBe(first.accountId)
    }

    const deleted = await callManagementRpc(connection, 'accounts.delete', {
      channel: 'buddy',
      accountId: first.accountId,
    })
    expect(deleted.ok).toBe(true)
    if (deleted.ok) {
      const collection: AccountCollection = deleted.value
      expect(collection.current).toBeNull()
      expect(collection.accounts.map(summary => summary.id)).toEqual([second.accountId])
    }

    const cleared = await callManagementRpc(connection, 'accounts.clearAll', {})
    expect(cleared.ok).toBe(true)
    if (cleared.ok) {
      const result: ClearAccountsResult = cleared.value
      expect(result).toEqual({ cleared: 1 })
    }
    expect(double.getState().buddy.currentAccountId).toBeNull()
  })

  it('账号方法非法 payload 在 connection.rpc.call 之前失败', () => {
    const { connection } = createRpcHarness()
    let requestCount = 0
    const original = connection.rpc.call
    connection.rpc.call = async (...args) => {
      requestCount += 1
      return original(...args)
    }

    const invalidCalls = [
      ['accounts.list', { channel: 'deepseek' }],
      ['accounts.current', {}],
      ['accounts.setCurrent', { channel: 'buddy' }],
      ['accounts.delete', { channel: 'buddy', accountId: 'Bad_ID' }],
      ['accounts.clearAll', { channel: 'buddy' }],
    ] as const

    for (const [method, payload] of invalidCalls) {
      expect(() => (callManagementRpc as (...args: unknown[]) => unknown)(
        connection,
        method,
        payload,
      )).toThrow(AccountRpcValidationError)
    }
    expect(requestCount).toBe(0)
  })

  it('settings 方法仍经同一调用器返回设置快照', async () => {
    const { connection } = createRpcHarness()

    const result = await callManagementRpc(connection, 'settings.get', {})
    expect(result).toEqual({ ok: true, value: DEFAULT_SEARCH_SETTINGS })
    if (result.ok) {
      const snapshot: SearchSettingsSnapshot = result.value
      expect(snapshot.search).toEqual({ enabled: false, channel: 'buddy' })
    }
  })
})

describe('auth.* 共享 Client 契约', () => {
  it('auth.start 返回 pending 授权 URL，完成后状态含 AccountSummary 与当前账号', async () => {
    const harness = createRpcHarness({ withBuddyAuth: true })

    const started = await callManagementRpc(harness.connection, 'auth.start', {
      channel: 'buddy',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const pending: AuthFlowStatus = started.value
    expect(pending.channel).toBe('buddy')
    expect(pending.status).toBe('pending')
    expect(pending.authUrl).toContain('www.codebuddy.cn')
    expect(pending.account).toBeNull()

    const completed = await waitForRpcAuthStatus(harness.connection, 'buddy', pending.flowId)
    expect(completed.status).toBe('completed')
    expect(isAuthFlowStatus(completed)).toBe(true)
    const summary: AccountSummary | null = completed.account
    expect(summary?.channelId).toBe('buddy')
    expect(summary?.status).toBe('ready')
    expect(harness.double.getState().buddy.currentAccountId).toBe(summary?.id)
    expect(JSON.stringify(completed)).not.toMatch(/RPC_ACCESS|RPC_REFRESH|accessToken|refreshToken/)
  })

  it('auth.cancel 取消 pending 流程，auth.status 返回 cancelled 且不落码', async () => {
    const harness = createRpcHarness({ withBuddyAuth: true, tokenReady: false })

    const started = await callManagementRpc(harness.connection, 'auth.start', {
      channel: 'buddy',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return

    const cancelled = await callManagementRpc(harness.connection, 'auth.cancel', {
      channel: 'buddy',
      flowId: started.value.flowId,
    })
    expect(cancelled.ok).toBe(true)
    if (cancelled.ok) {
      const status: AuthFlowStatus = cancelled.value
      expect(status.status).toBe('cancelled')
      expect(status.errorCode).toBe('auth/cancelled')
    }

    const queried = await callManagementRpc(harness.connection, 'auth.status', {
      channel: 'buddy',
      flowId: started.value.flowId,
    })
    expect(queried.ok).toBe(true)
    if (queried.ok) expect(queried.value.status).toBe('cancelled')
    expect(await harness.store.listEntries('buddy')).toHaveLength(0)
    expect(harness.double.getState().buddy.currentAccountId).toBeNull()
  })

  it('auth.refresh 返回 AccountSummary 并轮换秘密', async () => {
    const harness = createRpcHarness({ withBuddyAuth: true })
    const account = await harness.store.saveAccount({
      channel: 'buddy',
      vendorAccountId: 'rpc-refresh-user',
      secret: { accessToken: 'RPC_ACCESS_1', refreshToken: 'RPC_REFRESH_1' },
    })

    const result = await callManagementRpc(harness.connection, 'auth.refresh', {
      channel: 'buddy',
      accountId: account.accountId,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const summary: AccountSummary = result.value
      expect(isAccountSummary(summary)).toBe(true)
      expect(summary.id).toBe(account.accountId)
      expect(summary.channelId).toBe('buddy')
    }
    const stored = await harness.store.readEntry('buddy', account.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'RPC_ACCESS_2',
      refreshToken: 'RPC_REFRESH_2',
    })
  })

  it('auth.start 携带 accountId 时走重新登录并复用账号 ID', async () => {
    const harness = createRpcHarness({ withBuddyAuth: true })
    const first = await callManagementRpc(harness.connection, 'auth.start', { channel: 'buddy' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const firstCompleted = await waitForRpcAuthStatus(
      harness.connection,
      'buddy',
      first.value.flowId,
    )
    const accountId = firstCompleted.account!.id

    const reauth = await callManagementRpc(harness.connection, 'auth.start', {
      channel: 'buddy',
      accountId,
    })
    expect(reauth.ok).toBe(true)
    if (!reauth.ok) return
    const reauthCompleted = await waitForRpcAuthStatus(
      harness.connection,
      'buddy',
      reauth.value.flowId,
    )

    expect(reauthCompleted.status).toBe('completed')
    expect(reauthCompleted.account?.id).toBe(accountId)
    expect(await harness.store.listEntries('buddy')).toHaveLength(1)
  })

  it('四个授权方法非法 payload 在 connection.rpc.call 之前失败', () => {
    const { connection } = createRpcHarness({ withBuddyAuth: true })
    let requestCount = 0
    const original = connection.rpc.call
    connection.rpc.call = async (...args) => {
      requestCount += 1
      return original(...args)
    }

    const invalidCalls = [
      ['auth.start', {}],
      ['auth.start', { channel: 'qoder' }],
      ['auth.start', { channel: 'buddy', extra: true }],
      ['auth.start', { channel: 'workbuddy', extra: true }],
      ['auth.cancel', { channel: 'buddy' }],
      ['auth.cancel', { channel: 'buddy', flowId: 'Bad_ID' }],
      ['auth.cancel', { channel: 'workbuddy', flowId: 'Bad_ID' }],
      ['auth.status', { channel: 'buddy', flowId: 'flow-1', extra: true }],
      ['auth.refresh', { channel: 'buddy' }],
      ['auth.refresh', { channel: 'buddy', accountId: 'Bad_ID' }],
      ['auth.refresh', { channel: 'workbuddy', accountId: 'Bad_ID' }],
    ] as const

    for (const [method, payload] of invalidCalls) {
      expect(() => (callManagementRpc as (...args: unknown[]) => unknown)(
        connection,
        method,
        payload,
      )).toThrow(AuthRpcValidationError)
    }
    expect(requestCount).toBe(0)
  })

  it('Host 拒绝未知渠道与未知键，且不写账号', async () => {
    const harness = createRpcHarness({ withBuddyAuth: true, withWorkbuddyAuth: true })
    for (const payload of [
      { channel: 'qoder' },
      { channel: 'buddy', extra: true },
      { channel: 'workbuddy', extra: true },
    ]) {
      const response = await rawCall(harness, {
        type: 'client-request',
        rpcId: 'raw-auth-invalid',
        method: MANAGEMENT_RPC_ENDPOINT,
        payload: { method: 'auth.start', payload },
      })
      const body = await response.json() as {
        result: { ok: boolean; error?: { code: string; details: unknown } }
      }
      expect(body.result.ok).toBe(false)
      expect(body.result.error?.code).toBe('auth/invalid')
      expect(typeof body.result.error?.details).toBe('object')
    }
    expect(await harness.store.listEntries('buddy')).toHaveLength(0)
    expect(await harness.store.listEntries('workbuddy')).toHaveLength(0)
    expect(harness.buddyCalls).toHaveLength(0)
    expect(harness.workbuddyCalls).toHaveLength(0)
  })

  it('未提供授权流程时 auth.* 返回 bad-request', async () => {
    const harness = createRpcHarness()
    for (const channel of ['buddy', 'workbuddy'] as const) {
      const response = await rawCall(harness, {
        type: 'client-request',
        rpcId: 'raw-auth-unwired',
        method: MANAGEMENT_RPC_ENDPOINT,
        payload: { method: 'auth.start', payload: { channel } },
      })
      const body = await response.json() as { result: { ok: boolean; error?: { code: string } } }
      expect(body.result.ok).toBe(false)
      expect(body.result.error?.code).toBe('bad-request')
    }
  })

  it('Host 按 channel 精确分派：workbuddy 只调用 WorkBuddy flow', async () => {
    const harness = createRpcHarness({ withBuddyAuth: true, withWorkbuddyAuth: true })

    const started = await callManagementRpc(harness.connection, 'auth.start', {
      channel: 'workbuddy',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.value.channel).toBe('workbuddy')
    expect(started.value.authUrl).toContain('www.workbuddy.ai')

    const completed = await waitForRpcAuthStatus(
      harness.connection,
      'workbuddy',
      started.value.flowId,
    )
    expect(completed.status).toBe('completed')
    expect(completed.account?.channelId).toBe('workbuddy')
    expect(harness.double.getState().workbuddy.currentAccountId).toBe(completed.account?.id)
    expect(harness.double.getState().buddy.currentAccountId).toBeNull()
    expect(await harness.store.listEntries('buddy')).toHaveLength(0)
    expect(harness.buddyCalls).toHaveLength(0)
    expect(harness.workbuddyCalls.length).toBeGreaterThan(0)
    expect(harness.workbuddyCalls.some((url) => url.includes('platform=workbuddy-ai'))).toBe(true)
    expect(harness.workbuddyCalls.some((url) => url.includes('copilot.tencent.com'))).toBe(false)
  })

  it('Host 按 channel 精确分派：buddy 只调用 Buddy flow', async () => {
    const harness = createRpcHarness({ withBuddyAuth: true, withWorkbuddyAuth: true })

    const started = await callManagementRpc(harness.connection, 'auth.start', {
      channel: 'buddy',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.value.channel).toBe('buddy')
    expect(started.value.authUrl).toContain('www.codebuddy.cn')

    const completed = await waitForRpcAuthStatus(
      harness.connection,
      'buddy',
      started.value.flowId,
    )
    expect(completed.status).toBe('completed')
    expect(completed.account?.channelId).toBe('buddy')
    expect(harness.double.getState().buddy.currentAccountId).toBe(completed.account?.id)
    expect(harness.double.getState().workbuddy.currentAccountId).toBeNull()
    expect(await harness.store.listEntries('workbuddy')).toHaveLength(0)
    expect(harness.workbuddyCalls).toHaveLength(0)
    expect(harness.buddyCalls.some((url) => url.includes('platform=ide'))).toBe(true)
  })

  it('对应 channel 未注册时在调用任何 flow 前返回 bad-request', async () => {
    const buddyOnly = createRpcHarness({ withBuddyAuth: true })
    const workbuddyResponse = await rawCall(buddyOnly, {
      type: 'client-request',
      rpcId: 'raw-auth-cross-1',
      method: MANAGEMENT_RPC_ENDPOINT,
      payload: { method: 'auth.start', payload: { channel: 'workbuddy' } },
    })
    const workbuddyBody = await workbuddyResponse.json() as {
      result: { ok: boolean; error?: { code: string } }
    }
    expect(workbuddyBody.result.ok).toBe(false)
    expect(workbuddyBody.result.error?.code).toBe('bad-request')
    expect(buddyOnly.buddyCalls).toHaveLength(0)
    expect(await buddyOnly.store.listEntries('buddy')).toHaveLength(0)
    expect(await buddyOnly.store.listEntries('workbuddy')).toHaveLength(0)

    const workbuddyOnly = createRpcHarness({ withWorkbuddyAuth: true })
    const buddyResponse = await rawCall(workbuddyOnly, {
      type: 'client-request',
      rpcId: 'raw-auth-cross-2',
      method: MANAGEMENT_RPC_ENDPOINT,
      payload: { method: 'auth.start', payload: { channel: 'buddy' } },
    })
    const buddyBody = await buddyResponse.json() as {
      result: { ok: boolean; error?: { code: string } }
    }
    expect(buddyBody.result.ok).toBe(false)
    expect(buddyBody.result.error?.code).toBe('bad-request')
    expect(workbuddyOnly.workbuddyCalls).toHaveLength(0)
    expect(await workbuddyOnly.store.listEntries('buddy')).toHaveLength(0)
    expect(await workbuddyOnly.store.listEntries('workbuddy')).toHaveLength(0)
  })

  it('auth.refresh 按 channel 读取对应账号，不触碰另一渠道', async () => {
    const harness = createRpcHarness({ withBuddyAuth: true, withWorkbuddyAuth: true })
    const buddy = await harness.store.saveAccount({
      channel: 'buddy',
      vendorAccountId: 'rpc-shared-user',
      secret: { accessToken: 'RPC_ACCESS_1', refreshToken: 'RPC_REFRESH_1' },
    })
    const workbuddy = await harness.store.saveAccount({
      channel: 'workbuddy',
      vendorAccountId: 'rpc-shared-user',
      secret: { accessToken: 'WB_RPC_ACCESS_1', refreshToken: 'WB_RPC_REFRESH_1' },
    })

    const workbuddyResult = await callManagementRpc(harness.connection, 'auth.refresh', {
      channel: 'workbuddy',
      accountId: workbuddy.accountId,
    })
    expect(workbuddyResult.ok).toBe(true)
    if (workbuddyResult.ok) expect(workbuddyResult.value.channelId).toBe('workbuddy')

    const workbuddyStored = await harness.store.readEntry('workbuddy', workbuddy.accountId)
    expect(workbuddyStored?.account?.secret).toMatchObject({
      accessToken: 'WB_RPC_ACCESS_2',
      refreshToken: 'WB_RPC_REFRESH_2',
    })
    const buddyUntouched = await harness.store.readEntry('buddy', buddy.accountId)
    expect(buddyUntouched?.account?.secret).toMatchObject({
      accessToken: 'RPC_ACCESS_1',
      refreshToken: 'RPC_REFRESH_1',
    })

    const buddyResult = await callManagementRpc(harness.connection, 'auth.refresh', {
      channel: 'buddy',
      accountId: buddy.accountId,
    })
    expect(buddyResult.ok).toBe(true)
    const buddyStored = await harness.store.readEntry('buddy', buddy.accountId)
    expect(buddyStored?.account?.secret).toMatchObject({
      accessToken: 'RPC_ACCESS_2',
      refreshToken: 'RPC_REFRESH_2',
    })
  })

  it('auth.refresh 不读取 WorkBuddy 账号', async () => {
    const harness = createRpcHarness({ withBuddyAuth: true })
    const foreign = await harness.store.saveAccount({
      channel: 'workbuddy',
      vendorAccountId: 'rpc-work-user',
      secret: { accessToken: 'WB_ACCESS', refreshToken: 'WB_REFRESH' },
    })

    const result = await callManagementRpc(harness.connection, 'auth.refresh', {
      channel: 'buddy',
      accountId: foreign.accountId,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('auth/account-not-found')
    const stored = await harness.store.readEntry('workbuddy', foreign.accountId)
    expect(stored?.account?.secret).toMatchObject({
      accessToken: 'WB_ACCESS',
      refreshToken: 'WB_REFRESH',
    })
  })
})
