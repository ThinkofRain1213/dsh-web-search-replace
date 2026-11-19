/**
 * Qoder 搜索的共享协议层（中国版与国际版共用；host / 账号由渠道驱动注入）。
 *
 * 本文件只处理三件事：
 *
 * 1. **固定产品参数**：搜索路径、20s 预算、COSY 客户端版本与 CLI 身份元数据；
 * 2. **请求信封与响应投影**：`{payload, encodeVersion}` → WASM 加密；`pageItems[]`
 *    → 官方 `sources[]`（`link → url`、合法 `publishedTime → publishedAt`）；
 * 3. **通用失败分类**：401 / 429 / 超时 / 调用方取消 / 坏响应，与既有
 *    `ChannelSearchError` 类别一致；错误里不出现 token、machineId 或签名头。
 *
 * ⚠️ 本层**不**包含国际版双域策略、账号池或产品选路；那些属于 Task 7 / 8。
 */
import { randomUUID } from 'node:crypto'

import type { ChannelId } from '../../../shared/channels.ts'
import type { MockSearchSource } from '../../drivers/mock-driver.ts'
import {
  ChannelSearchError,
  normalizeChannelSearchError,
  type ChannelSearchErrorCode,
} from '../../search/errors.ts'

/** Qoder 搜索的固定路径；签名输入必须精确使用它。 */
export const QODER_SEARCH_PATH = '/api/v1/webSearch/oneSearch'

/** 与客户端原生搜索一致的 20s 单次预算。 */
export const QODER_SEARCH_TIMEOUT_MS = 20_000

/** COSY 客户端版本；同时决定 `Cosy-Version` 与签名载荷。 */
export const QODER_COSY_VERSION = '1.1.49'

/**
 * 请求体 `metadata.context` 的客户端身份。
 *
 * 取自官方客户端 CLI 默认值；中国版与国际版共用同一组 CLI 身份，host 与账号
 * 仍然各自独立。
 */
export const QODER_CLIENT_METADATA = Object.freeze({
  client_type: '5',
  business_product: 'cli',
  business_type: 'agent',
  scene: 'assistant',
})

/** 官方 `WebSearchTool` 的默认时间范围。 */
export const QODER_SEARCH_TIME_RANGE = 'NoLimit'

/** 官方 `WebSearchTool` 的默认内容选项。 */
export const QODER_SEARCH_CONTENTS = Object.freeze({
  mainText: false,
  markdownText: false,
  summary: false,
})

/**
 * 签名所需的账号秘密。
 *
 * 只在本进程内流转；不得进入日志、RPC DTO、测试快照或错误消息。
 */
export interface QoderSigningCredential {
  /** Qoder 用户 id；缺省时按空串参与签名（与官方一致）。 */
  readonly uid?: string
  /** 签名使用的 security OAuth token（不是公开 access token）。 */
  readonly securityOauthToken: string
  /** 设备标识；缺失时 WASM 会 trap，故必须在签名前拒绝。 */
  readonly machineId: string
  /** 组织 id（可选）。 */
  readonly organizationId?: string
}

/** 一次签名产出的可直接发送请求。 */
export interface PreparedRequest {
  /** WASM 生成的完整 URL（`/algo/...?...Encode=1`）。 */
  readonly url: string
  /** WASM 生成的签名头；必须原样透传。 */
  readonly headers: Readonly<Record<string, string>>
  /** WASM 加密后的请求体。 */
  readonly body: string
}

/** 协议层对签名器的最小依赖；`QoderSigner` 实现它，测试也可注入真实实现。 */
export interface QoderRequestSigner {
  prepare(
    host: string,
    path: string,
    body: string,
    credential: QoderSigningCredential,
    signal: AbortSignal,
  ): Promise<PreparedRequest>
  dispose(): void
}

/** 共享层能够归因的失败类别。 */
export type QoderProtocolFailureCode = Extract<
  ChannelSearchErrorCode,
  'NO_ACCOUNT' | 'UNAUTHORIZED' | 'RATE_LIMITED' | 'TIMEOUT' | 'BAD_RESPONSE' | 'SEARCH_FAILED'
>

/**
 * 共享协议层的失败；只带可路由类别与 HTTP 状态，不绑定渠道。
 * 渠道驱动用 {@link toQoderChannelSearchError} 补上自己的 channel。
 */
export class QoderSearchProtocolError extends Error {
  override readonly name = 'QoderSearchProtocolError'

  constructor(
    readonly code: QoderProtocolFailureCode,
    message: string,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
  }
}

/** 把共享协议失败绑定到渠道；其他错误走既有 normalize 边界。 */
export function toQoderChannelSearchError(error: unknown, channel: ChannelId): ChannelSearchError {
  if (error instanceof QoderSearchProtocolError) {
    return new ChannelSearchError(error.code, channel, error.message, error)
  }
  return normalizeChannelSearchError(error, channel)
}

/**
 * 构造官方搜索信封的明文 body。
 *
 * 官方客户端把内层 payload 再 JSON.stringify 一次，外层只带
 * `{payload, encodeVersion:'1'}`；WASM 加密的是整个外层 body。
 */
export function buildQoderSearchBody(query: string): string {
  return JSON.stringify({
    payload: JSON.stringify({
      query,
      timeRange: QODER_SEARCH_TIME_RANGE,
      contents: QODER_SEARCH_CONTENTS,
    }),
    encodeVersion: '1',
  })
}

/** 一次 Qoder 搜索请求；host / path 由渠道驱动注入，签名器负责签名。 */
export interface QoderSearchHttpRequest {
  readonly host: string
  readonly path: string
  readonly query: string
  readonly credential: QoderSigningCredential
  readonly signer: QoderRequestSigner
  readonly signal: AbortSignal
  /** 测试注入；生产默认使用全局 fetch。 */
  readonly fetcher?: typeof fetch
}

/**
 * 签名并发送一次 Qoder 搜索，投影为官方 `sources[]`。
 *
 * 自己的 20s 预算与外层 signal 熔合，但归因必须区分「本层超时」「宿主预算超时」
 * 与「调用方取消」。签名器只在本函数内使用；释放由调用方（渠道驱动）负责。
 */
export async function postQoderSearch(
  request: QoderSearchHttpRequest,
): Promise<readonly MockSearchSource[]> {
  const fetcher = request.fetcher ?? fetch
  if (request.signal.aborted) throw abortFailure(request.signal)

  const timeout = AbortSignal.timeout(QODER_SEARCH_TIMEOUT_MS)
  const composed = AbortSignal.any([request.signal, timeout])

  let prepared: PreparedRequest
  try {
    prepared = await request.signer.prepare(
      request.host,
      request.path,
      buildQoderSearchBody(request.query),
      request.credential,
      composed,
    )
  } catch (error) {
    if (error instanceof QoderSearchProtocolError) throw error
    throw new QoderSearchProtocolError(
      'SEARCH_FAILED',
      `qoder signing failed: ${errorMessage(error)}`,
      undefined,
      error,
    )
  }

  let response: Response
  try {
    response = await fetcher(prepared.url, {
      method: 'POST',
      // WASM 生成的签名头必须原样透传；覆盖 Authorization 会得到 403。
      headers: { ...prepared.headers, 'X-Session-ID': randomUUID() },
      body: prepared.body,
      signal: composed,
    })
  } catch (error) {
    throw transportFailure(error, timeout, composed)
  }

  if (!response.ok) throw await httpFailure(response, request.path)
  const json = await readJson(response, timeout, composed)
  return projectQoderSearchResponse(json)
}

/** 调用前已 abort：绝不发请求；超时原因按超时归因，其余按取消归因。 */
function abortFailure(signal: AbortSignal): QoderSearchProtocolError {
  if (isTimeoutReason(signal.reason)) {
    return new QoderSearchProtocolError(
      'TIMEOUT',
      'qoder search timed out before this search returned (the host tool budget elapsed)',
    )
  }
  return new QoderSearchProtocolError('SEARCH_FAILED', 'qoder search aborted by the caller')
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
): QoderSearchProtocolError {
  if (composed.aborted) {
    if (timeout.aborted) {
      return new QoderSearchProtocolError(
        'TIMEOUT',
        `qoder search timed out after ${QODER_SEARCH_TIMEOUT_MS}ms`,
        undefined,
        error,
      )
    }
    if (isTimeoutReason(composed.reason)) {
      return new QoderSearchProtocolError(
        'TIMEOUT',
        'qoder search timed out before this search returned (the host tool budget elapsed)',
        undefined,
        error,
      )
    }
    return new QoderSearchProtocolError(
      'SEARCH_FAILED',
      'qoder search aborted by the caller',
      undefined,
      error,
    )
  }
  return new QoderSearchProtocolError(
    'SEARCH_FAILED',
    `qoder search request failed: ${errorMessage(error)}`,
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
async function httpFailure(response: Response, path: string): Promise<QoderSearchProtocolError> {
  const detail = await readErrorDetail(response)
  const message = `qoder search request failed (HTTP ${response.status}) for ${path}${detail}`
  if (response.status === 401) {
    return new QoderSearchProtocolError('UNAUTHORIZED', message, 401)
  }
  if (response.status === 429) {
    return new QoderSearchProtocolError('RATE_LIMITED', message, 429)
  }
  return new QoderSearchProtocolError('SEARCH_FAILED', message, response.status)
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
    throw new QoderSearchProtocolError(
      'BAD_RESPONSE',
      'qoder search returned a non-JSON response',
      undefined,
      error,
    )
  }
}

/**
 * 逐项防御：`pageItems[].link` 是 URL 的唯一来源；null/非对象、缺 link 的条目
 * 直接丢弃，不能让整条调用失败。
 */
export function projectQoderSearchResponse(json: unknown): MockSearchSource[] {
  const record = asRecord(json)
  const items = record?.pageItems ?? record?.page_items
  if (!Array.isArray(items)) {
    throw new QoderSearchProtocolError(
      'BAD_RESPONSE',
      'qoder search returned an unparseable response: "pageItems" is not an array',
    )
  }

  const sources: MockSearchSource[] = []
  for (const raw of items) {
    const item = asRecord(raw)
    if (item === undefined) continue
    // ⚠️ Qoder 的 url 字段叫 `link`（不是腾讯的 `url`）；缺 link 的条目无法通过
    // 官方 output schema，必须丢弃而不是填空串。
    const url = typeof item.link === 'string' ? item.link : ''
    if (url.length === 0) continue
    const title = typeof item.title === 'string' && item.title.length > 0 ? item.title : undefined
    const snippet = typeof item.snippet === 'string' && item.snippet.length > 0
      ? item.snippet
      : undefined
    const publishedAt = readPublishedAt(item.publishedTime)
    sources.push({
      url,
      ...title === undefined ? {} : { title },
      ...snippet === undefined ? {} : { snippet },
      ...publishedAt === undefined ? {} : { publishedAt },
    })
  }
  return sources
}

/** 只接受 ISO-8601 形态且可解析的发布时间；其他值一律丢弃。 */
function readPublishedAt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(trimmed)) return undefined
  if (Number.isNaN(Date.parse(trimmed))) return undefined
  return trimmed
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
