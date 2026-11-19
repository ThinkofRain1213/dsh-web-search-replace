/**
 * 账号域错误。
 *
 * 所有消息都是固定模板，不携带凭据 payload、厂商原始身份、底层存储异常原文
 * 或 cause；RPC 层直接把 `code` 映射为稳定错误码。
 */

/** 账号域稳定错误码。 */
export type AccountErrorCode =
  | 'accounts/invalid'
  | 'accounts/not-found'
  | 'accounts/conflict'
  | 'accounts/unavailable'
  | 'accounts/cancelled'
  | 'accounts/storage-failed'

/** 账号域错误；`cause` 永远不设置，避免秘密沿错误链泄漏。 */
export class AccountError extends Error {
  override readonly name = 'AccountError'

  constructor(
    readonly code: AccountErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** 非法渠道/账号 ID 等请求错误。 */
export function accountInvalid(): AccountError {
  return new AccountError('accounts/invalid', '账号请求包含非法渠道或账号 ID')
}

/** 精确渠道下不存在指定账号。 */
export function accountNotFound(): AccountError {
  return new AccountError('accounts/not-found', '该渠道下不存在指定账号')
}

/** 账号记录存在但不可用（损坏、跨渠道或凭据不完整）。 */
export function accountUnavailable(): AccountError {
  return new AccountError('accounts/unavailable', '账号凭据记录不可用，请重新登录')
}

/** 凭据存储或普通配置写入失败。 */
export function accountStorageFailed(): AccountError {
  return new AccountError('accounts/storage-failed', '账号操作未能写入配置或凭据存储')
}

/** 取消信号在持久化提交边界生效；调用方应把本次操作视为已取消。 */
export function accountCancelled(): AccountError {
  return new AccountError('accounts/cancelled', '账号操作已取消')
}

/** 账号记录 key 与已有未知/跨渠道数据冲突，拒绝覆盖。 */
export function accountConflict(): AccountError {
  return new AccountError('accounts/conflict', '账号记录地址已被其他数据占用')
}
