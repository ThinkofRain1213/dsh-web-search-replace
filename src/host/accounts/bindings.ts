/**
 * 四渠道独立绑定适配器。
 *
 * 每个函数只把自己的稳定渠道 ID 传给
 * `resolveCurrentCredential(channel)`，再把服务返回的**同一条**账号快照
 * （accountId + 凭据）映射为驱动自己的快照类型。这里没有协议族选择器、
 * 余额选号、自动轮换或官方/另一渠道回退；渠道不匹配的快照一律返回 null，
 * 由驱动在 fetch/WASM 之前以 NO_ACCOUNT 失败。
 *
 * Qoder 国际版绑定由 Host 根组合提供本机全局 `lastSuccessfulHost`：所有国际版
 * 账号共用、换账号不清空，fixed center/api2 不读取；不做 networkExitKey 或 OS 探测。
 */
import type { ChannelId, QoderEndpointPreference } from '../../shared/channels.ts'
import type { SearchDriver } from '../drivers/mock-driver.ts'
import {
  createBuddyDriver,
  type BuddyAccountCredential,
} from '../channels/buddy/driver.ts'
import {
  createQoderInternationalDriver,
  type QoderInternationalAccount,
} from '../channels/qoder/driver.ts'
import type { QoderEndpointObservation } from '../channels/qoder/endpoint-policy.ts'
import {
  createQoderCnDriver,
  type QoderCnAccountCredential,
} from '../channels/qodercn/driver.ts'
import {
  createWorkbuddyDriver,
  type WorkbuddyAccountCredential,
} from '../channels/workbuddy/driver.ts'
import type { ResolvedChannelCredential } from './service.ts'

/** 账号服务的最小读接口；绑定层不依赖其他账号能力。 */
export interface CurrentChannelCredentialResolver {
  resolveCurrentCredential(channel: ChannelId): Promise<ResolvedChannelCredential | null>
}

/** 绑定层通用测试注入。 */
export interface ChannelBindingOptions {
  /** 测试注入；生产默认使用全局 fetch。 */
  readonly fetcher?: typeof fetch
}

/** Qoder 国际版绑定依赖；R43 使用 Host 管理的唯一全局路由值。 */
export interface QoderInternationalBindingOptions extends ChannelBindingOptions {
  readonly readLastSuccessfulHost?: () => 'center.qoder.sh' | 'api2.qoder.sh' | null
    | Promise<'center.qoder.sh' | 'api2.qoder.sh' | null>
  readonly writeLastSuccessfulHost?: (
    host: 'center.qoder.sh' | 'api2.qoder.sh',
    signal: AbortSignal,
  ) => Promise<'written' | 'stale' | void>
  /** 端点偏好；每次搜索解析一次。 */
  readonly resolveEndpointPreference: () => QoderEndpointPreference
    | Promise<QoderEndpointPreference>
  /** 脱敏观察钩子。 */
  readonly onObservation?: (observation: QoderEndpointObservation) => void
}

/** 构造只解析 buddy 账号的 CodeBuddy 驱动。 */
export function createBuddySearchBinding(
  accounts: CurrentChannelCredentialResolver,
  options: ChannelBindingOptions = {},
): SearchDriver {
  return createBuddyDriver({
    resolveCredential: async () => toBuddyCredential(
      await accounts.resolveCurrentCredential('buddy'),
    ),
    ...options.fetcher === undefined ? {} : { fetcher: options.fetcher },
  })
}

/** 构造只解析 workbuddy 账号的 WorkBuddy 驱动。 */
export function createWorkbuddySearchBinding(
  accounts: CurrentChannelCredentialResolver,
  options: ChannelBindingOptions = {},
): SearchDriver {
  return createWorkbuddyDriver({
    resolveCredential: async () => toWorkbuddyCredential(
      await accounts.resolveCurrentCredential('workbuddy'),
    ),
    ...options.fetcher === undefined ? {} : { fetcher: options.fetcher },
  })
}

/** 构造只解析 qoder 账号的 Qoder 国际版驱动；策略/驱动实例在绑定时创建一次。 */
export function createQoderInternationalSearchBinding(
  accounts: CurrentChannelCredentialResolver,
  options: QoderInternationalBindingOptions,
): SearchDriver {
  return createQoderInternationalDriver({
    resolveAccount: async () => toQoderAccount(
      await accounts.resolveCurrentCredential('qoder'),
    ),
    resolveEndpointPreference: options.resolveEndpointPreference,
    ...options.readLastSuccessfulHost === undefined
      ? {}
      : { readLastSuccessfulHost: options.readLastSuccessfulHost },
    ...options.writeLastSuccessfulHost === undefined
      ? {}
      : { writeLastSuccessfulHost: options.writeLastSuccessfulHost },
    ...options.fetcher === undefined ? {} : { fetcher: options.fetcher },
    ...options.onObservation === undefined ? {} : { onObservation: options.onObservation },
  })
}

/** 构造只解析 qodercn 账号的 Qoder 中国版驱动。 */
export function createQoderCnSearchBinding(
  accounts: CurrentChannelCredentialResolver,
  options: ChannelBindingOptions = {},
): SearchDriver {
  return createQoderCnDriver({
    resolveCredential: async () => toQoderCnAccount(
      await accounts.resolveCurrentCredential('qodercn'),
    ),
    ...options.fetcher === undefined ? {} : { fetcher: options.fetcher },
  })
}

/** 腾讯访问令牌快照 → CodeBuddy 快照；渠道不符返回 null。 */
function toBuddyCredential(
  resolved: ResolvedChannelCredential | null,
): BuddyAccountCredential | null {
  if (
    resolved === null
    || resolved.kind !== 'tencent-access-token'
    || resolved.channelId !== 'buddy'
  ) {
    return null
  }
  return {
    channelId: 'buddy',
    accountId: resolved.accountId,
    accessToken: resolved.accessToken,
  }
}

/** 腾讯访问令牌快照 → WorkBuddy 快照；渠道不符返回 null。 */
function toWorkbuddyCredential(
  resolved: ResolvedChannelCredential | null,
): WorkbuddyAccountCredential | null {
  if (
    resolved === null
    || resolved.kind !== 'tencent-access-token'
    || resolved.channelId !== 'workbuddy'
  ) {
    return null
  }
  return {
    channelId: 'workbuddy',
    accountId: resolved.accountId,
    accessToken: resolved.accessToken,
  }
}

/** Qoder 签名快照 → 国际版账号快照；渠道不符返回 null。 */
function toQoderAccount(
  resolved: ResolvedChannelCredential | null,
): QoderInternationalAccount | null {
  if (
    resolved === null
    || resolved.kind !== 'qoder-signing'
    || resolved.channelId !== 'qoder'
  ) {
    return null
  }
  return {
    channelId: 'qoder',
    accountId: resolved.accountId,
    credential: resolved.credential,
  }
}

/** Qoder 签名快照 → 中国版账号快照；渠道不符返回 null。 */
export { createInvocationDriverFactory } from './invocation.ts'
export { createChannelCapabilityVerifiers } from '../channels/capability.ts'
export type { CapabilityVerifierDeps, ChannelCapabilityVerifiers } from '../channels/capability.ts'
export type {
  InvocationAuthFlows,
  InvocationDriverFactory,
  InvocationDriverFactoryDeps,
  InvocationSelection,
} from './invocation.ts'

function toQoderCnAccount(
  resolved: ResolvedChannelCredential | null,
): QoderCnAccountCredential | null {
  if (
    resolved === null
    || resolved.kind !== 'qoder-signing'
    || resolved.channelId !== 'qodercn'
  ) {
    return null
  }
  return {
    channelId: 'qodercn',
    accountId: resolved.accountId,
    credential: resolved.credential,
  }
}
