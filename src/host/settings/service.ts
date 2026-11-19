/**
 * 普通设置的唯一写入口。
 *
 * 写入必须经过 Cordis 的 `configEditor.edit`：它校验候选配置、串行化 profile
 * 写入，并在成功后让 Loader 原地提交 volatile 引用。本服务只在写入成功后
 * 重读引用并发布新快照；任何校验或写入失败都保留旧快照。
 *
 * R2：本任务只校验渠道与稳定小写 slug 并持久化用户意图，账号记录是否存在
 * 由 Task 8 的 account-aware service 关闭。
 */
import {
  isChannelId,
  type ChannelId,
} from '../../shared/channels.ts'
import {
  assertSearchSettingsPatch,
  isStableChannelAccountId,
  SearchSettingsValidationError,
  type SearchSettingsPatch,
  type SearchSettingsSnapshot,
} from '../../shared/contracts.ts'
import type { SearchConfig } from '../config.ts'

/** 普通配置的原始嵌套对象。 */
type RawConfig = Record<string, unknown>

/** 取消信号在 configEditor 提交回调内生效；调用方应把本次写入视为已取消。 */
export class SettingsWriteCancelledError extends Error {
  readonly code = 'settings/cancelled'

  constructor() {
    super('设置写入已取消')
    this.name = 'SettingsWriteCancelledError'
  }
}

/** `configEditor.edit` 的变更回调。 */
type ConfigChange = (current: RawConfig, inherited: RawConfig) => RawConfig

/** 只依赖 ConfigEditor 的写入方法，便于测试与后续 Task 复用。 */
export interface SettingsConfigEditor {
  edit(entry: any, change: ConfigChange): Promise<void>
}

/** 构建设置服务所需依赖。 */
export interface SettingsServiceOptions {
  readonly configEditor: SettingsConfigEditor
  readonly entry: unknown
  /** `apply` 收到的有效配置；每个可热修改字段都是稳定引用。 */
  readonly config: SearchConfig
}

/** 普通设置快照服务。 */
export class SettingsService {
  private snapshot: SearchSettingsSnapshot

  constructor(private readonly options: SettingsServiceOptions) {
    this.snapshot = this.readSnapshot()
  }

  /** 当前已发布快照；只有成功写入才会替换。 */
  getSnapshot(): SearchSettingsSnapshot {
    return this.snapshot
  }

  /**
   * 合并搜索开关、渠道与 Qoder 国际版端点偏好。
   *
   * @param patch 只包含明确字段的平铺补丁。
   * @returns 成功重读后的新快照。
   * @throws {SearchSettingsValidationError} 补丁非法时。
   * @throws 配置写入失败时保留旧快照并向上抛出。
   */
  async updateSearch(patch: SearchSettingsPatch): Promise<SearchSettingsSnapshot> {
    assertSearchSettingsPatch(patch)
    await this.options.configEditor.edit(this.options.entry, (current) => {
      const base = isRecord(current) ? current : {}
      const nextSearch = isRecord(base.search) ? { ...base.search } : {}
      if (Object.hasOwn(patch, 'enabled')) nextSearch.enabled = patch.enabled
      if (Object.hasOwn(patch, 'channel')) nextSearch.channel = patch.channel
      const next: RawConfig = { ...base, search: nextSearch }
      if (Object.hasOwn(patch, 'endpointPreference')) {
        const qoder = isRecord(base.qoder) ? { ...base.qoder } : {}
        qoder.endpointPreference = patch.endpointPreference
        next.qoder = qoder
      }
      return next
    })
    return this.publish()
  }

  /**
   * 设置某个渠道的当前账号。
   *
   * @param channel 四个稳定渠道之一。
   * @param accountId 稳定小写 slug，或 null 表示暂不指定。
   * @returns 成功重读后的新快照。
   * @throws {SearchSettingsValidationError} 渠道或 slug 非法时。
   * @throws 配置写入失败时保留旧快照并向上抛出。
   */
  async setCurrentAccount(
    channel: ChannelId,
    accountId: string | null,
    signal?: AbortSignal,
  ): Promise<SearchSettingsSnapshot> {
    if (!isChannelId(channel)) {
      throw new SearchSettingsValidationError(`非法搜索渠道：${String(channel)}`)
    }
    if (accountId !== null && !isStableChannelAccountId(accountId)) {
      throw new SearchSettingsValidationError(`非法账号 slug：${String(accountId)}`)
    }
    if (signal?.aborted) throw new SettingsWriteCancelledError()
    await this.options.configEditor.edit(this.options.entry, (current) => {
      // 在 configEditor 的提交回调内、实际写入前再次检查；取消早于提交则不写。
      if (signal?.aborted) throw new SettingsWriteCancelledError()
      const base = isRecord(current) ? current : {}
      const existing = base[channel]
      const channelConfig = isRecord(existing) ? { ...existing } : {}
      channelConfig.currentAccountId = accountId
      return { ...base, [channel]: channelConfig }
    })
    return this.publish()
  }

  /** 重读稳定引用并发布不可变快照。 */
  private publish(): SearchSettingsSnapshot {
    this.snapshot = this.readSnapshot()
    return this.snapshot
  }

  /** 从 stable volatile 引用读取完整非秘密快照。 */
  private readSnapshot(): SearchSettingsSnapshot {
    const config = this.options.config
    return freezeSnapshot({
      search: {
        enabled: config.search.enabled.get(),
        channel: config.search.channel.get(),
      },
      buddy: { currentAccountId: config.buddy.currentAccountId.get() },
      workbuddy: { currentAccountId: config.workbuddy.currentAccountId.get() },
      qoder: {
        currentAccountId: config.qoder.currentAccountId.get(),
        endpointPreference: config.qoder.endpointPreference.get(),
      },
      qodercn: { currentAccountId: config.qodercn.currentAccountId.get() },
    })
  }
}

/** 判断普通数据对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 冻结快照的每一层，避免调用方改动服务内部状态。 */
function freezeSnapshot(snapshot: SearchSettingsSnapshot): SearchSettingsSnapshot {
  return Object.freeze({
    search: Object.freeze({ ...snapshot.search }),
    buddy: Object.freeze({ ...snapshot.buddy }),
    workbuddy: Object.freeze({ ...snapshot.workbuddy }),
    qoder: Object.freeze({ ...snapshot.qoder }),
    qodercn: Object.freeze({ ...snapshot.qodercn }),
  })
}
