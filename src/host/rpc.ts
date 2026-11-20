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
  AccountRpcValidationError,
  isAccountRpcMethod,
} from '../shared/accounts.ts'
import {
  assertAuthRpcPayload,
  AuthFlowError,
  AuthRpcValidationError,
  isAuthRpcMethod,
  type AuthChannel,
  type AuthFlowPort,
} from '../shared/auth.ts'
import { SearchSettingsValidationError } from '../shared/contracts.ts'
import type { HostRuntimeSnapshot } from '../shared/runtime.ts'
import { AccountError } from './accounts/errors.ts'
import { dispatchAccountRpc } from './accounts/rpc-methods.ts'
import type { AccountService } from './accounts/service.ts'
import { dispatchChannelAuthRpc } from './channels/auth-rpc.ts'
import type { SettingsService } from './settings/service.ts'
import { registerGenerationRoute } from './route-broker.ts'
import type { PluginLifecycle } from './lifecycle.ts'
import { InFlightStoppedError } from './inflight.ts'

/**
 * 按渠道注册的授权流程。
 *
 * Host 只按 payload.channel 精确选择对应 flow；Buddy/WorkBuddy/Qoder 国际版/
 * Qoder 中国版绝不共享实例、账号或运行时状态。未注册的渠道返回 `bad-request`，
 * 不会回退到另一渠道。
 */
export type AuthFlowRegistry = Partial<Record<AuthChannel, AuthFlowPort>>

/** Host runtime 只读端口；实现由本代 observation store 提供。 */
export interface HostRuntimePort {
  getSnapshot(): HostRuntimeSnapshot
}

/** 完整根组合的可选扩展；保留旧测试的局部组合入口。 */
export interface ManagementRpcOptions {
  readonly runtime?: HostRuntimePort
  readonly lifecycle?: PluginLifecycle
}

/** 兼容旧 disposer 调用，同时暴露本代 async setup readiness。 */
export type ManagementRpcDisposer = (() => Promise<void>) & { readonly ready: Promise<void> }

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
 * @param accounts 账号服务；Task 15 的 Host 根组合负责提供，未提供时账号方法
 *   返回 `bad-request`，普通设置方法不受影响。
 * @param authFlows 按 channel 注册的授权流程；未提供对应渠道时 auth.* 返回
 *   `bad-request`，绝不回退到另一渠道。根组合仍由 Task 15 负责。
 * @returns 异步 disposer；调用方应把它登记到插件生命周期。
 */
export function registerManagementRpc(
  connection: ManagementRpcConnection,
  settings: SettingsService,
  accounts?: AccountService,
  authFlows?: AuthFlowRegistry,
  options: ManagementRpcOptions = {},
): ManagementRpcDisposer {
  const registration = registerGenerationRoute(connection, {
    path: MANAGEMENT_RPC_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleManagementRpcRequest(settings, request, accounts, authFlows, options),
  })
  const dispose = async (): Promise<void> => { await registration.dispose() }
  Object.defineProperty(dispose, 'ready', { value: registration.ready, enumerable: true })
  return dispose as ManagementRpcDisposer
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
  accounts?: AccountService,
  authFlows?: AuthFlowRegistry,
  options: ManagementRpcOptions = {},
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
    const lease = options.lifecycle?.begin(request.signal)
    const operation = dispatch(
      settings,
      accounts,
      authFlows,
      envelope.call.method,
      envelope.call.payload,
      options,
      lease?.signal ?? request.signal,
    )
    const value = lease === undefined ? await operation : await lease.track(operation)
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

/** 按 method 分派到设置、账号或对应渠道的授权服务。 */
async function dispatch(
  settings: SettingsService,
  accounts: AccountService | undefined,
  authFlows: AuthFlowRegistry | undefined,
  method: string,
  payload: unknown,
  options: ManagementRpcOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  if (isAccountRpcMethod(method)) {
    if (accounts === undefined) throw new UnknownManagementMethodError(method)
    return dispatchAccountRpc(accounts, method, payload, signal)
  }
  if (isAuthRpcMethod(method)) {
    // 先校验共享 payload 才能安全读取 channel；随后只查该渠道的 flow。
    // 产品 dispatcher 会再次校验（防御性），但校验实现只有 shared/auth.ts 一份。
    assertAuthRpcPayload(method, payload)
    const flow = authFlows !== undefined && Object.hasOwn(authFlows, payload.channel)
      ? authFlows[payload.channel]
      : undefined
    if (flow === undefined) throw new UnknownManagementMethodError(method)
    return dispatchChannelAuthRpc(
      flow,
      payload.channel,
      method,
      payload,
      genericAuthInternalError,
      signal,
    )
  }
  switch (method) {
    case 'settings.get':
      assertManagementRpcPayload(method, payload)
      return settings.getSnapshot()
    case 'settings.update':
      assertManagementRpcPayload(method, payload)
      return settings.updateSearch(payload.patch, signal)
    case 'settings.setCurrentAccount': {
      assertManagementRpcPayload(method, payload)
      if (accounts === undefined) throw new UnknownManagementMethodError(method)
      await accounts.setCurrent(payload.channel, payload.accountId, signal)
      return settings.getSnapshot()
    }
    case 'runtime.get':
      assertManagementRpcPayload(method, payload)
      if (options.runtime === undefined) throw new UnknownManagementMethodError(method)
      return options.runtime.getSnapshot()
    default:
      throw new UnknownManagementMethodError(method)
  }
}

/** 通用授权结果自检失败；Host 根分派不依赖任何产品错误类。 */
function genericAuthInternalError(): AuthFlowError {
  return new AuthFlowError('auth/internal', '授权内部错误')
}

/** 把任意错误映射为稳定的 RPC 失败；不泄露秘密或依赖原文。 */
function toFailure(error: unknown): RpcErrorPayload {
  if (error instanceof SearchSettingsValidationError) {
    return {
      code: error.code,
      message: error.message,
      details: {},
    }
  }
  if (error instanceof AccountRpcValidationError) {
    return {
      code: error.code,
      message: error.message,
      details: {},
    }
  }
  if (error instanceof AuthRpcValidationError) {
    return {
      code: error.code,
      message: error.message,
      details: {},
    }
  }
  if (error instanceof AccountError) {
    return {
      code: error.code,
      message: error.message,
      details: {},
    }
  }
  if (error instanceof AuthFlowError) {
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
  if (error instanceof InFlightStoppedError) {
    return {
      code: 'lifecycle/stopped',
      message: 'plugin activation is stopping',
      details: {},
    }
  }
  return {
    code: 'settings/internal',
    message: 'settings operation failed',
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
