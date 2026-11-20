/**
 * 单次 tool invocation 绑定的真实搜索 drivers。
 *
 * activation 只创建一个 QoderEndpointPolicy；每次 bind 冻结 channel/accountId/
 * endpointPreference/selectionGeneration。每个 searchOnce、Qoder 每个 host 都独立
 * 调用 runWithAuthRetry，retry callback 的精确 credential 直接进入本次 HTTP。
 */
import type { ChannelId, QoderEndpointPreference } from '../../shared/channels.ts'
import type { SearchDriver, SearchDriverResult, MockSearchSource } from '../drivers/mock-driver.ts'
import { ChannelSearchError } from '../search/errors.ts'
import { BuddyAuthFlow } from '../channels/buddy/auth.ts'
import { WorkbuddyAuthFlow } from '../channels/workbuddy/auth.ts'
import { QoderInternationalAuthFlow } from '../channels/qoder/auth.ts'
import { QoderCnAuthFlow } from '../channels/qodercn/auth.ts'
import { BUDDY_SEARCH_HOST, BUDDY_SEARCH_USER_AGENT } from '../channels/buddy/driver.ts'
import { WORKBUDDY_SEARCH_HOST, WORKBUDDY_SEARCH_USER_AGENT } from '../channels/workbuddy/driver.ts'
import { QODERCN_SEARCH_HOST, QODERCN_SEARCH_PATH } from '../channels/qodercn/driver.ts'
import { QODER_INTERNATIONAL_SEARCH_PATH, toQoderChannelError } from '../channels/qoder/driver.ts'
import {
  QoderEndpointPolicy,
  type QoderEndpointObservation,
  type QoderInternationalHost,
} from '../channels/qoder/endpoint-policy.ts'
import { postTencentSearch, toTencentChannelSearchError } from '../channels/tencent/protocol.ts'
import {
  postQoderSearch,
  QoderSearchProtocolError,
  toQoderChannelSearchError,
  type QoderSigningCredential,
} from '../channels/qoder/protocol.ts'
import { QoderSigner } from '../channels/qoder/signer.ts'

export interface InvocationSelection {
  readonly channel: ChannelId
  readonly accountId: string | null
  readonly endpointPreference: QoderEndpointPreference
  readonly selectionGeneration: number
}

export interface InvocationAuthFlows {
  readonly buddy: BuddyAuthFlow
  readonly workbuddy: WorkbuddyAuthFlow
  readonly qoder: QoderInternationalAuthFlow
  readonly qodercn: QoderCnAuthFlow
}

export interface InvocationDriverFactoryDeps {
  readonly flows: InvocationAuthFlows
  readonly fetcher?: typeof fetch
  readonly readLastSuccessfulHost?: () => QoderInternationalHost | null
    | Promise<QoderInternationalHost | null>
  readonly writeLastSuccessfulHost?: (
    host: QoderInternationalHost,
    signal: AbortSignal,
    context?: InvocationSelection,
  ) => Promise<'written' | 'stale' | void>
  readonly onObservation?: (
    observation: QoderEndpointObservation,
    context: InvocationSelection,
  ) => void
}

export interface InvocationDriverFactory {
  bind(selection: InvocationSelection): SearchDriver
}

export function createInvocationDriverFactory(
  deps: InvocationDriverFactoryDeps,
): InvocationDriverFactory {
  const policy = new QoderEndpointPolicy({
    ...deps.readLastSuccessfulHost === undefined
      ? {}
      : { readLastSuccessfulHost: deps.readLastSuccessfulHost },
  })
  return {
    bind(selection: InvocationSelection): SearchDriver {
      return {
        async searchOnce(query, maxResults, signal): Promise<SearchDriverResult> {
          if (selection.accountId === null || selection.accountId.trim().length === 0) {
            throw new ChannelSearchError('NO_ACCOUNT', selection.channel, 'no current account for this invocation')
          }
          const accountId = selection.accountId
          switch (selection.channel) {
            case 'buddy':
              return await searchTencent('buddy', accountId, query, maxResults, signal, deps)
            case 'workbuddy':
              return await searchTencent('workbuddy', accountId, query, maxResults, signal, deps)
            case 'qodercn':
              return await searchQoderCn(accountId, query, signal, deps)
            case 'qoder':
              return await searchQoderInternational(accountId, query, signal, deps, policy, selection)
          }
        },
      }
    },
  }
}

async function searchTencent(
  channel: 'buddy' | 'workbuddy',
  accountId: string,
  query: string,
  maxResults: number,
  signal: AbortSignal,
  deps: InvocationDriverFactoryDeps,
): Promise<SearchDriverResult> {
  const flow = channel === 'buddy' ? deps.flows.buddy : deps.flows.workbuddy
  try {
    const sources = await flow.runWithAuthRetry(accountId, async (credential, retrySignal) => {
      try {
        return await postTencentSearch({
          host: channel === 'buddy' ? BUDDY_SEARCH_HOST : WORKBUDDY_SEARCH_HOST,
          accessToken: credential.accessToken,
          query,
          maxResults,
          signal: retrySignal,
          headers: {
            'User-Agent': channel === 'buddy' ? BUDDY_SEARCH_USER_AGENT : WORKBUDDY_SEARCH_USER_AGENT,
          },
          ...deps.fetcher === undefined ? {} : { fetcher: deps.fetcher },
        })
      } catch (error) {
        // retry 判定只信精确 ChannelSearchError + HTTP 401；转换发生在 attempt 内。
        throw toTencentChannelSearchError(error, channel)
      }
    }, signal)
    return { sources, truncated: false }
  } catch (error) {
    throw toTencentChannelSearchError(error, channel)
  }
}

async function searchQoderCn(
  accountId: string,
  query: string,
  signal: AbortSignal,
  deps: InvocationDriverFactoryDeps,
): Promise<SearchDriverResult> {
  try {
    const sources = await deps.flows.qodercn.runWithAuthRetry(
      accountId,
      async (credential, retrySignal) => {
        try {
          return await signAndPost({
            host: QODERCN_SEARCH_HOST,
            path: QODERCN_SEARCH_PATH,
            query,
            credential: credential.credential,
            signal: retrySignal,
            fetcher: deps.fetcher,
          })
        } catch (error) {
          throw toQoderChannelError(error, 'qodercn')
        }
      },
      signal,
    )
    return { sources, truncated: false }
  } catch (error) {
    throw toQoderChannelError(error, 'qodercn')
  }
}

async function searchQoderInternational(
  accountId: string,
  query: string,
  signal: AbortSignal,
  deps: InvocationDriverFactoryDeps,
  policy: QoderEndpointPolicy,
  selection: InvocationSelection,
): Promise<SearchDriverResult> {
  try {
    const sources = await policy.execute({
      preference: selection.endpointPreference,
      accountKey: accountId,
      operation: async ({ host }) => {
        // 每个 host 都有自己的 401→refresh→同 host retry；绝不包整个 policy.execute。
        return await deps.flows.qoder.runWithAuthRetry(
          accountId,
          async (credential, retrySignal) => {
            try {
              return await signAndPost({
                host,
                path: QODER_INTERNATIONAL_SEARCH_PATH,
                query,
                credential: credential.credential,
                signal: retrySignal,
                fetcher: deps.fetcher,
              })
            } catch (error) {
              if (error instanceof QoderSearchProtocolError && error.status === 401) {
                throw toQoderChannelSearchError(error, 'qoder')
              }
              // 其他错误保留协议 kind/status，供 policy 判断连接/timeout/5xx 换域。
              throw error
            }
          },
          signal,
        )
      },
      ...deps.writeLastSuccessfulHost === undefined ? {} : {
        writeLastSuccessfulHost: async (host, writeSignal) => {
          await deps.writeLastSuccessfulHost!(host, writeSignal, selection)
        },
      },
      signal,
      onObservation: (observation) => {
        deps.onObservation?.(observation, selection)
      },
    })
    return { sources, truncated: false }
  } catch (error) {
    throw toQoderChannelError(error)
  }
}

async function signAndPost(input: {
  readonly host: QoderInternationalHost | typeof QODERCN_SEARCH_HOST
  readonly path: string
  readonly query: string
  readonly credential: QoderSigningCredential
  readonly signal: AbortSignal
  readonly fetcher?: typeof fetch
}): Promise<readonly MockSearchSource[]> {
  const signer = new QoderSigner()
  try {
    return await postQoderSearch({
      host: input.host,
      path: input.path,
      query: input.query,
      credential: input.credential,
      signer,
      signal: input.signal,
      ...input.fetcher === undefined ? {} : { fetcher: input.fetcher },
    })
  } finally {
    try { signer.dispose() } catch { /* 不覆盖原始搜索结果 */ }
  }
}
