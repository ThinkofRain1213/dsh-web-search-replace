/**
 * 单渠道账号控制器（Task 14）。
 *
 * 职责边界：
 * - 只通过共享 `callManagementRpc` 调用 `accounts.*` 与 `auth.*`；绝不读取其他渠道
 *   的列表/当前账号，也不从其他渠道自动递补；
 * - 只保存 `AccountSummary` 六字段与 `AuthFlowStatus` 七字段中的非秘密投影，
 *   不保存 token/refresh/uid/PKCE；`authUrl` 只保留当前流程的 https 链接；
 * - 每个异步操作都带 generation：取消、完成、卸载、正常渠道切换后，迟到 RPC 与
 *   旧轮询不得更新 UI；
 * - 授权 `pending` 期间 `authBusy=true`，供设置卡锁定主渠道下拉；账号行操作只锁
 *   相关行。
 */
import type { AccountCollection, AccountSummary } from '../../shared/accounts.ts'
import {
  isAccountSummary,
  isAuthFlowStatusForChannel,
  type AuthFlowErrorCode,
  type AuthFlowState,
  type AuthFlowStatus,
} from '../../shared/auth.ts'
import type { ChannelId } from '../../shared/channels.ts'
import {
  callManagementRpc,
  type ManagementRpcConnection,
} from '../../shared/rpc.ts'

/** 账号 UI 的稳定错误键；组件按当前语言翻译。 */
export type AccountsErrorKey =
  | 'channel.accounts.loadFailed'
  | 'channel.accounts.setCurrentFailed'
  | 'channel.accounts.deleteFailed'
  | 'channel.accounts.clearFailed'
  | 'channel.auth.startFailed'
  | 'channel.auth.cancelFailed'
  | 'channel.auth.statusFailed'

/** 账号 UI 的稳定提示键；组件按当前语言翻译。 */
export type AccountsNoticeKey =
  | 'channel.accounts.notice.cleared'
  | 'channel.accounts.notice.added'
  | 'channel.accounts.notice.reauthSucceeded'

/** 授权流程的 UI 阶段；`pending` 之外都是终态。 */
export type AccountsAuthPhase = 'idle' | 'starting' | 'pending' | 'cancelling' | AuthFlowState

/** 当前授权流程的脱敏视图；不包含 displayHint / token / machine_id 字段。 */
export interface AccountsAuthView {
  readonly phase: AccountsAuthPhase
  readonly flowId: string | null
  readonly authUrl: string | null
  readonly errorCode: AuthFlowErrorCode | null
  /** 重新登录目标账号；null 表示添加新账号。 */
  readonly targetAccountId: string | null
}

/** 账号区渲染所需的完整状态。 */
export interface AccountsState {
  readonly channel: ChannelId
  readonly status: 'loading' | 'ready' | 'error'
  readonly accounts: readonly AccountSummary[]
  readonly current: AccountSummary | null
  readonly error: AccountsErrorKey | null
  readonly notice: AccountsNoticeKey | null
  readonly auth: AccountsAuthView
  /** 授权/重登在飞；设置卡据此锁定主渠道下拉。 */
  readonly authBusy: boolean
  /** 只锁相关账号行的操作目标。 */
  readonly busyAccountId: string | null
  readonly busyAction: 'setCurrent' | 'reauth' | 'delete' | null
  readonly clearBusy: boolean
}

/** 控制器依赖的 Host 边界。 */
export interface AccountsControllerOptions {
  readonly channel: ChannelId
  readonly connection?: ManagementRpcConnection | undefined
  /** 授权轮询间隔；测试可注入更短值。 */
  readonly pollIntervalMs?: number
}

/** 状态补丁。 */
interface AccountsStatePatch {
  readonly status?: AccountsState['status']
  readonly accounts?: readonly AccountSummary[]
  readonly current?: AccountSummary | null
  readonly error?: AccountsErrorKey | null
  readonly notice?: AccountsNoticeKey | null
  readonly auth?: AccountsAuthView
  readonly busyAccountId?: string | null
  readonly busyAction?: AccountsState['busyAction']
  readonly clearBusy?: boolean
}

/** 默认轮询间隔（毫秒）。 */
const DEFAULT_POLL_INTERVAL_MS = 1000

/** 判断普通数据对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只接受 Host 已校验的 https 授权链接；其他协议一律不展示/复制。 */
function readAuthUrl(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('https://') ? value : null
}

/** 过滤出属于当前渠道的六字段账号；非法或跨渠道记录直接丢弃。 */
function readAccounts(value: unknown, channel: ChannelId): readonly AccountSummary[] {
  if (!Array.isArray(value)) throw new TypeError('accounts.list 结果必须是数组')
  return Object.freeze(
    value.filter((item): item is AccountSummary => (
      isAccountSummary(item) && item.channelId === channel
    )),
  )
}

/** 只接受属于当前渠道的当前账号；跨渠道/非法值按未指定处理。 */
function readCurrent(value: unknown, channel: ChannelId): AccountSummary | null {
  if (value === null) return null
  return isAccountSummary(value) && value.channelId === channel ? value : null
}

/** 校验 accounts.delete 的集合结果。 */
function readCollection(value: unknown, channel: ChannelId): AccountCollection {
  if (!isRecord(value)) throw new TypeError('accounts.delete 结果必须是对象')
  const accounts = readAccounts(value.accounts, channel)
  const rawCurrent = value.current
  if (rawCurrent !== null && !isAccountSummary(rawCurrent)) {
    throw new TypeError('accounts.delete 的 current 非法')
  }
  return Object.freeze({
    accounts,
    current: rawCurrent === null || rawCurrent.channelId !== channel ? null : rawCurrent,
  })
}

/** 判断授权阶段是否应锁定主渠道下拉。 */
function isAuthBusy(phase: AccountsAuthPhase): boolean {
  return phase === 'starting' || phase === 'pending' || phase === 'cancelling'
}

/** 构造一个渠道的初始状态。 */
function initialState(channel: ChannelId): AccountsState {
  return Object.freeze({
    channel,
    status: 'loading',
    accounts: Object.freeze([]),
    current: null,
    error: null,
    notice: null,
    auth: Object.freeze({
      phase: 'idle' as AccountsAuthPhase,
      flowId: null,
      authUrl: null,
      errorCode: null,
      targetAccountId: null,
    }),
    authBusy: false,
    busyAccountId: null,
    busyAction: null,
    clearBusy: false,
  })
}

/** 单渠道账号控制器；实现 `useSyncExternalStore` 需要的稳定读取面。 */
export class AccountsController {
  private readonly channel: ChannelId
  private readonly connection: ManagementRpcConnection | undefined
  private readonly pollIntervalMs: number
  private readonly listeners = new Set<() => void>()
  private state: AccountsState
  private disposed = false
  private loadGeneration = 0
  private authGeneration = 0
  private actionGeneration = 0
  private pollTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * @param options - 渠道、Connection 与轮询间隔。
   */
  constructor(options: AccountsControllerOptions) {
    this.channel = options.channel
    this.connection = options.connection
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.state = initialState(options.channel)
  }

  /** @returns 当前不可变状态快照。 */
  readonly getSnapshot = (): AccountsState => this.state

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

  /** 读取当前渠道的账号列表与当前账号；失败保留旧列表并显示错误。 */
  async reload(): Promise<void> {
    if (this.disposed) return
    const connection = this.connection
    const generation = ++this.loadGeneration
    this.patch({
      status: this.state.accounts.length === 0 && this.state.current === null
        ? 'loading'
        : this.state.status,
    })
    if (connection === undefined) {
      this.patch({ status: 'error', error: 'channel.accounts.loadFailed' })
      return
    }
    try {
      const listed = await callManagementRpc(connection, 'accounts.list', {
        channel: this.channel,
      })
      if (!this.activeLoad(generation)) return
      if (!listed.ok) throw new Error('accounts.list failed')
      const accounts = readAccounts(listed.value, this.channel)

      const currentResult = await callManagementRpc(connection, 'accounts.current', {
        channel: this.channel,
      })
      if (!this.activeLoad(generation)) return
      if (!currentResult.ok) throw new Error('accounts.current failed')
      const current = readCurrent(currentResult.value, this.channel)

      this.patch({ status: 'ready', accounts, current, error: null })
    } catch {
      if (!this.activeLoad(generation)) return
      this.patch({ status: 'error', error: 'channel.accounts.loadFailed' })
    }
  }

  /**
   * 显式选择当前账号；不自动递补，也不改变其他渠道。
   * @param accountId - 目标账号稳定 ID。
   */
  async setCurrent(accountId: string): Promise<void> {
    if (!this.canAct() || this.state.current?.id === accountId) return
    const connection = this.connection
    if (connection === undefined) return
    const target = this.state.accounts.find(account => account.id === accountId)
    if (target === undefined) return

    const generation = ++this.actionGeneration
    this.patch({
      busyAccountId: accountId,
      busyAction: 'setCurrent',
      error: null,
      notice: null,
    })
    try {
      const result = await callManagementRpc(connection, 'accounts.setCurrent', {
        channel: this.channel,
        accountId,
      })
      if (!this.activeAction(generation)) return
      if (!result.ok) throw new Error('accounts.setCurrent failed')
      const current = readCurrent(result.value, this.channel)
      this.patch({ current, busyAccountId: null, busyAction: null })
    } catch {
      if (!this.activeAction(generation)) return
      this.patch({
        busyAccountId: null,
        busyAction: null,
        error: 'channel.accounts.setCurrentFailed',
      })
    }
  }

  /**
   * 删除账号；删除当前账号时必须显式给出替代账号或 null（暂不指定）。
   * @param accountId - 要删除的账号。
   * @param replacementAccountId - 删除当前账号时的替代账号；null 表示不指定。
   */
  async deleteAccount(
    accountId: string,
    replacementAccountId: string | null,
  ): Promise<void> {
    if (!this.canAct()) return
    const connection = this.connection
    if (connection === undefined) return
    const target = this.state.accounts.find(account => account.id === accountId)
    if (target === undefined) return

    const deletingCurrent = this.state.current?.id === accountId
    const replacement = deletingCurrent ? replacementAccountId : null
    if (replacement !== null
      && (replacement === accountId
        || !this.state.accounts.some(account => account.id === replacement))) {
      return
    }

    const generation = ++this.actionGeneration
    this.patch({
      busyAccountId: accountId,
      busyAction: 'delete',
      error: null,
      notice: null,
    })
    try {
      const result = await callManagementRpc(connection, 'accounts.delete', {
        channel: this.channel,
        accountId,
        ...(deletingCurrent ? { replacementAccountId: replacement } : {}),
      })
      if (!this.activeAction(generation)) return
      if (!result.ok) throw new Error('accounts.delete failed')
      const collection = readCollection(result.value, this.channel)
      this.patch({
        accounts: collection.accounts,
        current: collection.current,
        busyAccountId: null,
        busyAction: null,
      })
    } catch {
      if (!this.activeAction(generation)) return
      this.patch({
        busyAccountId: null,
        busyAction: null,
        error: 'channel.accounts.deleteFailed',
      })
    }
  }

  /** 清除四个渠道的全部账号数据；成功后重新读取当前渠道，不伪造其他渠道结果。 */
  async clearAll(): Promise<void> {
    if (!this.canAct()) return
    const connection = this.connection
    if (connection === undefined) return
    const generation = ++this.actionGeneration
    this.patch({ clearBusy: true, error: null, notice: null })
    try {
      const result = await callManagementRpc(connection, 'accounts.clearAll', {})
      if (!this.activeAction(generation)) return
      if (!result.ok || !isRecord(result.value) || typeof result.value.cleared !== 'number') {
        throw new Error('accounts.clearAll failed')
      }
      this.patch({ clearBusy: false })
      await this.reload()
      if (!this.disposed && generation === this.actionGeneration && this.state.status === 'ready') {
        this.patch({ notice: 'channel.accounts.notice.cleared' })
      }
    } catch {
      if (!this.activeAction(generation)) return
      this.patch({
        clearBusy: false,
        error: 'channel.accounts.clearFailed',
      })
    }
  }

  /**
   * 启动授权；提供 accountId 表示重新登录既有账号。
   * @param accountId - 重登目标账号；省略表示添加新账号。
   */
  async startAuth(accountId?: string): Promise<void> {
    if (!this.canAct()) return
    const connection = this.connection
    if (connection === undefined) return
    if (accountId !== undefined
      && !this.state.accounts.some(account => account.id === accountId)) return

    const targetAccountId = accountId ?? null
    const generation = ++this.authGeneration
    this.clearPoll()
    this.patch({
      error: null,
      notice: null,
      busyAccountId: null,
      busyAction: null,
      auth: {
        phase: 'starting',
        flowId: null,
        authUrl: null,
        errorCode: null,
        targetAccountId,
      },
    })
    try {
      const result = await callManagementRpc(
        connection,
        'auth.start',
        targetAccountId === null
          ? { channel: this.channel }
          : { channel: this.channel, accountId: targetAccountId },
      )
      if (!this.activeAuth(generation)) return
      if (!result.ok || !isAuthFlowStatusForChannel(result.value, this.channel)) {
        throw new Error('auth.start failed')
      }
      await this.applyAuthStatus(result.value, generation)
    } catch {
      if (!this.activeAuth(generation)) return
      this.clearPoll()
      this.patch({
        error: 'channel.auth.startFailed',
        auth: {
          phase: 'failed',
          flowId: null,
          authUrl: null,
          errorCode: null,
          targetAccountId,
        },
      })
    }
  }

  /** 取消当前等待中的授权；立即停止轮询并失效在飞 status。 */
  async cancelAuth(): Promise<void> {
    const flowId = this.state.auth.flowId
    if (this.disposed || flowId === null) return
    if (this.state.auth.phase !== 'pending') return
    const connection = this.connection
    if (connection === undefined) return

    const generation = ++this.authGeneration
    this.clearPoll()
    this.patch({
      auth: { ...this.state.auth, phase: 'cancelling' },
      error: null,
    })
    try {
      const result = await callManagementRpc(connection, 'auth.cancel', {
        channel: this.channel,
        flowId,
      })
      if (!this.activeAuth(generation)) return
      if (!result.ok
        || !isAuthFlowStatusForChannel(result.value, this.channel)
        || result.value.status === 'pending') {
        throw new Error('auth.cancel failed')
      }
      await this.applyAuthStatus(result.value, generation)
    } catch {
      if (!this.activeAuth(generation)) return
      this.clearPoll()
      this.patch({
        error: 'channel.auth.cancelFailed',
        auth: {
          ...this.state.auth,
          phase: 'failed',
          authUrl: null,
          errorCode: null,
        },
      })
    }
  }

  /** 关闭终态授权提示；在飞授权不得被直接关闭。 */
  dismissAuth(): void {
    if (this.disposed || this.state.authBusy) return
    this.authGeneration += 1
    this.clearPoll()
    this.patch({
      auth: {
        phase: 'idle',
        flowId: null,
        authUrl: null,
        errorCode: null,
        targetAccountId: null,
      },
    })
  }

  /** 释放订阅与定时器，并使全部在飞回包失效。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.loadGeneration += 1
    this.authGeneration += 1
    this.actionGeneration += 1
    this.clearPoll()
    this.listeners.clear()
  }

  /** 应用 Host 返回的授权状态；pending 继续轮询，终态停止。 */
  private async applyAuthStatus(status: AuthFlowStatus, generation: number): Promise<void> {
    if (!this.activeAuth(generation)) return
    if (status.status === 'pending') {
      this.patch({
        auth: {
          phase: 'pending',
          flowId: status.flowId,
          authUrl: readAuthUrl(status.authUrl),
          errorCode: status.errorCode,
          targetAccountId: this.state.auth.targetAccountId,
        },
      })
      this.schedulePoll(generation)
      return
    }

    this.clearPoll()
    const targetAccountId = this.state.auth.targetAccountId
    this.patch({
      auth: {
        phase: status.status,
        flowId: status.flowId,
        authUrl: null,
        errorCode: status.errorCode,
        targetAccountId,
      },
    })
    if (status.status !== 'completed') return

    const notice: AccountsNoticeKey = targetAccountId === null
      ? 'channel.accounts.notice.added'
      : 'channel.accounts.notice.reauthSucceeded'
    await this.reload()
    if (!this.disposed && generation === this.authGeneration) {
      this.patch({ notice })
    }
  }

  /** 安排下一次授权状态轮询。 */
  private schedulePoll(generation: number): void {
    this.clearPoll()
    this.pollTimer = setTimeout(() => {
      void this.pollAuth(generation)
    }, this.pollIntervalMs)
  }

  /** 查询一次授权状态；只有当前 generation 的结果可以继续。 */
  private async pollAuth(generation: number): Promise<void> {
    if (!this.activeAuth(generation)) return
    const flowId = this.state.auth.flowId
    const connection = this.connection
    if (flowId === null || connection === undefined) return
    try {
      const result = await callManagementRpc(connection, 'auth.status', {
        channel: this.channel,
        flowId,
      })
      if (!this.activeAuth(generation)) return
      if (!result.ok || !isAuthFlowStatusForChannel(result.value, this.channel)) {
        throw new Error('auth.status failed')
      }
      await this.applyAuthStatus(result.value, generation)
    } catch {
      if (!this.activeAuth(generation)) return
      this.clearPoll()
      this.patch({
        error: 'channel.auth.statusFailed',
        auth: {
          ...this.state.auth,
          phase: 'failed',
          authUrl: null,
          errorCode: null,
        },
      })
    }
  }

  /** 清空轮询定时器。 */
  private clearPoll(): void {
    if (this.pollTimer === null) return
    clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  /** 读取 generation 是否仍有效。 */
  private activeLoad(generation: number): boolean {
    return !this.disposed && generation === this.loadGeneration
  }

  /** 授权 generation 是否仍有效。 */
  private activeAuth(generation: number): boolean {
    return !this.disposed && generation === this.authGeneration
  }

  /** 行操作与清除 generation 是否仍有效。 */
  private activeAction(generation: number): boolean {
    return !this.disposed && generation === this.actionGeneration
  }

  /** 当前是否允许发起新的账号操作。 */
  private canAct(): boolean {
    return !this.disposed
      && this.connection !== undefined
      && this.state.status === 'ready'
      && !this.state.authBusy
      && this.state.busyAccountId === null
      && !this.state.clearBusy
  }

  /** 合并状态并通知订阅者；authBusy 始终由授权阶段推导。 */
  private patch(partial: AccountsStatePatch): void {
    if (this.disposed) return
    const auth = partial.auth ?? this.state.auth
    this.state = Object.freeze({
      ...this.state,
      ...partial,
      auth,
      authBusy: isAuthBusy(auth.phase),
    })
    for (const listener of [...this.listeners]) listener()
  }
}