/**
 * 腾讯系授权 RPC 的 Host 分派。
 *
 * 共享 payload 校验、精确 channel 断言与结果自检由
 * `src/host/channels/auth-rpc.ts` 的通用 dispatcher 提供；本文件只保留腾讯系
 * 的稳定导出名，行为与 Task 10 一致。
 *
 * 本文件不注册根路由、不创建账号服务，也不在构造函数自动启动授权；根组合
 * 由 Task 15 负责把各产品 flow 按 channel 传给 management RPC。
 */
import type { AccountSummary } from '../../../shared/accounts.ts'
import type {
  AuthChannel,
  AuthFlowError,
  AuthFlowPort,
  AuthFlowStatus,
  AuthRpcMethod,
} from '../../../shared/auth.ts'
import { dispatchChannelAuthRpc } from '../auth-rpc.ts'

/**
 * 执行一次腾讯系授权 RPC。
 *
 * @param flow 已按 channel 选定的产品 flow。
 * @param channel 该 flow 固定归属的渠道。
 * @param method 共享授权方法名。
 * @param payload 原始 payload；内部做严格校验。
 * @param internalError 产品固定内部错误工厂（不含 cause）。
 *
 * @throws {AuthRpcValidationError} payload 非法或渠道不匹配时（RPC 映射为 auth/invalid）。
 * @throws {AuthFlowError} 产品授权域失败时（固定 code，无 cause）。
 */
export async function dispatchTencentAuthRpc(
  flow: AuthFlowPort,
  channel: AuthChannel,
  method: AuthRpcMethod,
  payload: unknown,
  internalError: () => AuthFlowError,
): Promise<AuthFlowStatus | AccountSummary> {
  return await dispatchChannelAuthRpc(flow, channel, method, payload, internalError)
}
