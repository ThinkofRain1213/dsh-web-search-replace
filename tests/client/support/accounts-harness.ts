/**
 * Task 14 账号/授权 DOM 与控制器测试夹具。
 *
 * 只构造共享契约里的非秘密 DTO 和按方法路由的 RPC 响应；组件与控制器仍由
 * 产品代码执行。这里额外提供故意夹带跨渠道/额外字段的夹具，用于验证 Client
 * 只消费六字段投影且不会串用渠道。
 */
import type {
  AccountCollection,
  AccountSummary,
} from '../../../src/shared/accounts.ts'
import type { AuthChannel, AuthFlowStatus } from '../../../src/shared/auth.ts'
import type { ChannelId } from '../../../src/shared/channels.ts'
import type { RpcResponder } from './settings-harness.ts'

/** 四个渠道固定展示端点；qoder 的 auto 默认 center 只是首版策略，不是运行观测。 */
export const CHANNEL_ENDPOINT_LABELS: Readonly<Record<ChannelId, string>> = Object.freeze({
  buddy: 'copilot.tencent.com',
  workbuddy: 'www.workbuddy.ai',
  qoder: 'center.qoder.sh',
  qodercn: 'gateway.qoder.com.cn',
})

/** 一个带 Qoder `machine_id` 的取值范围受限的模拟授权 URL。 */
export const AUTH_URLS: Readonly<Record<AuthChannel, string>> = Object.freeze({
  buddy: 'https://www.codebuddy.cn/login?state=state-value',
  workbuddy: 'https://www.workbuddy.ai/auth?flow=flow-value',
  qoder:
    'https://qoder.com/device/selectAccounts?challenge=challenge-value'
    + '&challenge_method=S256&nonce=nonce-value&machine_id=machine-123&client_id=client-1',
  qodercn:
    'https://qoder.cn/device/selectAccounts?challenge=challenge-cn'
    + '&challenge_method=S256&nonce=nonce-cn&machine_id=machine-cn&client_id=client-cn',
})

/** Qoder 国际版授权 URL（保留旧别名，仅供既有 Qoder 断言）。 */
export const AUTH_URL = AUTH_URLS.qoder

/**
 * 构造一个精确六字段的 AccountSummary。
 * @param channel - 账号所属渠道。
 * @param id - 稳定账号 slug。
 * @param overrides - 需要偏离默认值的字段。
 * @returns 非秘密账号投影。
 */
export function accountSummary(
  channel: ChannelId,
  id: string,
  overrides: Partial<AccountSummary> = {},
): AccountSummary {
  return {
    id,
    displayName: `Account ${id}`,
    channelId: channel,
    endpointLabel: CHANNEL_ENDPOINT_LABELS[channel],
    status: 'ready',
    maskedIdentifier: `${id.slice(0, 1)}***@example.com`,
    ...overrides,
  }
}

/**
 * 构造 accounts.delete 的返回集合。
 * @param accounts - 删除后的账号列表。
 * @param current - 删除后的当前账号。
 * @returns 账号集合。
 */
export function accountCollection(
  accounts: readonly AccountSummary[],
  current: AccountSummary | null,
): AccountCollection {
  return { accounts, current }
}

/**
 * 构造一个七字段授权流程状态。
 * @param channel - 流程所属渠道。
 * @param overrides - 需要偏离默认值的字段。
 * @returns 脱敏授权状态。
 */
export function authStatus(
  channel: AuthChannel,
  overrides: Partial<AuthFlowStatus> = {},
): AuthFlowStatus {
  return {
    flowId: 'flow-1',
    channel,
    status: 'pending',
    authUrl: AUTH_URLS[channel],
    displayHint: '请在浏览器中完成授权',
    account: null,
    errorCode: null,
    ...overrides,
  }
}

/** 账号类 RPC 的按方法处理器。 */
export type AccountHandlers = Partial<Record<string, RpcResponder>>

/**
 * 把账号 RPC 方法路由到给定处理器；未声明的方法使用安全默认值。
 *
 * 默认 `accounts.list` 返回空列表、`accounts.current` 返回 null，便于 Task 13
 * 回归测试只关心设置 RPC 时不被账号读取打断；其他方法未声明时抛错，避免
 * 测试意外绕过授权/删除断言。
 *
 * @param handlers - 方法处理器。
 * @returns 一个 RPC 响应函数。
 */
export function routeAccounts(handlers: AccountHandlers): RpcResponder {
  return (call) => {
    const handler = handlers[call.method]
    if (handler !== undefined) return handler(call)
    if (call.method === 'accounts.list') return { ok: true, value: [] }
    if (call.method === 'accounts.current') return { ok: true, value: null }
    throw new Error(`测试未声明账号 RPC 响应：${call.method}`)
  }
}

/** 判断账号 RPC 方法名是否属于账号/授权域。 */
export function isAccountOrAuthMethod(method: string): boolean {
  return method.startsWith('accounts.') || method.startsWith('auth.')
}