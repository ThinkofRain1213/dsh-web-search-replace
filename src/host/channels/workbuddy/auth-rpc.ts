/**
 * WorkBuddy 授权 RPC 的 Host 分派。
 *
 * 共享 payload 校验、精确 channel 断言与结果自检由
 * `src/host/channels/tencent/auth-rpc.ts` 提供；本文件只固定
 * `channel=workbuddy` 与 WorkBuddy 的固定错误文案。成功结果只含
 * `AuthFlowStatus` 或 `AccountSummary`，绝不返回 token、refreshToken 或上游
 * 原文。
 *
 * 本文件不注册根路由、不创建账号服务，也不在构造函数自动启动授权；根组合
 * 由 Task 15 负责把 `WorkbuddyAuthFlow` 按 channel 传给 management RPC。
 */
import type { AccountSummary } from '../../../shared/accounts.ts'
import {
  WORKBUDDY_AUTH_CHANNEL,
  type AuthFlowStatus,
  type AuthRpcMethod,
} from '../../../shared/auth.ts'
import { dispatchTencentAuthRpc } from '../tencent/auth-rpc.ts'
import { WorkbuddyAuthError, type WorkbuddyAuthFlow } from './auth.ts'

/** 结果形状自检失败时的固定内部错误。 */
function internalResultError(): WorkbuddyAuthError {
  return new WorkbuddyAuthError('auth/internal', 'WorkBuddy 授权内部错误')
}

/**
 * 执行一次 WorkBuddy 授权 RPC。
 *
 * 除共享 payload 校验外，还会在任何 flow 调用前拒绝非 workbuddy 渠道，并在
 * 返回前校验结果只含共享契约允许的字段；任何意外形状（例如误带 token 的对
 * 象）都以固定 `auth/internal` 失败，不泄漏。
 *
 * @throws {AuthRpcValidationError} payload 非法或渠道不匹配时（RPC 映射为 auth/invalid）。
 * @throws {WorkbuddyAuthError} 授权域失败时（固定 code，无 cause）。
 */
export async function dispatchWorkbuddyAuthRpc(
  flow: WorkbuddyAuthFlow,
  method: AuthRpcMethod,
  payload: unknown,
): Promise<AuthFlowStatus | AccountSummary> {
  return await dispatchTencentAuthRpc(
    flow,
    WORKBUDDY_AUTH_CHANNEL,
    method,
    payload,
    internalResultError,
  )
}
