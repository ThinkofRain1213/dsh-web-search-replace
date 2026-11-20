/** 登录保存前的真实 Search capability probes 与整体 deadline 合成。 */
import type { QoderEndpointPreference } from '../../shared/channels.ts'
import type { TencentCapabilityCredential } from './tencent/product-auth-flow.ts'
import type { QoderCapabilityCredential } from './qoder/auth.ts'
import { BUDDY_SEARCH_HOST, BUDDY_SEARCH_USER_AGENT } from './buddy/driver.ts'
import { WORKBUDDY_SEARCH_HOST, WORKBUDDY_SEARCH_USER_AGENT } from './workbuddy/driver.ts'
import { QODERCN_SEARCH_HOST, QODERCN_SEARCH_PATH } from './qodercn/driver.ts'
import { QODER_INTERNATIONAL_SEARCH_PATH } from './qoder/driver.ts'
import { QoderEndpointPolicy, type QoderInternationalHost } from './qoder/endpoint-policy.ts'
import { postTencentSearch } from './tencent/protocol.ts'
import { postQoderSearch, type QoderSigningCredential } from './qoder/protocol.ts'
import { QoderSigner } from './qoder/signer.ts'

export interface CapabilityVerifierDeps {
  readonly fetcher?: typeof fetch
  readonly getEndpointPreference?: () => QoderEndpointPreference
    | Promise<QoderEndpointPreference>
  readonly readLastSuccessfulHost?: (signal: AbortSignal) => QoderInternationalHost | null
    | Promise<QoderInternationalHost | null>
  /** 保留给根组合共享配置；probe rememberSuccess=false，绝不会调用。 */
  readonly writeLastSuccessfulHost?: (
    host: QoderInternationalHost,
    signal: AbortSignal,
  ) => Promise<'written' | 'stale' | void>
}

export interface ChannelCapabilityVerifiers {
  buddy(credential: TencentCapabilityCredential<'buddy'>, signal: AbortSignal): Promise<void>
  workbuddy(credential: TencentCapabilityCredential<'workbuddy'>, signal: AbortSignal): Promise<void>
  qoder(credential: QoderCapabilityCredential<'qoder'>, signal: AbortSignal): Promise<void>
  qodercn(credential: QoderCapabilityCredential<'qodercn'>, signal: AbortSignal): Promise<void>
}

export function createChannelCapabilityVerifiers(
  deps: CapabilityVerifierDeps,
): ChannelCapabilityVerifiers {
  return {
    buddy: async (credential, signal) => {
      await postTencentSearch({
        host: BUDDY_SEARCH_HOST,
        accessToken: credential.accessToken,
        query: 'capability probe',
        maxResults: 1,
        signal,
        headers: { 'User-Agent': BUDDY_SEARCH_USER_AGENT },
        ...deps.fetcher === undefined ? {} : { fetcher: deps.fetcher },
      })
    },
    workbuddy: async (credential, signal) => {
      await postTencentSearch({
        host: WORKBUDDY_SEARCH_HOST,
        accessToken: credential.accessToken,
        query: 'capability probe',
        maxResults: 1,
        signal,
        headers: { 'User-Agent': WORKBUDDY_SEARCH_USER_AGENT },
        ...deps.fetcher === undefined ? {} : { fetcher: deps.fetcher },
      })
    },
    qodercn: async (credential, signal) => {
      await postWithSigner({
        host: QODERCN_SEARCH_HOST,
        path: QODERCN_SEARCH_PATH,
        credential: credential.credential,
        signal,
        fetcher: deps.fetcher,
      })
    },
    qoder: async (credential, signal) => {
      const policy = new QoderEndpointPolicy({
        ...deps.readLastSuccessfulHost === undefined
          ? {}
          : { readLastSuccessfulHost: deps.readLastSuccessfulHost },
        ...deps.writeLastSuccessfulHost === undefined
          ? {}
          : { writeLastSuccessfulHost: deps.writeLastSuccessfulHost },
      })
      await policy.execute({
        preference: await deps.getEndpointPreference?.() ?? 'auto',
        // probe 专用身份；R43 下也不写全局路由、不发布 actualHost。
        accountKey: 'capability-probe',
        rememberSuccess: false,
        operation: async ({ host }) => await postWithSigner({
          host,
          path: QODER_INTERNATIONAL_SEARCH_PATH,
          credential: credential.credential,
          signal,
          fetcher: deps.fetcher,
        }),
        signal,
      })
    },
  }
}

async function postWithSigner(input: {
  readonly host: QoderInternationalHost | typeof QODERCN_SEARCH_HOST
  readonly path: string
  readonly credential: QoderSigningCredential
  readonly signal: AbortSignal
  readonly fetcher?: typeof fetch
}): Promise<void> {
  const signer = new QoderSigner()
  try {
    await postQoderSearch({
      host: input.host,
      path: input.path,
      query: 'capability probe',
      credential: input.credential,
      signer,
      signal: input.signal,
      ...input.fetcher === undefined ? {} : { fetcher: input.fetcher },
    })
  } finally {
    try { signer.dispose() } catch { /* 不覆盖 probe 原始结论 */ }
  }
}

/**
 * 将 flow controller 与剩余整体 deadline timer 合成；无论成功/失败都清 timer，
 * 并等待 verifier 真正 settle。probe 只检查墙钟而不监听 signal 的伪闭环不成立。
 */
export async function runCapabilityVerifierWithDeadline<T>(
  verify: (signal: AbortSignal) => Promise<T>,
  flowSignal: AbortSignal,
  deadline: number,
  now: () => number = Date.now,
): Promise<T> {
  const timeout = new AbortController()
  const remaining = Math.max(0, deadline - now())
  const timer = setTimeout(() => {
    timeout.abort(new DOMException('capability probe deadline elapsed', 'TimeoutError'))
  }, remaining)
  const signal = AbortSignal.any([flowSignal, timeout.signal])
  try {
    const result = await verify(signal)
    if (signal.aborted) throw signal.reason
    return result
  } finally {
    clearTimeout(timer)
  }
}
