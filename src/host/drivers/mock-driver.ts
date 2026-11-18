/**
 * Task 3 的确定性搜索驱动。它只生成官方 `web_search` output 形状的本地数据，
 * 不持有账号、不选择 Provider、不发起网络，也不实现任何真实厂商协议。
 */

/** 与 DSH `WebSearchSource` 兼容的最小结构。 */
export interface MockSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly summary?: string
  readonly publishedAt?: string
}

/** 与 DSH `WebSearchResult` / 官方 `web_search` output value 兼容。 */
export interface SearchDriverResult {
  readonly content?: string
  readonly sources: readonly MockSearchSource[]
  readonly truncated: boolean
}

/** 后续真实驱动也沿用的单次搜索边界。 */
export interface SearchDriver {
  searchOnce(query: string, maxResults: number, signal: AbortSignal): Promise<SearchDriverResult>
}

/** 与 tool-web 的默认 `searchMaxResults` 一致。 */
export const MOCK_SEARCH_MAX_RESULTS = 10

/** 无状态、确定性的本地 mock；signal 由调用方和 timeout wrapper 管理。 */
export class MockSearchDriver implements SearchDriver {
  async searchOnce(query: string, maxResults: number, signal: AbortSignal): Promise<SearchDriverResult> {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new Error('mock search query must be a non-empty string')
    }
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MOCK_SEARCH_MAX_RESULTS) {
      throw new Error(`mock search maxResults must be an integer from 1 to ${MOCK_SEARCH_MAX_RESULTS}`)
    }
    // Mock 本身没有异步工作可取消；异步驱动必须在这里转发并观察 signal。
    void signal
    return {
      content: `Mock answer for ${query}`,
      sources: [{
        url: `https://mock.search.test/result?q=${encodeURIComponent(query)}`,
        title: `Mock result for ${query}`,
        snippet: `Mock snippet for ${query}`,
        summary: `Mock summary for ${query}`,
      }],
      truncated: false,
    }
  }
}
