/**
 * 测试替身：模拟 Cordis volatile 配置与 `configEditor.edit` 的写入路径。
 *
 * 真实 Loader 在一次成功写入后保证两件事，本替身逐项复现：
 * 1. 普通配置被候选值整体替换；
 * 2. 每个 volatile 叶子引用原地更新，因此再次 `.get()` 能读到新值。
 *
 * 写入失败时不改动任何引用，用于验证「失败保留旧快照」。
 */
import type { ChannelId, QoderEndpointPreference } from '../../../src/shared/channels.ts'
import type { SearchConfig, VolatileConfigValue } from '../../../src/host/config.ts'

/** 普通配置的完整形状（快照与写入共用）。 */
export interface SettingsState {
  search: { enabled: boolean; channel: ChannelId }
  buddy: { currentAccountId: string | null }
  workbuddy: { currentAccountId: string | null }
  qoder: { currentAccountId: string | null; endpointPreference: QoderEndpointPreference }
  qodercn: { currentAccountId: string | null }
}

/** 可写 volatile 引用。 */
export interface Ref<T> extends VolatileConfigValue<T> {
  set(value: T): void
}

/** 创建一个与 Loader 语义一致的不可变快照引用。 */
export function ref<T>(initial: T): Ref<T> {
  let value = structuredClone(initial)
  return {
    get: () => value,
    set: (next) => {
      value = structuredClone(next)
    },
  }
}

/** 设置服务测试所需的配置编辑器与引用集合。 */
export interface SettingsDouble {
  readonly config: SearchConfig
  readonly editor: {
    edit(
      entry: unknown,
      change: (current: Record<string, any>, inherited: Record<string, any>) => Record<string, any>,
    ): Promise<void>
  }
  /** 每次成功写入后的完整配置。 */
  readonly edits: SettingsState[]
  /** 当前普通配置。 */
  getState(): SettingsState
  /** 让下一次写入以给定错误失败。 */
  failNextWrite(message?: string): void
}

/** 创建默认关闭、CodeBuddy、无当前账号的设置替身。 */
export function createSettingsDouble(initial?: Partial<SettingsState>): SettingsDouble {
  const state: SettingsState = {
    search: { enabled: false, channel: 'buddy' },
    buddy: { currentAccountId: null },
    workbuddy: { currentAccountId: null },
    qoder: { currentAccountId: null, endpointPreference: 'auto' },
    qodercn: { currentAccountId: null },
    ...structuredClone(initial ?? {}),
  }
  const refs = {
    enabled: ref(state.search.enabled),
    channel: ref(state.search.channel),
    buddy: ref(state.buddy.currentAccountId),
    workbuddy: ref(state.workbuddy.currentAccountId),
    qoder: ref(state.qoder.currentAccountId),
    endpointPreference: ref(state.qoder.endpointPreference),
    qodercn: ref(state.qodercn.currentAccountId),
  }
  const config: SearchConfig = {
    search: { enabled: refs.enabled, channel: refs.channel },
    buddy: { currentAccountId: refs.buddy },
    workbuddy: { currentAccountId: refs.workbuddy },
    qoder: {
      currentAccountId: refs.qoder,
      endpointPreference: refs.endpointPreference,
    },
    qodercn: { currentAccountId: refs.qodercn },
  }
  let current = structuredClone(state)
  let failure: Error | undefined
  const edits: SettingsState[] = []
  const editor = {
    async edit(
      _entry: unknown,
      change: (current: Record<string, any>, inherited: Record<string, any>) => Record<string, any>,
    ): Promise<void> {
      if (failure !== undefined) throw failure
      const next = change(structuredClone(current), {}) as SettingsState
      current = structuredClone(next)
      refs.enabled.set(current.search.enabled)
      refs.channel.set(current.search.channel)
      refs.buddy.set(current.buddy.currentAccountId)
      refs.workbuddy.set(current.workbuddy.currentAccountId)
      refs.qoder.set(current.qoder.currentAccountId)
      refs.endpointPreference.set(current.qoder.endpointPreference)
      refs.qodercn.set(current.qodercn.currentAccountId)
      edits.push(structuredClone(current))
    },
  }
  return {
    config,
    editor,
    edits,
    getState: () => structuredClone(current),
    failNextWrite: (message = 'write failed') => {
      failure = new Error(message)
    },
  }
}
