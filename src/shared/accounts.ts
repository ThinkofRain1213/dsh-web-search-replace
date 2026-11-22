/**
 * 账号管理的共享 DTO、状态与 RPC 契约。
 *
 * 这里只放 Client 可见的非秘密投影：账号稳定 ID、显示名、渠道、端点标签、
 * 状态与脱敏标识。token、刷新材料、machine_id、签名材料和厂商原始身份永远
 * 只存在于 Host credentials 的 grant 记录里，不得进入本文件的任何类型。
 */
import { isChannelId, type ChannelId } from './channels.ts'
import { isStableChannelAccountId } from './contracts.ts'

/** 账号运行时/持久化状态；与持久化用户意图（currentAccountId）分离。 */
export type AccountStatus =
  | 'checking'
  | 'ready'
  | 'refreshing'
  | 'reauth_required'
  | 'temporarily_unavailable'
  | 'credential_unavailable'

/** 全部账号状态，供 Client 校验与展示。 */
export const ACCOUNT_STATUSES = [
  'checking',
  'ready',
  'refreshing',
  'reauth_required',
  'temporarily_unavailable',
  'credential_unavailable',
] as const satisfies readonly AccountStatus[]

/** 可以持久化到凭据记录的状态；checking/refreshing/credential_unavailable 是运行时推导值。 */
export const PERSISTED_ACCOUNT_STATUSES = [
  'ready',
  'reauth_required',
  'temporarily_unavailable',
] as const

/** 可持久化的账号状态。 */
export type PersistedAccountStatus = (typeof PERSISTED_ACCOUNT_STATUSES)[number]

/** 账号列表/当前账号的 Client DTO；只有六个非秘密字段。 */
export interface AccountSummary {
  /** 账号库生成的稳定小写 ID。 */
  readonly id: string
  /** 用户可见显示名；不含秘密。 */
  readonly displayName: string
  /** 账号所属精确渠道。 */
  readonly channelId: ChannelId
  /** 端点标签（固定域或记录内的安全标签），不是运行时实际 host。 */
  readonly endpointLabel: string
  /** 账号状态；损坏记录为 credential_unavailable。 */
  readonly status: AccountStatus
  /** 脱敏账号标识；不包含完整邮箱或厂商原始 ID。 */
  readonly maskedIdentifier: string
}

/** 删除账号后的列表与当前账号快照。 */
export interface AccountCollection {
  readonly accounts: readonly AccountSummary[]
  readonly current: AccountSummary | null
}

/** 清除全部账号数据的结果；只报告删除数量，不含任何账号内容。 */
export interface ClearAccountsResult {
  readonly cleared: number
}

/** 账号管理 RPC 的精确方法名。 */
export const ACCOUNT_RPC_METHODS = [
  'accounts.list',
  'accounts.current',
  'accounts.setCurrent',
  'accounts.delete',
  'accounts.test',
  'accounts.clearAll',
] as const

/** 账号管理 RPC 方法名。 */
export type AccountRpcMethod = (typeof ACCOUNT_RPC_METHODS)[number]

/** 每个账号 RPC 方法接受的内部 payload。 */
export interface AccountRpcPayloads {
  'accounts.list': { readonly channel: ChannelId }
  'accounts.current': { readonly channel: ChannelId }
  'accounts.setCurrent': {
    readonly channel: ChannelId
    readonly accountId: string | null
  }
  'accounts.delete': {
    readonly channel: ChannelId
    readonly accountId: string
    readonly replacementAccountId?: string | null
  }
  'accounts.test': {
    readonly channel: ChannelId
    readonly accountId: string
  }
  'accounts.clearAll': Record<string, never>
}

/** 账号 RPC payload 校验失败；RPC 层映射为 `accounts/invalid`。 */
export class AccountRpcValidationError extends Error {
  readonly code = 'accounts/invalid'

  constructor(message: string) {
    super(message)
    this.name = 'AccountRpcValidationError'
  }
}

/** 精确校验账号 RPC 方法名。 */
export function isAccountRpcMethod(value: unknown): value is AccountRpcMethod {
  return typeof value === 'string' && (ACCOUNT_RPC_METHODS as readonly string[]).includes(value)
}

/** 判断可持久化状态。 */
export function isPersistedAccountStatus(value: unknown): value is PersistedAccountStatus {
  return typeof value === 'string'
    && (PERSISTED_ACCOUNT_STATUSES as readonly string[]).includes(value)
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
      throw new AccountRpcValidationError(`${context} 不接受未声明的字段`)
    }
  }
}

/** 校验 channel 字段存在且是四个稳定渠道之一。 */
function requireChannel(record: Record<string, unknown>, context: string): ChannelId {
  if (!Object.hasOwn(record, 'channel') || !isChannelId(record.channel)) {
    throw new AccountRpcValidationError(`${context} 缺少合法 channel`)
  }
  return record.channel
}

/** 校验必填账号 ID 是稳定小写 slug。 */
function requireAccountId(value: unknown, context: string): string {
  if (!isStableChannelAccountId(value)) {
    throw new AccountRpcValidationError(`${context} 的 accountId 必须是稳定小写 ID`)
  }
  return value
}

/**
 * 严格校验账号 RPC payload；未知键、缺失键和错误类型都拒绝。
 *
 * 错误消息固定且不回显输入值，避免把恶意 payload 原文带进 RPC 错误。
 */
export function assertAccountRpcPayload<M extends AccountRpcMethod>(
  method: M,
  payload: unknown,
): asserts payload is AccountRpcPayloads[M] {
  if (!isRecord(payload)) {
    throw new AccountRpcValidationError(`账号 RPC ${method} 的 payload 必须是普通对象`)
  }
  switch (method) {
    case 'accounts.list':
    case 'accounts.current':
      rejectUnknownKeys(payload, ['channel'], method)
      requireChannel(payload, method)
      return
    case 'accounts.setCurrent':
      rejectUnknownKeys(payload, ['channel', 'accountId'], method)
      requireChannel(payload, method)
      if (!Object.hasOwn(payload, 'accountId')) {
        throw new AccountRpcValidationError('accounts.setCurrent 缺少 accountId')
      }
      if (payload.accountId !== null && !isStableChannelAccountId(payload.accountId)) {
        throw new AccountRpcValidationError('accounts.setCurrent 的 accountId 非法')
      }
      return
    case 'accounts.delete':
      rejectUnknownKeys(payload, ['channel', 'accountId', 'replacementAccountId'], method)
      requireChannel(payload, method)
      if (!Object.hasOwn(payload, 'accountId')) {
        throw new AccountRpcValidationError('accounts.delete 缺少 accountId')
      }
      requireAccountId(payload.accountId, 'accounts.delete')
      if (Object.hasOwn(payload, 'replacementAccountId')) {
        const replacement = payload.replacementAccountId
        if (replacement !== null && !isStableChannelAccountId(replacement)) {
          throw new AccountRpcValidationError('accounts.delete 的 replacementAccountId 非法')
        }
      }
      return
    case 'accounts.test':
      rejectUnknownKeys(payload, ['channel', 'accountId'], method)
      requireChannel(payload, method)
      if (!Object.hasOwn(payload, 'accountId')) {
        throw new AccountRpcValidationError('accounts.test 缺少 accountId')
      }
      requireAccountId(payload.accountId, 'accounts.test')
      return
    case 'accounts.clearAll':
      if (Object.keys(payload).length !== 0) {
        throw new AccountRpcValidationError('accounts.clearAll 不接受 payload 字段')
      }
      return
    default:
      throw new AccountRpcValidationError('未知账号 RPC 方法')
  }
}
