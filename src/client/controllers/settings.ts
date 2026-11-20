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
import { isHostRuntimeSnapshot, type QoderRuntimeHost } from '../../shared/runtime.ts'

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
  /** 仅 qoder+auto+page 激活时从 runtime.get 读取；其他情况始终 null。 */
  readonly actualEndpointHost: QoderRuntimeHost | null
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
  actualEndpointHost: null,
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
  private view: 'summary' | 'page' = 'summary'
  private writeController: AbortController | undefined
  private writeGeneration = 0
  private readonly unsubscribeConnection: (() => void) | undefined
  private runtimeActive = false
  private runtimeGeneration = 0
  private runtimeTimer: ReturnType<typeof setTimeout> | null = null
  private runtimeController: AbortController | undefined
  private runtimeActivationId: string | null = null
  private runtimeRevision = -1
  private actualEndpointHost: QoderRuntimeHost | null = null

  /**
   * @param options - configForms 与 Connection 的公开面。
   */
  constructor(options: SettingsControllerOptions) {
    this.connection = options.connection
    this.form = options.configForms?.get(PACKAGE_NAME)
    this.unsubscribeForm = this.form?.subscribe(() => { this.syncFromForm() })
    this.unsubscribeConnection = this.connection?.generation?.subscribe(() => {
      this.restartRuntimePolling()
    })
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

  /** 由 React view 驱动 runtime 激活门；constructor 不会无条件轮询。 */
  setView(view: 'summary' | 'page'): void {
    if (this.disposed || this.view === view) return
    this.view = view
    this.restartRuntimePolling()
  }

  /** 释放大订阅并丢弃迟到回包。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.writeGeneration += 1
    this.writeController?.abort()
    this.stopRuntimePolling()
    this.unsubscribeForm?.()
    this.unsubscribeConnection?.()
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
    const generation = ++this.writeGeneration
    const controller = new AbortController()
    this.writeController = controller
    this.busy = true
    this.error = null
    this.errorScope = null
    this.publish()
    try {
      const result = await callManagementRpc(connection, 'settings.update', { patch }, controller.signal)
      if (this.disposed || generation !== this.writeGeneration) return
      const next = result.ok ? decodeSettingsSnapshot(result.value) : null
      if (next === null) throw new Error('settings update did not return a valid snapshot')
      this.committed = next
      this.draft = { ...next.search }
      this.viewChannel = next.search.channel
      this.error = null
      this.errorScope = null
    } catch {
      if (this.disposed || generation !== this.writeGeneration) return
      this.error = 'settings.saveFailed'
      this.errorScope = scope
    } finally {
      if (this.writeController === controller) this.writeController = undefined
      if (!this.disposed && generation === this.writeGeneration) {
        this.busy = false
        this.publish()
      }
    }
  }

  /** 组装并发布一份新状态。 */
  private publish(): void {
    if (this.disposed) return
    const runtimeGeneration = this.updateRuntimeActivation()
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
      actualEndpointHost: this.actualEndpointHost,
    }
    for (const listener of [...this.listeners]) listener()
    if (runtimeGeneration !== null) void this.pollRuntime(runtimeGeneration)
  }

  private updateRuntimeActivation(): number | null {
    const active = this.view === 'page'
      && this.viewChannel === 'qoder'
      && this.committed?.qoder.endpointPreference === 'auto'
      && this.formStatus === 'ready'
      && this.connection !== undefined
    if (!active) {
      this.stopRuntimePolling()
      return null
    }
    if (this.runtimeActive) return null
    this.runtimeActive = true
    this.runtimeGeneration += 1
    return this.runtimeGeneration
  }

  private restartRuntimePolling(): void {
    if (this.disposed) return
    this.stopRuntimePolling()
    this.publish()
  }

  private stopRuntimePolling(): void {
    this.runtimeActive = false
    this.runtimeGeneration += 1
    if (this.runtimeTimer !== null) clearTimeout(this.runtimeTimer)
    this.runtimeTimer = null
    this.runtimeController?.abort()
    this.runtimeController = undefined
    this.runtimeActivationId = null
    this.runtimeRevision = -1
    this.actualEndpointHost = null
  }

  /** 顺序轮询：前一个 settle 后才安排下一次，绝不重叠或访问厂商。 */
  private async pollRuntime(generation: number): Promise<void> {
    const connection = this.connection
    if (connection === undefined || !this.runtimeActive || generation !== this.runtimeGeneration) return
    const controller = new AbortController()
    this.runtimeController = controller
    try {
      const result = await callManagementRpc(connection, 'runtime.get', {}, controller.signal)
      if (!this.runtimeActive || generation !== this.runtimeGeneration) return
      if (!result.ok || !isHostRuntimeSnapshot(result.value)) {
        throw new Error('runtime.get failed')
      }
      const snapshot = result.value
      if (snapshot.activationId !== this.runtimeActivationId) {
        this.runtimeActivationId = snapshot.activationId
        this.runtimeRevision = -1
        this.actualEndpointHost = null
      }
      if (snapshot.revision <= this.runtimeRevision) return
      this.runtimeRevision = snapshot.revision
      this.actualEndpointHost = snapshot.qoder.autoActualHost
    } catch {
      if (!this.runtimeActive || generation !== this.runtimeGeneration) return
      this.runtimeActivationId = null
      this.runtimeRevision = -1
      this.actualEndpointHost = null
    } finally {
      if (this.runtimeController === controller) this.runtimeController = undefined
      if (this.runtimeActive && generation === this.runtimeGeneration) {
        this.publish()
        this.runtimeTimer = setTimeout(() => {
          this.runtimeTimer = null
          void this.pollRuntime(generation)
        }, 2_000)
      }
    }
  }
}
