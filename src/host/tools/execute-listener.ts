/**
 * 在真实 DSH `tools/execute` around-dispatch waterfall 上接管 `web_search`。
 *
 * 固定顺序：非 web_search → next；OFF → next；ON → canonical 多查询参数校验、
 * 解析当前渠道驱动、并发执行并返回 `{ value }`。共享 ToolExecutionPipeline 会用
 * tool-web 原有 output schema/render/presentationMeta 归一化该值；ON 的任何失败都不 next。
 */
import type { ChannelId } from '../../shared/channels.ts'
import type { SearchDriver } from '../drivers/mock-driver.ts'
import { SEARCH_DEFAULT_PROFILE } from '../search/execution-profile.ts'
import { executeSearchQueries } from '../search/executor.ts'
import type { SettingsService } from '../settings/service.ts'

/** Task 15 可提供兼容 PluginLifecycle；本任务不定义完整生命周期系统。 */
export interface SearchOverrideLifecycle {
  track?<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T>
}

/** 当前渠道的搜索驱动表；缺失表示该账号/渠道尚不可执行。 */
export type SearchDrivers = Readonly<Partial<Record<ChannelId, SearchDriver>>>

/** `installSearchOverride` 的最小依赖。 */
export interface SearchOverrideOptions {
  readonly settings: Pick<SettingsService, 'getSnapshot'>
  readonly drivers: SearchDrivers
  readonly lifecycle?: SearchOverrideLifecycle
}

/** DSH around-dispatch 调用中本监听器读取的字段。 */
export interface SearchOverrideExecution {
  readonly name: string
  readonly arguments: unknown
  signal: AbortSignal
}

/** 包装器结果只需携带 value；其余字段由真实 pipeline 归一化。 */
export interface SearchOverrideToolResult {
  readonly isError?: boolean
  readonly value?: unknown
  readonly content?: unknown
  readonly meta?: unknown
  readonly error?: unknown
}

/** Cordis 事件注册的最小结构，避免复制宿主完整 Context 类型。 */
export interface SearchOverrideContext {
  on(
    name: 'tools/execute',
    listener: (
      exec: SearchOverrideExecution,
      next: () => Promise<SearchOverrideToolResult>,
    ) => Promise<SearchOverrideToolResult>,
  ): unknown
}

/**
 * 注册一个 fiber 所有的 `tools/execute` 监听器。
 *
 * 组合顺序要求 timeout policy 先注册、本监听器后注册，使 timeout 在外层替换
 * signal；pipeline 随后把该 signal 与原始 caller signal 融合后交给驱动。
 */
export function installSearchOverride(
  ctx: SearchOverrideContext,
  options: SearchOverrideOptions,
): void {
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'web_search') return next()
    const search = options.settings.getSnapshot().search
    if (!search.enabled) return next()

    const operation = executeSearchQueries(exec.arguments, {
      channel: search.channel,
      // executor 先完成参数校验，再通过此 getter 解析账号对应的驱动。
      get driver() { return options.drivers[search.channel] },
      profile: SEARCH_DEFAULT_PROFILE,
    }, exec.signal)
    const value = options.lifecycle?.track === undefined
      ? await operation
      : await options.lifecycle.track(operation, exec.signal)
    return { value }
  })
}
