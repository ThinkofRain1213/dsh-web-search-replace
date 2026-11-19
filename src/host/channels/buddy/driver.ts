import type { ChannelId } from '../../../shared/channels.ts'
import type { SearchDriver, SearchDriverResult } from '../../drivers/mock-driver.ts'
import { ChannelSearchError } from '../../search/errors.ts'
import {
  postTencentSearch,
  toTencentChannelSearchError,
} from '../tencent/protocol.ts'

/** 本驱动固定归属的渠道；账号与错误都只使用这个值。 */
export const BUDDY_CHANNEL = 'buddy' as const satisfies ChannelId

/** 只允许 CodeBuddy 的固定搜索域。 */
export const BUDDY_SEARCH_HOST = 'copilot.tencent.com'

/** CodeBuddy 产品请求头；与产品配置一致，不按模型或账号切换。 */
export const BUDDY_SEARCH_USER_AGENT = 'CodeBuddyIDE/1.106.1'

/** CodeBuddy 驱动只接受本渠道账号解析与可选测试 fetcher。 */
export interface BuddyDriverDeps {
  /** 只解析 CodeBuddy 自己的访问令牌；空值表示无可用账号。 */
  readonly resolveAccessToken: () => string | null | undefined
    | Promise<string | null | undefined>
  /** 测试注入；生产默认使用全局 fetch。 */
  readonly fetcher?: typeof fetch
}

/** 构造无状态 CodeBuddy 搜索驱动；不读任何其他渠道的账号。 */
export function createBuddyDriver(deps: BuddyDriverDeps): SearchDriver {
  return {
    async searchOnce(query, maxResults, signal): Promise<SearchDriverResult> {
      const accessToken = await requireAccessToken(deps)
      try {
        const sources = await postTencentSearch({
          host: BUDDY_SEARCH_HOST,
          accessToken,
          query,
          maxResults,
          signal,
          headers: { 'User-Agent': BUDDY_SEARCH_USER_AGENT },
          ...deps.fetcher === undefined ? {} : { fetcher: deps.fetcher },
        })
        return { sources, truncated: false }
      } catch (error) {
        throw toTencentChannelSearchError(error, BUDDY_CHANNEL)
      }
    },
  }
}

/** 无 token 必须在任何 fetch 之前失败；账号解析异常也绑定到本渠道。 */
async function requireAccessToken(deps: BuddyDriverDeps): Promise<string> {
  let token: string | null | undefined
  try {
    token = await deps.resolveAccessToken()
  } catch (error) {
    throw toTencentChannelSearchError(error, BUDDY_CHANNEL)
  }
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new ChannelSearchError(
      'NO_ACCOUNT',
      BUDDY_CHANNEL,
      'CodeBuddy search has no usable account; select a CodeBuddy account first',
    )
  }
  return token
}
