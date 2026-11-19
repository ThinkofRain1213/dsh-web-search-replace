/**
 * CodeBuddy 授权 RPC 的 Host 分派。
 *
 * 传输/信封由 `src/host/rpc.ts` 负责；这里只做严格的共享 payload 校验并把
 * 调用映射到 {@link BuddyAuthFlow}。成功结果只含 `AuthFlowStatus` 或
 * `AccountSummary`，绝不返回 token、refreshToken 或上游原文。
 *
 * 本文件不注册根路由、不创建账号服务，也不在构造函数自动启动授权；根组合
 * 由 Task 15 负责把 `BuddyAuthFlow` 传给现有 management RPC。
 */
import type { AccountSummary } from '../../../shared/accounts.ts'
import {
  assertAuthRpcPayload,
  isAccountSummary,
  isAuthFlowStatus,
  type AuthFlowStatus,
  type AuthRpcMethod,
  type AuthRpcPayloads,
} from '../../../shared/auth.ts'
import { BuddyAuthError, type BuddyAuthFlow } from './auth.ts'

/** 结果形状自检失败时的固定内部错误。 */
function internalResultError(): BuddyAuthError {
  return new BuddyAuthError('auth/internal', 'CodeBuddy 授权内部错误')
}

/**
 * 执行一次 CodeBuddy 授权 RPC。
 *
 * 除共享 payload 校验外，返回前还会校验结果只含共享契约允许的字段；任何
 * 意外形状（例如误带 token 的对象）都以固定 `auth/internal` 失败，不泄漏。
 *
 * @throws {AuthRpcValidationError} payload 非法时（RPC 映射为 auth/invalid）。
 * @throws {BuddyAuthError} 授权域失败时（固定 code，无 cause）。
 */
export async function dispatchBuddyAuthRpc(
  flow: BuddyAuthFlow,
  method: AuthRpcMethod,
  payload: unknown,
): Promise<AuthFlowStatus | AccountSummary> {
  assertAuthRpcPayload(method, payload)
  switch (method) {
    case 'auth.start': {
      const request = payload as AuthRpcPayloads['auth.start']
      const status = await flow.start(
        request.accountId === undefined ? {} : { accountId: request.accountId },
      )
      if (!isAuthFlowStatus(status)) throw internalResultError()
      return status
    }
    case 'auth.cancel': {
      const request = payload as AuthRpcPayloads['auth.cancel']
      const status = await flow.cancel(request.flowId)
      if (!isAuthFlowStatus(status)) throw internalResultError()
      return status
    }
    case 'auth.status': {
      const request = payload as AuthRpcPayloads['auth.status']
      const status = await flow.status(request.flowId)
      if (!isAuthFlowStatus(status)) throw internalResultError()
      return status
    }
    case 'auth.refresh': {
      const request = payload as AuthRpcPayloads['auth.refresh']
      const summary = await flow.refresh(request.accountId)
      if (!isAccountSummary(summary)) throw internalResultError()
      return summary
    }
  }
}
