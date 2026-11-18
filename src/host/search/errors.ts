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

  if (status === 401) return new ChannelSearchError('UNAUTHORIZED', channel, message, error)
  if (status === 429) return new ChannelSearchError('RATE_LIMITED', channel, message, error)
  if (status === 408 || code === 'TOOL_TIMEOUT' || code === 'ETIMEDOUT' || name === 'TimeoutError') {
    return new ChannelSearchError('TIMEOUT', channel, message, error)
  }
  if (code === 'NO_ACCOUNT') return new ChannelSearchError('NO_ACCOUNT', channel, message, error)
  if (code === 'UNAUTHORIZED') return new ChannelSearchError('UNAUTHORIZED', channel, message, error)
  if (code === 'RATE_LIMITED') return new ChannelSearchError('RATE_LIMITED', channel, message, error)
  if (code === 'BAD_RESPONSE') return new ChannelSearchError('BAD_RESPONSE', channel, message, error)
  return new ChannelSearchError('SEARCH_FAILED', channel, message, error)
}
