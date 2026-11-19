import type { ChannelId } from '../../shared/channels.ts'
import type {
  MockSearchSource,
  SearchDriver,
  SearchDriverResult,
} from '../drivers/mock-driver.ts'
import type { SearchExecutionProfile } from './execution-profile.ts'
import { ChannelSearchError, normalizeChannelSearchError } from './errors.ts'

export { SEARCH_DEFAULT_PROFILE } from './execution-profile.ts'

/** 官方 web_search output value；不携带厂商专属扩展字段。 */
export type WebSearchValue = SearchDriverResult

/** 一次 canonical 搜索所需的已选渠道、可选驱动与官方边界。 */
export interface SearchExecutionOptions {
  readonly channel: ChannelId
  readonly driver: SearchDriver | undefined
  readonly profile: SearchExecutionProfile
}

/**
 * 校验并执行官方多查询语义。
 *
 * 参数校验先于 options.driver 的读取；多查询共享派生取消信号，首错取消兄弟，
 * 等待全部 settle 后抛出。成功结果按 rank 轮转、URL 去重并投影为官方 output。
 */
export async function executeSearchQueries(
  args: unknown,
  options: SearchExecutionOptions,
  signal: AbortSignal,
): Promise<WebSearchValue> {
  const queries = parseQueries(args, options.profile.maxQueries, options.channel)
  const driver = options.driver
  if (driver === undefined) {
    throw new ChannelSearchError(
      'NO_ACCOUNT',
      options.channel,
      `search override has no account or driver for channel "${options.channel}"`,
    )
  }

  if (queries.length === 1) {
    try {
      const result = readDriverResult(
        await driver.searchOnce(queries[0]!, options.profile.maxResults, signal),
        options.channel,
      )
      return projectSingleResult(result, options.profile.maxResults, options.profile.summaryMaxChars)
    } catch (error) {
      throw normalizeChannelSearchError(error, options.channel)
    }
  }

  const controller = new AbortController()
  const batchSignal = AbortSignal.any([signal, controller.signal])
  let firstFailure: { error: unknown } | undefined
  const results: SearchDriverResult[] = []
  const searches = queries.map(async (query, index) => {
    try {
      results[index] = readDriverResult(
        await driver.searchOnce(query, options.profile.maxResults, batchSignal),
        options.channel,
      )
    } catch (error) {
      if (firstFailure === undefined) firstFailure = { error }
      controller.abort(error)
      throw error
    }
  })
  await Promise.allSettled(searches)
  if (firstFailure !== undefined) {
    throw normalizeChannelSearchError(firstFailure.error, options.channel)
  }
  return projectResult(
    mergeResults(queries, results, options.profile.maxResults),
    options.profile.summaryMaxChars,
  )
}

/** 官方参数约束：数量上限先于精确字符串去重，不能用 trim 改写查询身份。 */
function parseQueries(args: unknown, maxQueries: number, channel: ChannelId): string[] {
  const invalid = (message: string): never => {
    throw new ChannelSearchError('INVALID_ARGUMENTS', channel, message)
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    invalid('web_search arguments must be an object')
  }
  const queries = (args as Record<string, unknown>).queries
  if (!Array.isArray(queries)) return invalid('queries must be an array')
  if (queries.length === 0) return invalid('queries must contain at least one query')
  if (queries.length > maxQueries) {
    return invalid(`queries must contain at most ${maxQueries} ${maxQueries === 1 ? 'query' : 'queries'}`)
  }
  if (queries.some(query => typeof query !== 'string' || query.trim().length === 0)) {
    return invalid('each query must be a non-empty string')
  }
  return [...new Set(queries as string[])]
}

/** 拒绝无法通过官方 output schema 的驱动结果，避免把坏数据交给宿主。 */
function readDriverResult(value: unknown, channel: ChannelId): SearchDriverResult {
  const result = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
  const valid = result !== undefined
    && (result.content === undefined || typeof result.content === 'string')
    && Array.isArray(result.sources)
    && result.sources.every(isDriverSource)
    && typeof result.truncated === 'boolean'
  if (!valid) {
    throw new ChannelSearchError('BAD_RESPONSE', channel, 'channel search driver returned an invalid response')
  }
  return value as SearchDriverResult
}

function isDriverSource(value: unknown): value is MockSearchSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const source = value as Record<string, unknown>
  return typeof source.url === 'string'
    && (source.title === undefined || typeof source.title === 'string')
    && (source.snippet === undefined || typeof source.snippet === 'string')
    && (source.summary === undefined || typeof source.summary === 'string')
    && (source.publishedAt === undefined || typeof source.publishedAt === 'string')
}

/**
 * 官方输出不变量：按 rank 轮转、URL 首次出现者获胜，最多 maxResults 条；
 * 仅在实际丢弃新 URL 时报告 droppedSource。单查询与多查询共用同一归一化。
 */
function collectSources(
  results: readonly SearchDriverResult[],
  maxResults: number,
): { sources: MockSearchSource[]; droppedSource: boolean } {
  const seen = new Set<string>()
  const sources: MockSearchSource[] = []
  let sourceRanks = 0
  for (const result of results) sourceRanks = Math.max(sourceRanks, result.sources.length)
  let droppedSource = false
  merge: for (let rank = 0; rank < sourceRanks; rank++) {
    for (const result of results) {
      const source = result.sources[rank]
      if (source !== undefined && !seen.has(source.url)) {
        seen.add(source.url)
        if (sources.length === maxResults) {
          droppedSource = true
          break merge
        }
        sources.push(source)
      }
    }
  }
  return { sources, droppedSource }
}

/** 单查询保留驱动 content，不添加多查询标题；来源仍走共享去重与 cap。 */
function projectSingleResult(
  result: SearchDriverResult,
  maxResults: number,
  summaryMaxChars: number,
): WebSearchValue {
  const { sources, droppedSource } = collectSources([result], maxResults)
  return projectResult(
    { ...result, sources, truncated: result.truncated || droppedSource },
    summaryMaxChars,
  )
}

/** 与官方 mergeSearchResults 一致：仅确认丢源或上游截断时设置 truncated。 */
function mergeResults(
  queries: readonly string[],
  results: readonly SearchDriverResult[],
  maxResults: number,
): SearchDriverResult {
  const { sources, droppedSource } = collectSources(results, maxResults)
  const contents = results.flatMap((result, index) => {
    if (result.content === undefined || result.content.length === 0) return []
    return [`### ${queries[index]}\n\n${result.content}`]
  })
  return {
    ...contents.length > 0 ? { content: contents.join('\n\n') } : {},
    sources,
    truncated: results.some(result => result.truncated) || droppedSource,
  }
}

/** 单查询与合并结果共用官方 source/summary 投影，不合成 answer。 */
function projectResult(result: SearchDriverResult, summaryMaxChars: number): WebSearchValue {
  return {
    ...result.content !== undefined ? { content: result.content } : {},
    sources: result.sources.map(source => projectSource(source, summaryMaxChars)),
    truncated: result.truncated,
  }
}

function projectSource(source: MockSearchSource, summaryMaxChars: number): MockSearchSource {
  const projected: {
    url: string
    title?: string
    snippet?: string
    summary?: string
    publishedAt?: string
  } = {
    url: source.url,
    ...source.title !== undefined ? { title: source.title } : {},
    ...source.snippet !== undefined ? { snippet: source.snippet } : {},
    ...source.publishedAt !== undefined ? { publishedAt: source.publishedAt } : {},
  }
  const summary = source.summary?.replace(/\s+/gu, ' ').trim() ?? ''
  if (summary.length > 0) projected.summary = boundSummary(summary, summaryMaxChars)
  return projected
}

/** 省略号计入上限；避免在 UTF-16 surrogate pair 中间截断。 */
function boundSummary(summary: string, maxChars: number): string {
  if (summary.length <= maxChars) return summary
  let end = maxChars - 1
  if (end > 0 && /[\uD800-\uDBFF]/.test(summary[end - 1] ?? '')
    && /[\uDC00-\uDFFF]/.test(summary[end] ?? '')) {
    end--
  }
  return `${summary.slice(0, end)}…`
}
