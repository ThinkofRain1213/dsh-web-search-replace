/**
 * 管理 RPC 的共享契约与 Client 调用器。
 *
 * Host 通过 `connection.fetch.register` 注册精确路由；Client 通过
 * `connection.rpc.call('/api', 'web-search-channels', { method, payload }, signal)`
 * 调用。两端共用同一份 method/payload 校验，避免只信任其中一侧。
 *
 * 方法空间由三部分组成：普通设置（settings.*）、账号管理（accounts.*）与
 * 授权流程（auth.*）。账号与授权 payload 校验分别复用 `shared/accounts.ts`
 * 和 `shared/auth.ts` 的单一实现，不在这里复制第二套。
 */
import type { ChannelId } from './channels.ts'
import {
  ACCOUNT_RPC_METHODS,
  assertAccountRpcPayload,
  isAccountRpcMethod,
  type AccountCollection,
  type AccountRpcPayloads,
  type AccountSummary,
  type ClearAccountsResult,
} from './accounts.ts'
import {
  AUTH_RPC_METHODS,
  assertAuthRpcPayload,
  isAuthRpcMethod,
  type AuthRpcPayloads,
  type AuthRpcResults,
} from './auth.ts'
import {
  assertSearchSettingsPatch,
  assertSetCurrentAccountRequest,
  type SearchSettingsPatch,
  type SearchSettingsSnapshot,
} from './contracts.ts'

/** Connection 的共享 RPC 通道。 */
export const MANAGEMENT_RPC_CHANNEL = '/api'
/** 管理 RPC 的逻辑端点名，也是精确路由的最后一段。 */
export const MANAGEMENT_RPC_ENDPOINT = 'web-search-channels'
/** 精确路由路径。 */
export const MANAGEMENT_RPC_PATH = `${MANAGEMENT_RPC_CHANNEL}/${MANAGEMENT_RPC_ENDPOINT}`

/** 普通设置 RPC 的精确方法名。 */
export const SETTINGS_RPC_METHODS = [
  'settings.get',
  'settings.update',
  'settings.setCurrentAccount',
] as const

/** 管理 RPC 的全部精确方法名：设置 + 账号 + 授权。 */
export const MANAGEMENT_RPC_METHODS = [
  ...SETTINGS_RPC_METHODS,
  ...ACCOUNT_RPC_METHODS,
  ...AUTH_RPC_METHODS,
] as const

/** 普通设置 RPC 方法名。 */
export type SettingsRpcMethod = (typeof SETTINGS_RPC_METHODS)[number]

/** 管理 RPC 方法名。 */
export type ManagementRpcMethod = (typeof MANAGEMENT_RPC_METHODS)[number]

/** 普通设置 RPC 的 payload 形状。 */
export interface SettingsRpcPayloads {
  'settings.get': Record<string, never>
  'settings.update': { readonly patch: SearchSettingsPatch }
  'settings.setCurrentAccount': {
    readonly channel: ChannelId
    readonly accountId: string | null
  }
}

/** 每个管理 RPC 方法接受的内部 payload；账号/授权半边复用共享契约。 */
export type ManagementRpcPayloads = SettingsRpcPayloads & AccountRpcPayloads & AuthRpcPayloads

/** 每个管理 RPC 方法成功时的结果类型；授权半边复用共享结果契约。 */
export type ManagementRpcResults = {
  'settings.get': SearchSettingsSnapshot
  'settings.update': SearchSettingsSnapshot
  'settings.setCurrentAccount': SearchSettingsSnapshot
  'accounts.list': readonly AccountSummary[]
  'accounts.current': AccountSummary | null
  'accounts.setCurrent': AccountSummary | null
  'accounts.delete': AccountCollection
  'accounts.clearAll': ClearAccountsResult
} & AuthRpcResults

/** 管理 RPC 的错误载荷；`details` 是 Connection 客户端解析所必需的对象。 */
export interface RpcErrorPayload {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** 管理 RPC 的统一失败结果。 */
export interface RpcFailure {
  readonly ok: false
  readonly error: RpcErrorPayload
}

/** 管理 RPC 的统一成功结果。 */
export interface RpcSuccess<T> {
  readonly ok: true
  readonly value: T
}

/** 管理 RPC 的统一结果。 */
export type RpcResult<T> = RpcSuccess<T> | RpcFailure

/** Host 侧精确 Fetch 路由形状（与 Connection 的注册签名兼容）。 */
export interface ManagementRpcRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: 'buffered' | 'streaming'
  readonly fetch: (request: Request) => Promise<Response>
}

/** Client 侧调用器只依赖 Connection 的两个公开入口。 */
export interface ManagementRpcConnection {
  readonly fetch: {
    register(route: ManagementRpcRoute): () => Promise<void>
  }
  readonly rpc: {
    call(
      channel: string,
      endpoint: string,
      payload: unknown,
      signal?: AbortSignal,
    ): Promise<RpcResult<unknown>>
  }
}

/** 精确校验管理方法名。 */
export function isManagementRpcMethod(value: unknown): value is ManagementRpcMethod {
  return typeof value === 'string' && (MANAGEMENT_RPC_METHODS as readonly string[]).includes(value)
}

/**
 * 严格校验一个方法对应的 payload。
 *
 * 账号方法直接委托 `assertAccountRpcPayload`，授权方法委托
 * `assertAuthRpcPayload`，因此 Host/Client 不会出现多套漂移校验。未知键、
 * 缺失键和错误类型都抛错；Host 捕获后映射为 `gateway/bad-request` 或对应域
 * 错误，Client 侧则在真正发出请求前失败。
 */
export function assertManagementRpcPayload<M extends ManagementRpcMethod>(
  method: M,
  payload: unknown,
): asserts payload is ManagementRpcPayloads[M] {
  if (!isRecord(payload)) {
    throw new TypeError(`管理 RPC ${method} 的 payload 必须是普通对象`)
  }
  if (isAccountRpcMethod(method)) {
    assertAccountRpcPayload(method, payload)
    return
  }
  if (isAuthRpcMethod(method)) {
    assertAuthRpcPayload(method, payload)
    return
  }
  switch (method) {
    case 'settings.get':
      if (Object.keys(payload).length !== 0) {
        throw new TypeError('settings.get 不接受 payload 字段')
      }
      return
    case 'settings.update': {
      if (!Object.hasOwn(payload, 'patch')) {
        throw new TypeError('settings.update 缺少 patch')
      }
      if (Object.keys(payload).length !== 1) {
        throw new TypeError('settings.update 只接受 patch 字段')
      }
      assertSearchSettingsPatch(payload.patch)
      return
    }
    case 'settings.setCurrentAccount':
      assertSetCurrentAccountRequest(payload)
      return
    default:
      throw new TypeError(`未知管理方法：${String(method)}`)
  }
}

/**
 * 调用管理 RPC；无效 method/payload 在发出请求前抛错。
 *
 * 返回类型按方法映射：设置方法返回设置快照，账号方法返回对应账号 DTO，
 * 授权方法返回脱敏流程状态或 AccountSummary。
 */
export function callManagementRpc<M extends ManagementRpcMethod>(
  connection: ManagementRpcConnection,
  method: M,
  payload: ManagementRpcPayloads[M],
  signal?: AbortSignal,
): Promise<RpcResult<ManagementRpcResults[M]>> {
  if (!isManagementRpcMethod(method)) {
    throw new TypeError(`未知管理方法：${String(method)}`)
  }
  assertManagementRpcPayload(method, payload)
  return connection.rpc.call(
    MANAGEMENT_RPC_CHANNEL,
    MANAGEMENT_RPC_ENDPOINT,
    { method, payload },
    signal,
  ) as Promise<RpcResult<ManagementRpcResults[M]>>
}

/** 判断普通数据对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
