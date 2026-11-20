/**
 * 设置卡控制器：读取 `configForms` 的单一设置快照，经共享 `settings.update`
 * RPC 写入。
 *
 * 视图只认一个真源：`search.channel`。写入在飞时只发布 busy 和旧值；成功后
 * 以 Host 返回快照原子更新 committed、下拉值和 `viewChannel`，失败只设置
 * 错误并保持旧值/旧视图，不做乐观预切换。
 */
import {
  isChannelId,
  isQoderEndpointPreference,
  type ChannelId,
  type QoderEndpointPreference,
} from '../../shared/channels.ts'
import {
  type SearchSettingsSnapshot,
  type SearchSettingsPatch,
} from '../../shared/contracts.ts'
import {
  callManagementRpc,
  type ManagementRpcConnection,
} from '../../shared/rpc.ts'
import { PACKAGE_NAME } from '../constants.ts'

/** configForms 快照的最小结构（与 Host 的 ConfigFormSnapshot 同形）。 */
export interface ConfigFormSnapshotLike<T> {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: T | undefined
  readonly base: unknown
  readonly user: unknown
  readonly revision: number | undefined
  readonly writable: boolean
}

/** 设置命名空间的只读订阅面。 */
export interface ConfigFormLike<T> {
  getSnapshot(): ConfigFormSnapshotLike<T>
  subscribe(listener: () => void): () => void
}

/** Client 侧 configForms 服务的最小面。 */
export interface ConfigFormsLike {
  get(entryId: string): ConfigFormLike<unknown>
}

/** 保存失败的稳定错误键，由卡片翻译成当前语言。 */
export type SettingsErrorKey = 'settings.saveFailed'

/** 保存失败归属；端点错误只显示在端点行，不污染渠道行。 */
export type SettingsErrorScope = 'enabled' | 'channel' | 'endpoint' | null

/** 设置卡渲染所需的全部状态。 */
export interface SettingsCardState {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly enabled: boolean
  readonly channel: ChannelId
  /** 只有保存成功后才更新的当前配置区渠道。 */
  readonly viewChannel: ChannelId
  readonly settings: SearchSettingsSnapshot | null
  readonly busy: boolean
  readonly writable: boolean
  readonly error: SettingsErrorKey | null
  /** 最近一次失败属于哪个控件；成功或未失败时为 null。 */
  readonly errorScope: SettingsErrorScope
}

/** 控制器依赖的 Host 边界。 */
export interface SettingsControllerOptions {
  readonly configForms?: ConfigFormsLike | undefined
  readonly connection?: ManagementRpcConnection | undefined
}

/** 判断普通数据对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读取可空账号 id；非法类型按未配置处理。 */
function readAccountId(value: unknown): string | null {
  if (!isRecord(value)) return null
  return typeof value.currentAccountId === 'string' ? value.currentAccountId : null
}

/**
 * 把 configForms 的普通配置节解码为严格快照。
 * @param value - 设置命名空间的当前值。
 * @returns 完整快照；关键字段非法时返回 null。
 */
export function decodeSettingsSnapshot(value: unknown): SearchSettingsSnapshot | null {
  if (!isRecord(value) || !isRecord(value.search)) return null
  const { enabled, channel } = value.search
  if (typeof enabled !== 'boolean' || !isChannelId(channel)) return null

  const qoder = isRecord(value.qoder) ? value.qoder : {}
  return {
    search: { enabled, channel },
    buddy: { currentAccountId: readAccountId(value.buddy) },
    workbuddy: { currentAccountId: readAccountId(value.workbuddy) },
    qoder: {
      currentAccountId: readAccountId(qoder),
      endpointPreference: isQoderEndpointPreference(qoder.endpointPreference)
        ? qoder.endpointPreference
        : 'auto',
    },
    qodercn: { currentAccountId: readAccountId(value.qodercn) },
  }
}

/** 未就绪时的稳定默认值。 */
const INITIAL_STATE: SettingsCardState = Object.freeze({
  status: 'loading',
  enabled: false,
  channel: 'buddy',
  viewChannel: 'buddy',
  settings: null,
  busy: false,
  writable: false,
  error: null,
  errorScope: null,
})

/** 设置卡状态控制器；实现 React `useSyncExternalStore` 需要的稳定读取面。 */
export class SettingsController {
  private readonly form: ConfigFormLike<unknown> | undefined
  private readonly connection: ManagementRpcConnection | undefined
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribeForm: (() => void) | undefined
  private state: SettingsCardState = INITIAL_STATE
  private committed: SearchSettingsSnapshot | null = null
  private draft: { enabled: boolean; channel: ChannelId } = {
    enabled: false,
    channel: 'buddy',
  }
  private viewChannel: ChannelId = 'buddy'
  private formStatus: 'loading' | 'ready' | 'unavailable' = 'loading'
  private writable = false
  private busy = false
  private error: SettingsErrorKey | null = null
  private errorScope: SettingsErrorScope = null
  private disposed = false

  /**
   * @param options - configForms 与 Connection 的公开面。
   */
  constructor(options: SettingsControllerOptions) {
    this.connection = options.connection
    this.form = options.configForms?.get(PACKAGE_NAME)
    this.unsubscribeForm = this.form?.subscribe(() => { this.syncFromForm() })
    this.syncFromForm()
  }

  /** @returns 当前不可变状态快照。 */
  readonly getSnapshot = (): SettingsCardState => this.state

  /**
   * 订阅状态替换。
   * @param listener - 状态变化回调。
   * @returns 取消订阅。
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 请求开关目标状态；写入成功后才以 Host 快照为准。
   * @param next - 目标开关状态。
   * @returns 本次写入完成或被视为重复/锁定而跳过。
   */
  async setEnabled(next: boolean): Promise<void> {
    if (!this.canWrite() || next === this.committed?.search.enabled) return
    await this.write({ enabled: next }, 'enabled')
  }

  /**
   * 请求渠道目标值；配置区只在成功回包后切换。
   * @param next - 目标渠道。
   * @returns 本次写入完成或被视为重复/锁定而跳过。
   */
  async selectChannel(next: ChannelId): Promise<void> {
    if (!this.canWrite() || next === this.committed?.search.channel) return
    await this.write({ channel: next }, 'channel')
  }

  /**
   * 请求 Qoder 国际版端点偏好；pending 保持旧值，成功后才采用 Host 快照。
   * @param next - 目标端点偏好。
   * @returns 本次写入完成或被视为重复/锁定而跳过。
   */
  async setEndpointPreference(next: QoderEndpointPreference): Promise<void> {
    if (!this.canWrite() || next === this.committed?.qoder.endpointPreference) return
    await this.write({ endpointPreference: next }, 'endpoint')
  }

  /** 释放大订阅并丢弃迟到回包。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeForm?.()
    this.listeners.clear()
  }

  /** 从 configForms 快照同步唯一设置真源。 */
  private syncFromForm(): void {
    if (this.disposed) return
    if (this.form === undefined) {
      this.formStatus = 'loading'
      this.writable = false
      this.committed = null
      this.publish()
      return
    }

    const snapshot = this.form.getSnapshot()
    this.writable = snapshot.writable
    if (snapshot.status !== 'ready' || snapshot.value === undefined) {
      this.formStatus = snapshot.status === 'unavailable' ? 'unavailable' : 'loading'
      this.committed = null
      this.publish()
      return
    }

    const decoded = decodeSettingsSnapshot(snapshot.value)
    if (decoded === null) {
      this.formStatus = 'unavailable'
      this.committed = null
      this.publish()
      return
    }

    this.formStatus = 'ready'
    this.committed = decoded
    if (!this.busy) {
      this.draft = { ...decoded.search }
      this.viewChannel = decoded.search.channel
    }
    this.publish()
  }

  /** 是否有资格发起写入。 */
  private canWrite(): boolean {
    return !this.disposed
      && !this.busy
      && this.formStatus === 'ready'
      && this.committed !== null
      && this.writable
      && this.connection !== undefined
  }

  /**
   * 执行一次设置写入；pending 只发布 busy，成功后原子切换，失败只设置错误。
   * @param patch - 平铺设置补丁。
   * @param scope - 失败归属控件。
   */
  private async write(patch: SearchSettingsPatch, scope: SettingsErrorScope): Promise<void> {
    const connection = this.connection
    if (connection === undefined) return
    this.busy = true
    this.error = null
    this.errorScope = null
    this.publish()
    try {
      const result = await callManagementRpc(connection, 'settings.update', { patch })
      if (this.disposed) return
      const next = result.ok ? decodeSettingsSnapshot(result.value) : null
      if (next === null) throw new Error('settings update did not return a valid snapshot')
      this.committed = next
      this.draft = { ...next.search }
      this.viewChannel = next.search.channel
      this.error = null
      this.errorScope = null
    } catch {
      if (this.disposed) return
      this.error = 'settings.saveFailed'
      this.errorScope = scope
    } finally {
      if (!this.disposed) {
        this.busy = false
        this.publish()
      }
    }
  }

  /** 组装并发布一份新状态。 */
  private publish(): void {
    if (this.disposed) return
    const status = this.formStatus === 'ready' && this.committed !== null
      ? 'ready'
      : this.formStatus === 'unavailable'
        ? 'unavailable'
        : 'loading'
    this.state = {
      status,
      enabled: this.draft.enabled,
      channel: this.draft.channel,
      viewChannel: this.viewChannel,
      settings: this.committed,
      busy: this.busy,
      writable: this.writable && status === 'ready',
      error: this.error,
      errorScope: this.errorScope,
    }
    for (const listener of [...this.listeners]) listener()
  }
}
