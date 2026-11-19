import type { ChannelId } from '../../shared/channels.ts'

/** 渠道搜索失败的可路由类别；不包含任何厂商专属字段。 */
export type ChannelSearchErrorCode =
  | 'INVALID_ARGUMENTS'
  | 'NO_ACCOUNT'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'BAD_RESPONSE'
  | 'SEARCH_FAILED'

/** ON 搜索路径向上抛出的结构化错误；监听器不得捕获后回退官方 Provider。 */
export class ChannelSearchError extends Error {
  override readonly name = 'ChannelSearchError'

  constructor(
    readonly code: ChannelSearchErrorCode,
    readonly channel: ChannelId,
    message: string,
    cause?: unknown,
    /**
     * 可信的实际 HTTP 状态；只有能从结构化上游证据确定时设置。
     * 业务 code='UNAUTHORIZED' 但没有 HTTP 401 时保持 undefined，避免
     * 调用方把 403/业务错误误判成可刷新重试的 401。
     */
    readonly httpStatus?: number,
  ) {
    super(message, cause === undefined ? undefined : { cause })
  }
}

/** 把通用驱动边界错误归入稳定类别，并保留首错消息与 cause。 */
export function normalizeChannelSearchError(error: unknown, channel: ChannelId): ChannelSearchError {
  if (error instanceof ChannelSearchError) return error
  const record = typeof error === 'object' && error !== null
    ? error as Record<string, unknown>
    : {}
  const status = typeof record.status === 'number'
    ? record.status
    : typeof record.statusCode === 'number' ? record.statusCode : undefined
  const code = typeof record.code === 'string' ? record.code : undefined
  const name = typeof record.name === 'string' ? record.name : undefined
  const message = error instanceof Error ? error.message : String(error)

  if (status === 401) {
    return new ChannelSearchError('UNAUTHORIZED', channel, message, error, 401)
  }
  if (status === 429) {
    return new ChannelSearchError('RATE_LIMITED', channel, message, error, 429)
  }
  if (status === 408 || code === 'TOOL_TIMEOUT' || code === 'ETIMEDOUT' || name === 'TimeoutError') {
    return new ChannelSearchError('TIMEOUT', channel, message, error, status)
  }
  if (code === 'NO_ACCOUNT') return new ChannelSearchError('NO_ACCOUNT', channel, message, error)
  if (code === 'UNAUTHORIZED') {
    return new ChannelSearchError('UNAUTHORIZED', channel, message, error, status)
  }
  if (code === 'RATE_LIMITED') {
    return new ChannelSearchError('RATE_LIMITED', channel, message, error, status)
  }
  if (code === 'BAD_RESPONSE') {
    return new ChannelSearchError('BAD_RESPONSE', channel, message, error, status)
  }
  return new ChannelSearchError('SEARCH_FAILED', channel, message, error, status)
}
