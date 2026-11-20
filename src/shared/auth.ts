/**
 * 授权流程（CodeBuddy / WorkBuddy / Qoder 国际版 / Qoder 中国版）的共享 RPC 契约。
 *
 * 本文件只定义 Client 可见的非秘密投影、严格 payload 校验与通用错误边界：
 *
 * - 四个方法 `auth.start/cancel/status/refresh` 都只接受
 *   `channel: 'buddy' | 'workbuddy' | 'qoder' | 'qodercn'`；每个产品 flow 仍只
 *   处理自己的渠道；
 * - 每个方法只接受自己声明的字段，未知键、缺失键和错误类型一律拒绝；
 * - 状态结果只含 flowId、状态、授权 URL、固定展示说明与 AccountSummary，
 *   绝不包含 accessToken、refreshToken、secret、上游响应正文或异常原文；
 * - Host 与 Client 共用同一个 `assertAuthRpcPayload`，不复制第二套校验；
 * - `AuthFlowError` 是产品错误的通用基类，Host 根 RPC 只依赖它，不 import
 *   任何产品错误类。
 *
 * 渠道隔离：共享的是契约与底层协议形状，不是账号、当前账号、flowId 状态或
 * 运行时刷新 map；那些必须由每个产品 flow 实例独立持有。
 */
import { isChannelId } from './channels.ts'
import { ACCOUNT_STATUSES, type AccountSummary } from './accounts.ts'
import { isStableChannelAccountId } from './contracts.ts'

/** CodeBuddy 授权渠道；CodeBuddy 与 WorkBuddy 绝不共享账号状态。 */
export const BUDDY_AUTH_CHANNEL = 'buddy' as const

/** WorkBuddy 国际版授权渠道。 */
export const WORKBUDDY_AUTH_CHANNEL = 'workbuddy' as const

/** Qoder 国际版授权渠道；中国版使用独立渠道与独立流程。 */
export const QODER_AUTH_CHANNEL = 'qoder' as const

/**
 * Qoder 中国版授权渠道。
 *
 * 与 `QODER_AUTH_CHANNEL` 共享设备授权协议形状，但产品参数、账号、当前账号、
 * grant、flowId、刷新单飞与 dispose 状态完全独立。
 */
export const QODERCN_AUTH_CHANNEL = 'qodercn' as const

/** 共享授权契约允许的四个渠道。 */
export const AUTH_CHANNELS = [
  BUDDY_AUTH_CHANNEL,
  WORKBUDDY_AUTH_CHANNEL,
  QODER_AUTH_CHANNEL,
  QODERCN_AUTH_CHANNEL,
] as const

/** 授权渠道字面量类型。 */
export type AuthChannel = (typeof AUTH_CHANNELS)[number]

/**
 * 每个渠道允许的授权 URL host 白名单；精确匹配，不允许后缀或跨渠道复用。
 *
 * 这些值只描述服务端下发的 external-link 授权页 host，不是搜索端点，也不含
 * 凭证材料。Host 产品层仍负责在生成链接时校验；Client 用同一份最小安全契约
 * 防止错接线/恶意回包把其他域链接交给用户复制。
 */
export const AUTH_URL_HOSTS: Readonly<Record<AuthChannel, readonly string[]>> = Object.freeze({
  buddy: Object.freeze(['www.codebuddy.cn', 'copilot.tencent.com']),
  workbuddy: Object.freeze(['www.workbuddy.ai']),
  qoder: Object.freeze(['qoder.com']),
  qodercn: Object.freeze(['qoder.cn']),
})

/** CodeBuddy 渠道字面量类型（保留 Task 9 的公开别名）。 */
export type BuddyAuthChannel = typeof BUDDY_AUTH_CHANNEL

/** WorkBuddy 渠道字面量类型。 */
export type WorkbuddyAuthChannel = typeof WORKBUDDY_AUTH_CHANNEL

/** Qoder 国际版渠道字面量类型。 */
export type QoderAuthChannel = typeof QODER_AUTH_CHANNEL

/** Qoder 中国版渠道字面量类型。 */
export type QoderCnAuthChannel = typeof QODERCN_AUTH_CHANNEL

/** 授权流程状态；`pending` 之外都是终态。 */
export const AUTH_FLOW_STATES = [
  'pending',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const

/** 授权流程状态类型。 */
export type AuthFlowState = (typeof AUTH_FLOW_STATES)[number]

/** 授权流程的稳定错误码；Client 只按 code 展示固定文案。 */
export const AUTH_FLOW_ERROR_CODES = [
  'auth/invalid',
  'auth/flow-active',
  'auth/flow-not-found',
  'auth/timeout',
  'auth/cancelled',
  'auth/failed',
  'auth/invalid-response',
  'auth/disposed',
  'auth/account-not-found',
  'auth/credential-unavailable',
  'auth/identity-mismatch',
  'auth/reauth-required',
  'auth/refresh-failed',
  'auth/current-account-failed',
  'auth/internal',
] as const

/** 授权流程错误码类型。 */
export type AuthFlowErrorCode = (typeof AUTH_FLOW_ERROR_CODES)[number]

/**
 * 产品授权错误的通用基类。
 *
 * 只承载固定 code 与固定 message；子类（BuddyAuthError / WorkbuddyAuthError /
 * QoderInternationalAuthError / QoderCnAuthError）可提供产品文案，但绝不设置
 * `cause`，避免秘密沿
 * 错误链泄漏。Host 根 RPC 只捕获本基类，因此新增渠道不需要再改通用 dispatcher
 * 的产品 import。
 */
export class AuthFlowError extends Error {
  override readonly name: string = 'AuthFlowError'

  constructor(
    readonly code: AuthFlowErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** 判断授权域错误；不接受仅形状相似的任意对象。 */
export function isAuthFlowError(value: unknown): value is AuthFlowError {
  return value instanceof AuthFlowError
}

/** 授权流程 `start` 的共享选项；提供 accountId 表示重新登录。 */
export interface AuthFlowStartOptions {
  readonly accountId?: string
}

/**
 * Host 授权 dispatcher 需要的最小 flow 端口。
 *
 * 产品 flow 的实例状态（账号、flowId、刷新单飞、取消、dispose）彼此独立；
 * 本接口只描述 RPC 分派需要的方法，不提供任何共享状态。
 */
export interface AuthFlowPort {
  /** 固定归属；注册与每次 dispatch 都必须在任何工作前核对。 */
  readonly channel: AuthChannel
  start(options?: AuthFlowStartOptions, callerSignal?: AbortSignal): Promise<AuthFlowStatus>
  cancel(flowId: string, callerSignal?: AbortSignal): Promise<AuthFlowStatus>
  status(flowId: string, callerSignal?: AbortSignal): Promise<AuthFlowStatus>
  /** caller 只取消等待；共享 refresh 的 owner 仍继续并 settle。 */
  refresh(accountId: string, callerSignal?: AbortSignal): Promise<AccountSummary>
}

/**
 * Client 可见的授权流程状态。
 *
 * `authUrl` 是服务端下发的 external-link 登录地址（已校验为 https 与精确
 * host）；`account` 只在成功后出现；`errorCode` 是固定码，不携带上游原文。
 */
export interface AuthFlowStatus {
  readonly flowId: string
  readonly channel: AuthChannel
  readonly status: AuthFlowState
  readonly authUrl: string | null
  readonly displayHint: string
  readonly account: AccountSummary | null
  readonly errorCode: AuthFlowErrorCode | null
}

/** 四个授权 RPC 方法名。 */
export const AUTH_RPC_METHODS = [
  'auth.start',
  'auth.cancel',
  'auth.status',
  'auth.refresh',
] as const

/** 授权 RPC 方法名。 */
export type AuthRpcMethod = (typeof AUTH_RPC_METHODS)[number]

/** 每个授权 RPC 方法接受的内部 payload。 */
export interface AuthRpcPayloads {
  'auth.start': {
    readonly channel: AuthChannel
    /** 提供时表示对既有账号重新登录，而不是新增账号。 */
    readonly accountId?: string
  }
  'auth.cancel': {
    readonly channel: AuthChannel
    readonly flowId: string
  }
  'auth.status': {
    readonly channel: AuthChannel
    readonly flowId: string
  }
  'auth.refresh': {
    readonly channel: AuthChannel
    readonly accountId: string
  }
}

/** 每个授权 RPC 方法成功时的结果类型。 */
export interface AuthRpcResults {
  'auth.start': AuthFlowStatus
  'auth.cancel': AuthFlowStatus
  'auth.status': AuthFlowStatus
  'auth.refresh': AccountSummary
}

/** 授权 RPC payload 校验失败；RPC 层映射为 `auth/invalid`。 */
export class AuthRpcValidationError extends Error {
  readonly code = 'auth/invalid'

  constructor(message: string) {
    super(message)
    this.name = 'AuthRpcValidationError'
  }
}

/** 精确校验授权 RPC 方法名。 */
export function isAuthRpcMethod(value: unknown): value is AuthRpcMethod {
  return typeof value === 'string' && (AUTH_RPC_METHODS as readonly string[]).includes(value)
}

/** 精确校验共享授权渠道。 */
export function isAuthChannel(value: unknown): value is AuthChannel {
  return typeof value === 'string' && (AUTH_CHANNELS as readonly string[]).includes(value)
}

/**
 * 校验某个渠道的授权 URL 是否满足 Client 可见安全边界。
 *
 * 规则与 Host 产品边界一致：绝对 https URL、精确 hostname、无 userinfo、
 * 仅允许省略端口或显式标准 :443、无 fragment、无原始控制字符、长度不超过 2048。
 * 使用 `new URL` 解析而不是字符串前后缀匹配，避免 `qoder.com.evil`、
 * `notqoder.com` 等伪造域通过。
 *
 * @param value - Host 回包的 authUrl。
 * @param channel - 当前授权流程所属渠道。
 * @returns 是否为该渠道可展示/复制的授权 URL。
 */
export function isAuthUrlForChannel(value: unknown, channel: AuthChannel): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 2048) return false
  if (value !== value.trim()) return false
  // 原始控制字符必须在进入 URL parser 前拒绝；parser 可能静默剥离部分字符。
  if (/[\u0000-\u001F\u007F]/.test(value)) return false

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.port !== '') return false
  if (url.hash !== '') return false
  if (!(AUTH_URL_HOSTS[channel] as readonly string[]).includes(url.hostname)) return false

  // URL parser 会把标准 :443 归一化为空 port；原始 authority 只允许这一种
  // 显式端口。其他端口已由 url.port 拒绝，IPv6/多重冒号仍 fail-closed。
  const afterScheme = value.slice(value.indexOf('://') + 3)
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? ''
  if (authority.includes(':')) {
    if (!authority.endsWith(':443')) return false
    const withoutDefaultPort = authority.slice(0, -4)
    if (withoutDefaultPort.includes(':')) return false
    if (withoutDefaultPort.toLowerCase() !== url.hostname) return false
  }

  return true
}

/** 稳定 flowId 语法：小写字母/数字开头，只含小写字母、数字和连字符。 */
export function isAuthFlowId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
}

/** 判断普通数据对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断对象是否恰好只有给定键；用于结果自检，防止秘密字段夹带。 */
function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key))
}

/** 拒绝未声明的 payload 键。 */
function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new AuthRpcValidationError(`${context} 不接受未声明的字段`)
    }
  }
}

/** 只接受 buddy|workbuddy|qoder|qodercn 渠道，绝不静默忽略其他渠道。 */
function requireAuthChannel(record: Record<string, unknown>, context: string): void {
  if (!Object.hasOwn(record, 'channel') || !isAuthChannel(record.channel)) {
    throw new AuthRpcValidationError(
      `${context} 只接受 channel=buddy、channel=workbuddy、channel=qoder 或 channel=qodercn`,
    )
  }
}

/** 校验必填账号 ID。 */
function requireAccountId(value: unknown, context: string): string {
  if (!isStableChannelAccountId(value)) {
    throw new AuthRpcValidationError(`${context} 的 accountId 必须是稳定小写 ID`)
  }
  return value
}

/** 校验必填 flowId。 */
function requireFlowId(value: unknown, context: string): string {
  if (!isAuthFlowId(value)) {
    throw new AuthRpcValidationError(`${context} 的 flowId 必须是稳定小写 ID`)
  }
  return value
}

/**
 * 严格校验授权 RPC payload。
 *
 * 错误消息固定且不回显输入值，避免把恶意 payload 原文带进 RPC 错误。
 */
export function assertAuthRpcPayload<M extends AuthRpcMethod>(
  method: M,
  payload: unknown,
): asserts payload is AuthRpcPayloads[M] {
  if (!isRecord(payload)) {
    throw new AuthRpcValidationError(`授权 RPC ${method} 的 payload 必须是普通对象`)
  }
  switch (method) {
    case 'auth.start':
      rejectUnknownKeys(payload, ['channel', 'accountId'], method)
      requireAuthChannel(payload, method)
      if (Object.hasOwn(payload, 'accountId')) {
        requireAccountId(payload.accountId, method)
      }
      return
    case 'auth.cancel':
    case 'auth.status':
      rejectUnknownKeys(payload, ['channel', 'flowId'], method)
      requireAuthChannel(payload, method)
      if (!Object.hasOwn(payload, 'flowId')) {
        throw new AuthRpcValidationError(`${method} 缺少 flowId`)
      }
      requireFlowId(payload.flowId, method)
      return
    case 'auth.refresh':
      rejectUnknownKeys(payload, ['channel', 'accountId'], method)
      requireAuthChannel(payload, method)
      if (!Object.hasOwn(payload, 'accountId')) {
        throw new AuthRpcValidationError('auth.refresh 缺少 accountId')
      }
      requireAccountId(payload.accountId, method)
      return
    default:
      throw new AuthRpcValidationError('未知授权 RPC 方法')
  }
}

/** 判断 AccountSummary 的最小安全形状（结果自检用；拒绝额外键）。 */
export function isAccountSummary(value: unknown): value is AccountSummary {
  if (!isRecord(value)) return false
  if (!hasExactKeys(value, [
    'id',
    'displayName',
    'channelId',
    'endpointLabel',
    'status',
    'maskedIdentifier',
  ])) return false
  return isStableChannelAccountId(value.id)
    && typeof value.displayName === 'string'
    && isChannelId(value.channelId)
    && typeof value.endpointLabel === 'string'
    && typeof value.status === 'string'
    && (ACCOUNT_STATUSES as readonly string[]).includes(value.status)
    && typeof value.maskedIdentifier === 'string'
}

/** 判断授权流程状态结果的最小安全形状（结果自检用；拒绝额外键）。 */
export function isAuthFlowStatus(value: unknown): value is AuthFlowStatus {
  if (!isRecord(value)) return false
  if (!hasExactKeys(value, [
    'flowId',
    'channel',
    'status',
    'authUrl',
    'displayHint',
    'account',
    'errorCode',
  ])) return false
  return isAuthFlowId(value.flowId)
    && isAuthChannel(value.channel)
    && typeof value.status === 'string'
    && (AUTH_FLOW_STATES as readonly string[]).includes(value.status)
    && (value.authUrl === null || typeof value.authUrl === 'string')
    && typeof value.displayHint === 'string'
    && (
      value.account === null
      || (isAccountSummary(value.account) && value.account.channelId === value.channel)
    )
    && (
      value.errorCode === null
      || (typeof value.errorCode === 'string'
        && (AUTH_FLOW_ERROR_CODES as readonly string[]).includes(value.errorCode))
    )
}

/**
 * 判断授权流程状态是否属于指定渠道。
 *
 * Host 分派与产品 dispatcher 都用它做最后一道结果自检：即使某个 flow 被错误
 * 接线，返回了另一渠道的状态/账号，也不会被当作成功结果交给 Client。
 */
export function isAuthFlowStatusForChannel(
  value: unknown,
  channel: AuthChannel,
): value is AuthFlowStatus {
  return isAuthFlowStatus(value)
    && value.channel === channel
    && (value.account === null || value.account.channelId === channel)
}
