/**
 * 授权 RPC 的通用 Host 分派。
 *
 * 传输/信封由 `src/host/rpc.ts` 负责；这里只做严格的共享 payload 校验、精确
 * 渠道断言，并把调用映射到产品 flow。成功结果只含 `AuthFlowStatus` 或
 * `AccountSummary`，绝不返回 token、refreshToken 或上游原文。
 *
 * 精确渠道断言发生在任何 flow 方法调用之前：即使上层误把 WorkBuddy payload
 * 交给 Buddy flow（或反之、或把 Qoder payload 交给腾讯 flow），也会在首次
 * 网络/账号工作前以 `auth/invalid` 拒绝。返回前再用
 * `isAuthFlowStatusForChannel` 做结果自检，防止错渠道或夹带秘密的对象离开 Host。
 *
 * 本文件不注册根路由、不创建账号服务，也不在构造函数自动启动授权；根组合
 * 由 Task 15 负责把各产品 flow 按 channel 传给 management RPC。
 */
import type { AccountSummary } from '../../shared/accounts.ts'
import {
  assertAuthRpcPayload,
  AUTH_CHANNELS,
  AuthRpcValidationError,
  isAccountSummary,
  isAuthFlowStatusForChannel,
  type AuthChannel,
  type AuthFlowError,
  type AuthFlowPort,
  type AuthFlowStatus,
  type AuthRpcMethod,
  type AuthRpcPayloads,
} from '../../shared/auth.ts'

/** 根组合专用：恰好四个渠道、key/channel 一致、同实例不得双注册。 */
export function createAuthFlowRegistry(
  flows: Readonly<Record<string, AuthFlowPort>>,
): Readonly<Record<AuthChannel, AuthFlowPort>> {
  const keys = Object.keys(flows)
  if (keys.length !== AUTH_CHANNELS.length
    || keys.some(key => !(AUTH_CHANNELS as readonly string[]).includes(key))) {
    throw new TypeError('auth flow registry must contain exactly the four channel keys')
  }
  const instances = new Set<AuthFlowPort>()
  const registry = {} as Record<AuthChannel, AuthFlowPort>
  for (const channel of AUTH_CHANNELS) {
    const flow = flows[channel]
    if (flow === undefined || flow.channel !== channel) {
      throw new TypeError(`auth flow registry channel mismatch for ${channel}`)
    }
    if (instances.has(flow)) {
      throw new TypeError('the same auth flow instance cannot be registered twice')
    }
    instances.add(flow)
    registry[channel] = flow
  }
  return Object.freeze(registry)
}

/**
 * 执行一次授权 RPC。
 *
 * @param flow 已按 channel 选定的产品 flow。
 * @param channel 该 flow 固定归属的渠道。
 * @param method 共享授权方法名。
 * @param payload 原始 payload；本函数内部做严格校验。
 * @param internalError 产品固定内部错误工厂（不含 cause）。
 *
 * @throws {AuthRpcValidationError} payload 非法或渠道不匹配时（RPC 映射为 auth/invalid）。
 * @throws {AuthFlowError} 产品授权域失败时（固定 code，无 cause）。
 */
export async function dispatchChannelAuthRpc(
  flow: AuthFlowPort,
  channel: AuthChannel,
  method: AuthRpcMethod,
  payload: unknown,
  internalError: () => AuthFlowError,
): Promise<AuthFlowStatus | AccountSummary> {
  assertAuthRpcPayload(method, payload)
  if (payload.channel !== channel || flow.channel !== channel) {
    throw new AuthRpcValidationError(`授权 RPC 只接受 channel=${channel}`)
  }
  switch (method) {
    case 'auth.start': {
      const request = payload as AuthRpcPayloads['auth.start']
      const status = await flow.start(
        request.accountId === undefined ? {} : { accountId: request.accountId },
      )
      if (!isAuthFlowStatusForChannel(status, channel)) throw internalError()
      return status
    }
    case 'auth.cancel': {
      const request = payload as AuthRpcPayloads['auth.cancel']
      const status = await flow.cancel(request.flowId)
      if (!isAuthFlowStatusForChannel(status, channel)) throw internalError()
      return status
    }
    case 'auth.status': {
      const request = payload as AuthRpcPayloads['auth.status']
      const status = await flow.status(request.flowId)
      if (!isAuthFlowStatusForChannel(status, channel)) throw internalError()
      return status
    }
    case 'auth.refresh': {
      const request = payload as AuthRpcPayloads['auth.refresh']
      const summary = await flow.refresh(request.accountId)
      if (!isAccountSummary(summary) || summary.channelId !== channel) throw internalError()
      return summary
    }
  }
}
