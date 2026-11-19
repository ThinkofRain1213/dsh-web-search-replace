/**
 * CodeBuddy 授权流程的共享 RPC 契约。
 *
 * 本文件只定义 Client 可见的非秘密投影与严格 payload 校验：
 *
 * - 四个方法 `auth.start/cancel/status/refresh` 都只接受 `channel: 'buddy'`；
 * - 每个方法只接受自己声明的字段，未知键、缺失键和错误类型一律拒绝；
 * - 状态结果只含 flowId、状态、授权 URL、固定展示说明与 AccountSummary，
 *   绝不包含 accessToken、refreshToken、secret、上游响应正文或异常原文；
 * - Host 与 Client 共用同一个 `assertAuthRpcPayload`，不复制第二套校验。
 *
 * Task 10 的 WorkBuddy 授权必须扩展自己的方法/渠道，不得复用本文件的
 * `channel: 'buddy'` 字面量。
 */
import { isChannelId } from './channels.ts'
import { ACCOUNT_STATUSES, type AccountSummary } from './accounts.ts'
import { isStableChannelAccountId } from './contracts.ts'

/** 本任务唯一允许的授权渠道；CodeBuddy 与 WorkBuddy 绝不共享。 */
export const BUDDY_AUTH_CHANNEL = 'buddy' as const

/** 授权渠道字面量类型。 */
export type BuddyAuthChannel = typeof BUDDY_AUTH_CHANNEL

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
 * Client 可见的授权流程状态。
 *
 * `authUrl` 是服务端下发的 external-link 登录地址（已校验为 https）；
 * `account` 只在成功后出现；`errorCode` 是固定码，不携带上游原文。
 */
export interface AuthFlowStatus {
  readonly flowId: string
  readonly channel: BuddyAuthChannel
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
    readonly channel: BuddyAuthChannel
    /** 提供时表示对既有账号重新登录，而不是新增账号。 */
    readonly accountId?: string
  }
  'auth.cancel': {
    readonly channel: BuddyAuthChannel
    readonly flowId: string
  }
  'auth.status': {
    readonly channel: BuddyAuthChannel
    readonly flowId: string
  }
  'auth.refresh': {
    readonly channel: BuddyAuthChannel
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

/** 稳定 flowId 语法：小写字母/数字开头，只含小写字母、数字和连字符。 */
export function isAuthFlowId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
}

/** 判断普通数据对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/** 只接受 CodeBuddy 渠道，绝不静默忽略其他渠道。 */
function requireBuddyChannel(record: Record<string, unknown>, context: string): void {
  if (!Object.hasOwn(record, 'channel') || record.channel !== BUDDY_AUTH_CHANNEL) {
    throw new AuthRpcValidationError(`${context} 只接受 channel=buddy`)
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
      requireBuddyChannel(payload, method)
      if (Object.hasOwn(payload, 'accountId')) {
        requireAccountId(payload.accountId, method)
      }
      return
    case 'auth.cancel':
    case 'auth.status':
      rejectUnknownKeys(payload, ['channel', 'flowId'], method)
      requireBuddyChannel(payload, method)
      if (!Object.hasOwn(payload, 'flowId')) {
        throw new AuthRpcValidationError(`${method} 缺少 flowId`)
      }
      requireFlowId(payload.flowId, method)
      return
    case 'auth.refresh':
      rejectUnknownKeys(payload, ['channel', 'accountId'], method)
      requireBuddyChannel(payload, method)
      if (!Object.hasOwn(payload, 'accountId')) {
        throw new AuthRpcValidationError('auth.refresh 缺少 accountId')
      }
      requireAccountId(payload.accountId, method)
      return
    default:
      throw new AuthRpcValidationError('未知授权 RPC 方法')
  }
}

/** 判断 AccountSummary 的最小安全形状（结果自检用）。 */
export function isAccountSummary(value: unknown): value is AccountSummary {
  if (!isRecord(value)) return false
  return isStableChannelAccountId(value.id)
    && typeof value.displayName === 'string'
    && isChannelId(value.channelId)
    && typeof value.endpointLabel === 'string'
    && typeof value.status === 'string'
    && (ACCOUNT_STATUSES as readonly string[]).includes(value.status)
    && typeof value.maskedIdentifier === 'string'
}

/** 判断授权流程状态结果的最小安全形状（结果自检用）。 */
export function isAuthFlowStatus(value: unknown): value is AuthFlowStatus {
  if (!isRecord(value)) return false
  return isAuthFlowId(value.flowId)
    && value.channel === BUDDY_AUTH_CHANNEL
    && typeof value.status === 'string'
    && (AUTH_FLOW_STATES as readonly string[]).includes(value.status)
    && (value.authUrl === null || typeof value.authUrl === 'string')
    && typeof value.displayHint === 'string'
    && (
      value.account === null
      || (isAccountSummary(value.account) && value.account.channelId === BUDDY_AUTH_CHANNEL)
    )
    && (
      value.errorCode === null
      || (typeof value.errorCode === 'string'
        && (AUTH_FLOW_ERROR_CODES as readonly string[]).includes(value.errorCode))
    )
}
