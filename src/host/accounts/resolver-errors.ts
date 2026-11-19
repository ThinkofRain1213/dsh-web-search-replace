/**
 * 账号/凭据解析边界。
 *
 * 驱动只信任自己渠道的账号快照；解析器抛出的错误必须在这里收敛：
 *
 * - 保留 `ChannelSearchError` 的安全结构化 `code`（NO_ACCOUNT/UNAUTHORIZED/
 *   TIMEOUT 等），因为上层需要据此决定刷新或重新登录；
 * - 强制重绑到驱动自己的精确渠道，绝不把其他渠道的绑定带出去；
 * - 使用调用方提供的固定消息，丢弃底层原文与 cause，避免 token/machine_id
 *   通过错误链泄漏（R16/N4）。
 */
import type { ChannelId } from '../../shared/channels.ts'
import { ChannelSearchError } from '../search/errors.ts'

/**
 * 把账号解析异常收敛为精确渠道的安全搜索错误。
 *
 * @param error - 解析器抛出的任意异常。
 * @param channel - 当前驱动固定归属的渠道。
 * @param message - 固定、脱敏的消息模板。
 */
export function toChannelAccountSearchError(
  error: unknown,
  channel: ChannelId,
  message: string,
): ChannelSearchError {
  const code = error instanceof ChannelSearchError ? error.code : 'SEARCH_FAILED'
  return new ChannelSearchError(code, channel, message)
}
