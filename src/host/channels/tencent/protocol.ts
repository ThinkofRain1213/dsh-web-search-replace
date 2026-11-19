import type { ChannelId } from '../../../shared/channels.ts'
import type { MockSearchSource } from '../../drivers/mock-driver.ts'
import {
  ChannelSearchError,
  normalizeChannelSearchError,
  type ChannelSearchErrorCode,
} from '../../search/errors.ts'

/** 腾讯系搜索的固定路径；host 由各渠道驱动注入。 */
export const TENCENT_SEARCH_PATH = '/agenttool/v1/search'

/** 与客户端原生搜索一致的 20s 单次预算。 */
export const TENCENT_SEARCH_TIMEOUT_MS = 20_000

/** 共享层能够归因的失败类别（不包含账号与入参问题）。 */
export type TencentProtocolFailureCode = Extract<
  ChannelSearchErrorCode,
  'UNAUTHORIZED' | 'RATE_LIMITED' | 'TIMEOUT' | 'BAD_RESPONSE' | 'SEARCH_FAILED'
>

/** 单次腾讯搜索请求；host 与产品请求头由渠道驱动注入。 */
export interface TencentSearchRequest {
  readonly host: string
  readonly accessToken: string
  readonly query: string
  readonly maxResults: number
  readonly signal: AbortSignal
  /** 渠道产品请求头（例如 User-Agent）；协议层不猜测。 */
  readonly headers?: Readonly<Record<string, string>>
  /** 测试注入；生产默认使用全局 fetch。 */
  readonly fetcher?: typeof fetch
}

/**
 * 共享协议层的失败；只带可路由类别与 HTTP 状态，不绑定渠道。
 * 渠道驱动用 {@link toTencentChannelSearchError} 补上自己的 channel。
 */
export class TencentSearchProtocolError extends Error {
  override readonly name = 'TencentSearchProtocolError'

  constructor(
    readonly code: TencentProtocolFailureCode,
    message: string,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
  }
}

/** 把共享协议失败绑定到渠道；其他错误走既有 normalize 边界。 */
export function toTencentChannelSearchError(error: unknown, channel: ChannelId): ChannelSearchError {
  if (error instanceof TencentSearchProtocolError) {
    return new ChannelSearchError(error.code, channel, error.message, error, error.status)
  }
  return normalizeChannelSearchError(error, channel)
}

/**
 * 发一次腾讯 `agenttool/v1/search` 请求并投影为官方 sources[]。
 *
 * 只负责 HTTP、响应防御与通用错误分类；host、账号和产品头全部由调用方注入。
 * 自己的 20s 预算与外层 signal 熔合，但归因必须区分「本层超时」与「调用方取消」。
 */
export async function postTencentSearch(
  request: TencentSearchRequest,
): Promise<readonly MockSearchSource[]> {
  const fetcher = request.fetcher ?? fetch
  if (request.signal.aborted) throw abortFailure(request.signal)

  const timeout = AbortSignal.timeout(TENCENT_SEARCH_TIMEOUT_MS)
  const composed = AbortSignal.any([request.signal, timeout])

  let response: Response
  try {
    response = await fetcher(`https://${request.host}${TENCENT_SEARCH_PATH}`, {
      method: 'POST',
      headers: {
        ...request.headers,
        'Authorization': `Bearer ${request.accessToken}`,
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        query: request.query,
        type: 'text2text',
        max_results: request.maxResults,
      }),
      signal: composed,
    })
  } catch (error) {
    throw transportFailure(error, timeout, composed)
  }

  if (!response.ok) throw await httpFailure(response)
  const json = await readJson(response, timeout, composed)
  return projectSources(json)
}

/** 调用前已 abort：绝不发请求；超时原因按超时归因，其余按取消归因。 */
function abortFailure(signal: AbortSignal): TencentSearchProtocolError {
  if (isTimeoutReason(signal.reason)) {
    return new TencentSearchProtocolError(
      'TIMEOUT',
      'tencent search timed out before this search returned (the host tool budget elapsed)',
    )
  }
  return new TencentSearchProtocolError('SEARCH_FAILED', 'tencent search aborted by the caller')
}

/**
 * fetch/json 阶段失败的归因。
 *
 * 只有本层 `AbortSignal.timeout` 触发时才声称「我们的 20s 预算」；外层 deadline
 * 到期归为宿主预算超时；普通取消归为 SEARCH_FAILED，不能误报成 TIMEOUT。
 */
function transportFailure(
  error: unknown,
  timeout: AbortSignal,
  composed: AbortSignal,
): TencentSearchProtocolError {
  if (composed.aborted) {
    if (timeout.aborted) {
      return new TencentSearchProtocolError(
        'TIMEOUT',
        `tencent search timed out after ${TENCENT_SEARCH_TIMEOUT_MS}ms`,
        undefined,
        error,
      )
    }
    if (isTimeoutReason(composed.reason)) {
      return new TencentSearchProtocolError(
        'TIMEOUT',
        'tencent search timed out before this search returned (the host tool budget elapsed)',
        undefined,
        error,
      )
    }
    return new TencentSearchProtocolError(
      'SEARCH_FAILED',
      'tencent search aborted by the caller',
      undefined,
      error,
    )
  }
  return new TencentSearchProtocolError(
    'SEARCH_FAILED',
    `tencent search request failed: ${errorMessage(error)}`,
    undefined,
    error,
  )
}

/** 宿主 deadline 的通用判据：已知超时 name，或既有 errors.ts 认可的 TOOL_TIMEOUT code。 */
function isTimeoutReason(reason: unknown): boolean {
  const record = reason as { name?: unknown; code?: unknown } | undefined
  return record?.name === 'TimeoutReason'
    || record?.name === 'TimeoutError'
    || record?.code === 'TOOL_TIMEOUT'
}

/** HTTP 非 2xx 的可路由分类；响应体只截取一段可读说明，不包含请求头。 */
async function httpFailure(response: Response): Promise<TencentSearchProtocolError> {
  const detail = await readErrorDetail(response)
  const message = `tencent search request failed (HTTP ${response.status})${detail}`
  if (response.status === 401) {
    return new TencentSearchProtocolError('UNAUTHORIZED', message, 401)
  }
  if (response.status === 429) {
    return new TencentSearchProtocolError('RATE_LIMITED', message, 429)
  }
  return new TencentSearchProtocolError('SEARCH_FAILED', message, response.status)
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim().slice(0, 300)
    return text.length > 0 ? `: ${text}` : ''
  } catch {
    return ''
  }
}

async function readJson(
  response: Response,
  timeout: AbortSignal,
  composed: AbortSignal,
): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    if (composed.aborted) throw transportFailure(error, timeout, composed)
    throw new TencentSearchProtocolError(
      'BAD_RESPONSE',
      'tencent search returned a non-JSON response',
      undefined,
      error,
    )
  }
}

/** 逐项防御：null/非对象、缺 url、空字段都不能让整条调用失败。 */
function projectSources(json: unknown): MockSearchSource[] {
  const record = asRecord(json)
  const results = record?.results
  if (!Array.isArray(results)) {
    throw new TencentSearchProtocolError(
      'BAD_RESPONSE',
      'tencent search returned an unparseable response: "results" is not an array',
    )
  }
  const sources: MockSearchSource[] = []
  for (const raw of results) {
    const item = asRecord(raw)
    if (item === undefined) continue
    const url = typeof item.url === 'string' ? item.url : ''
    if (url.length === 0) continue
    const title = typeof item.title === 'string' && item.title.length > 0 ? item.title : undefined
    const snippet = typeof item.snippet === 'string' && item.snippet.length > 0
      ? item.snippet
      : undefined
    sources.push({
      url,
      ...title === undefined ? {} : { title },
      ...snippet === undefined ? {} : { snippet },
    })
  }
  return sources
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
