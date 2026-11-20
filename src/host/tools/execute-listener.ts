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
import type { SearchSettingsSnapshot } from '../../shared/contracts.ts'
import type { InvocationDriverFactory, InvocationSelection } from '../accounts/invocation.ts'

/** Task 15 可提供兼容 PluginLifecycle；本任务不定义完整生命周期系统。 */
export interface SearchOverrideLifecycle {
  track?<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T>
  begin?(callerSignal?: AbortSignal): {
    readonly signal: AbortSignal
    track<T>(operation: Promise<T>): Promise<T>
  }
}

export interface SearchInvocationRuntime {
  captureSelection(snapshot: SearchSettingsSnapshot): number
}

/** 当前渠道的搜索驱动表；缺失表示该账号/渠道尚不可执行。 */
export type SearchDrivers = Readonly<Partial<Record<ChannelId, SearchDriver>>>

/** `installSearchOverride` 的最小依赖。 */
export interface SearchOverrideOptions {
  readonly settings: Pick<SettingsService, 'getSnapshot'>
  readonly drivers: SearchDrivers | InvocationDriverFactory
  readonly lifecycle?: SearchOverrideLifecycle
  readonly runtime?: SearchInvocationRuntime
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
): () => void {
  const registration = ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'web_search') return next()
    const snapshot = options.settings.getSnapshot()
    const search = snapshot.search
    // OFF 必须在 runtime/账号/WASM/厂商工作之前 next，且不取消旧调用。
    if (!search.enabled) return next()

    const lease = options.lifecycle?.begin?.(exec.signal)
    const signal = lease?.signal ?? exec.signal
    let boundDriver: SearchDriver | undefined
    const operation = executeSearchQueries(exec.arguments, {
      channel: search.channel,
      // executor 先完成参数校验；getter 只执行一次并冻结整个 batch 的 invocation。
      get driver() {
        if (boundDriver !== undefined) return boundDriver
        if ('bind' in options.drivers && typeof options.drivers.bind === 'function') {
          const selection: InvocationSelection = {
            channel: search.channel,
            accountId: snapshot[search.channel].currentAccountId,
            endpointPreference: snapshot.qoder.endpointPreference,
            selectionGeneration: options.runtime?.captureSelection(snapshot) ?? 0,
          }
          boundDriver = options.drivers.bind(selection)
        } else {
          boundDriver = (options.drivers as SearchDrivers)[search.channel]
        }
        return boundDriver
      },
      profile: SEARCH_DEFAULT_PROFILE,
    }, signal)
    const value = lease !== undefined
      ? await lease.track(operation)
      : options.lifecycle?.track === undefined
        ? await operation
        : await options.lifecycle.track(operation, signal)
    return { value }
  })
  return () => {
    if (typeof registration === 'function') (registration as () => void)()
  }
}
