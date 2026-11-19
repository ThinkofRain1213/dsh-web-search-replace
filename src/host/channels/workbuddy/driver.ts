import type { ChannelId } from '../../../shared/channels.ts'
import type { SearchDriver, SearchDriverResult } from '../../drivers/mock-driver.ts'
import { ChannelSearchError } from '../../search/errors.ts'
import { toChannelAccountSearchError } from '../../accounts/resolver-errors.ts'
import {
  postTencentSearch,
  toTencentChannelSearchError,
} from '../tencent/protocol.ts'

/** 本驱动固定归属的渠道；账号与错误都只使用这个值。 */
export const WORKBUDDY_CHANNEL = 'workbuddy' as const satisfies ChannelId

/** 只允许 WorkBuddy 的固定搜索域。 */
export const WORKBUDDY_SEARCH_HOST = 'www.workbuddy.ai'

/** WorkBuddy 产品请求头；与产品配置一致，不按模型或账号切换。 */
export const WORKBUDDY_SEARCH_USER_AGENT = 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2'

/**
 * WorkBuddy 的账号快照。
 *
 * `channelId` 是编译期精确渠道；运行期仍会校验，防止注入的解析器返回其他
 * 渠道（含同协议族 CodeBuddy）的快照。
 */
export interface WorkbuddyAccountCredential {
  readonly channelId: 'workbuddy'
  readonly accountId: string
  readonly accessToken: string
}

/** WorkBuddy 驱动只接受本渠道账号解析与可选测试 fetcher。 */
export interface WorkbuddyDriverDeps {
  /** 只解析 WorkBuddy 自己的账号快照；空值表示无可用账号。 */
  readonly resolveCredential: () => WorkbuddyAccountCredential | null | undefined
    | Promise<WorkbuddyAccountCredential | null | undefined>
  /** 测试注入；生产默认使用全局 fetch。 */
  readonly fetcher?: typeof fetch
}

/** 构造无状态 WorkBuddy 搜索驱动；不读任何其他渠道的账号。 */
export function createWorkbuddyDriver(deps: WorkbuddyDriverDeps): SearchDriver {
  return {
    async searchOnce(query, maxResults, signal): Promise<SearchDriverResult> {
      const accessToken = await requireAccessToken(deps)
      try {
        const sources = await postTencentSearch({
          host: WORKBUDDY_SEARCH_HOST,
          accessToken,
          query,
          maxResults,
          signal,
          headers: { 'User-Agent': WORKBUDDY_SEARCH_USER_AGENT },
          ...deps.fetcher === undefined ? {} : { fetcher: deps.fetcher },
        })
        return { sources, truncated: false }
      } catch (error) {
        throw toTencentChannelSearchError(error, WORKBUDDY_CHANNEL)
      }
    },
  }
}

/**
 * 无账号必须在任何 fetch 之前失败；其他渠道快照也 fail-closed。
 *
 * 解析器异常保留安全结构化 code、重绑 workbuddy，并使用固定消息丢弃底层原文/cause。
 */
async function requireAccessToken(deps: WorkbuddyDriverDeps): Promise<string> {
  let credential: WorkbuddyAccountCredential | null | undefined
  try {
    credential = await deps.resolveCredential()
  } catch (error) {
    throw toChannelAccountSearchError(
      error,
      WORKBUDDY_CHANNEL,
      'WorkBuddy search could not read the account credential',
    )
  }
  if (credential === null || credential === undefined) throw noAccount()
  if (credential.channelId !== WORKBUDDY_CHANNEL) throw foreignAccount()
  const token = typeof credential.accessToken === 'string' ? credential.accessToken.trim() : ''
  if (token.length === 0) throw noAccount()
  return token
}

function noAccount(): ChannelSearchError {
  return new ChannelSearchError(
    'NO_ACCOUNT',
    WORKBUDDY_CHANNEL,
    'WorkBuddy search has no usable account; select a WorkBuddy account first',
  )
}

function foreignAccount(): ChannelSearchError {
  return new ChannelSearchError(
    'SEARCH_FAILED',
    WORKBUDDY_CHANNEL,
    'WorkBuddy search received an account from another channel',
  )
}
