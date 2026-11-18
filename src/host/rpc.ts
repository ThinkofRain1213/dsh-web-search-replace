/**
 * Host 管理 RPC：在 Connection 的共享 `/api` 通道上注册精确路由。
 *
 * 采用 JetHub 验证过的形状：Host 用 `connection.fetch.register` 注册
 * `/api/web-search-channels`，Client 用 `connection.rpc.call` 发送
 * `{ type: 'client-request', rpcId, method, payload }` 信封。Host 严格校验
 * 信封、method 与 payload，并统一返回 `{ ok: true, value } | { ok: false, error }`。
 *
 * 错误结果必须带对象 `details`，否则 DSH Connection 的客户端解析器会拒绝
 * 整个响应。响应只包含非秘密快照，不返回 token、刷新材料或签名秘密。
 */
import {
  MANAGEMENT_RPC_ENDPOINT,
  MANAGEMENT_RPC_PATH,
  assertManagementRpcPayload,
  type ManagementRpcConnection,
  type RpcErrorPayload,
  type RpcResult,
} from '../shared/rpc.ts'
import {
  SearchSettingsValidationError,
  type SearchSettingsSnapshot,
} from '../shared/contracts.ts'
import type { SettingsService } from './settings/service.ts'

/** 未知管理方法；映射为 RPC 的 `bad-request`。 */
class UnknownManagementMethodError extends Error {
  readonly code = 'bad-request'

  constructor(method: string) {
    super(`unknown method: ${method}`)
    this.name = 'UnknownManagementMethodError'
  }
}

/**
 * 注册管理 RPC 精确路由。
 *
 * @param connection Connection Host 服务。
 * @param settings 普通设置服务。
 * @returns 异步 disposer；调用方应把它登记到插件生命周期。
 */
export function registerManagementRpc(
  connection: ManagementRpcConnection,
  settings: SettingsService,
): () => Promise<void> {
  return connection.fetch.register({
    path: MANAGEMENT_RPC_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleManagementRpcRequest(settings, request),
  })
}

/**
 * 处理一次已认证的管理 RPC HTTP 请求。
 *
 * 传输层错误（方法、content-type、JSON）返回裸 HTTP 状态；一旦信封可解析，
 * 所有业务与校验结果都通过统一的 server-response 返回。
 */
export async function handleManagementRpcRequest(
  settings: SettingsService,
  request: Request,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 })
  }
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return new Response('content type must be application/json', { status: 415 })
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('body is not JSON', { status: 400 })
  }

  const envelope = parseEnvelope(body)
  if ('error' in envelope) {
    return jsonReply(envelope.rpcId, { ok: false, error: envelope.error })
  }
  try {
    const value = await dispatch(settings, envelope.call.method, envelope.call.payload)
    return jsonReply(envelope.rpcId, { ok: true, value })
  } catch (error) {
    return jsonReply(envelope.rpcId, { ok: false, error: toFailure(error) })
  }
}

/** 已解析的一次调用。 */
interface ParsedCall {
  readonly method: string
  readonly payload: unknown
}

/** 信封解析结果：要么得到调用，要么得到带 rpcId 的失败。 */
type ParsedEnvelope =
  | { readonly rpcId: string; readonly call: ParsedCall }
  | { readonly rpcId: string; readonly error: RpcErrorPayload }

/** 解析并校验 Connection 的 client-request 信封。 */
function parseEnvelope(body: unknown): ParsedEnvelope {
  const record = isRecord(body) ? body : undefined
  const rpcId = typeof record?.rpcId === 'string' ? record.rpcId : 'invalid-request'
  const fail = (message: string): ParsedEnvelope => ({
    rpcId,
    error: {
      code: 'gateway/bad-request',
      message,
      details: {},
    },
  })

  if (record === undefined || record.type !== 'client-request') {
    return fail('invalid management request')
  }
  if (typeof record.rpcId !== 'string') {
    return fail('invalid management request')
  }
  if (record.method !== MANAGEMENT_RPC_ENDPOINT) {
    return fail(
      `method ${JSON.stringify(record.method)} does not match endpoint ${JSON.stringify(MANAGEMENT_RPC_ENDPOINT)}`,
    )
  }
  if (!Object.hasOwn(record, 'payload')) {
    return fail('invalid management request')
  }
  const call = record.payload
  if (!isRecord(call) || typeof call.method !== 'string' || !Object.hasOwn(call, 'payload')) {
    return fail('invalid management request')
  }
  return { rpcId, call: { method: call.method, payload: call.payload } }
}

/** 按 method 分派到设置服务。 */
async function dispatch(
  settings: SettingsService,
  method: string,
  payload: unknown,
): Promise<SearchSettingsSnapshot> {
  switch (method) {
    case 'settings.get':
      assertManagementRpcPayload(method, payload)
      return settings.getSnapshot()
    case 'settings.update':
      assertManagementRpcPayload(method, payload)
      return settings.updateSearch(payload.patch)
    case 'settings.setCurrentAccount':
      assertManagementRpcPayload(method, payload)
      return settings.setCurrentAccount(payload.channel, payload.accountId)
    default:
      throw new UnknownManagementMethodError(method)
  }
}

/** 把任意错误映射为稳定的 RPC 失败；不泄露秘密。 */
function toFailure(error: unknown): RpcErrorPayload {
  if (error instanceof SearchSettingsValidationError) {
    return {
      code: error.code,
      message: error.message,
      details: {},
    }
  }
  if (error instanceof UnknownManagementMethodError) {
    return {
      code: error.code,
      message: error.message,
      details: {},
    }
  }
  return {
    code: 'settings/internal',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  }
}

/** 构造带 rpcId 的 server-response 信封。 */
function jsonReply(rpcId: string, result: RpcResult<unknown>): Response {
  return Response.json({ type: 'server-response', rpcId, result })
}

/** 判断普通数据对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
