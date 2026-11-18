/**
 * Task 2：管理 RPC 的传输形状、严格校验与统一结果。
 *
 * Host 通过 `connection.fetch.register({ path, methods, requestBody, fetch })`
 * 注册精确路由；Client 通过 `connection.rpc.call('/api', 'web-search-channels',
 * { method, payload }, signal)` 调用。测试直接搭一条与真实 Connection 相同的
 * client-request/server-response 信封，避免只测单侧。
 */
import { describe, expect, it } from 'vitest'

import { registerManagementRpc } from '../../src/host/rpc.ts'
import { SettingsService } from '../../src/host/settings/service.ts'
import { DEFAULT_SEARCH_SETTINGS } from '../../src/shared/contracts.ts'
import {
  callManagementRpc,
  MANAGEMENT_RPC_ENDPOINT,
  MANAGEMENT_RPC_PATH,
  type ManagementRpcConnection,
  type ManagementRpcRoute,
  type RpcResult,
} from '../../src/shared/rpc.ts'
import { createSettingsDouble } from './support/settings-double.ts'

/** 一个最小但真实的 connection 双端：注册路由 + 用 rpc.call 发信封。 */
function createRpcHarness() {
  const double = createSettingsDouble()
  const settings = new SettingsService({
    configEditor: double.editor,
    entry: { id: 'dsh-web-search-channels' },
    config: double.config,
  })
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
  const dispose = registerManagementRpc(connection, settings)
  return { connection, settings, double, routes, dispose }
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
