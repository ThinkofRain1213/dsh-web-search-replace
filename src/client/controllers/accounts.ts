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
  isAuthUrlForChannel,
  type AuthFlowErrorCode,
  type AuthFlowState,
  type AuthFlowStatus,
} from '../../shared/auth.ts'
import type { ChannelId } from '../../shared/channels.ts'
import {
  callManagementRpc,
  type ManagementRpcConnection,
  type ManagementRpcMethod,
  type ManagementRpcPayloads,
  type ManagementRpcResults,
  type RpcResult,
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

/** 已接受但尚未开始执行的账号行操作。 */
export interface AccountsQueuedOperation {
  readonly id: number
  readonly kind: 'setCurrent' | 'reauth' | 'delete'
  readonly accountId: string
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
  /** 授权完成后的账号刷新在飞；刷新 settle 前禁止相互覆盖的写操作。 */
  readonly refreshBusy: boolean
  /** 已接受、等待前一项 settle 的顺序队列；按用户点击顺序执行。 */
  readonly queue: readonly AccountsQueuedOperation[]
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
  readonly refreshBusy?: boolean
  readonly queue?: readonly AccountsQueuedOperation[]
}

/** 队列内部条目：公开字段 + 执行/结算回调。 */
interface InternalQueuedOperation extends AccountsQueuedOperation {
  readonly execute: () => Promise<void>
  readonly resolve: () => void
}

/** 默认轮询间隔（毫秒）。 */
const DEFAULT_POLL_INTERVAL_MS = 1000

/** 判断普通数据对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 严格读取本渠道账号数组：任一项非法、夹带额外键或来自其他渠道，整次读取失败。
 *
 * 不能把坏数据过滤后宣告 ready；否则 Host 错接线/数据损坏会被伪装成“无账号”。
 */
function readAccounts(value: unknown, channel: ChannelId): readonly AccountSummary[] {
  if (!Array.isArray(value)) throw new TypeError('accounts.list 结果必须是数组')
  const accounts: AccountSummary[] = []
  for (const item of value) {
    if (!isAccountSummary(item) || item.channelId !== channel) {
      throw new TypeError('accounts.list 包含非法或跨渠道账号')
    }
    accounts.push(item)
  }
  return Object.freeze(accounts)
}

/** 严格读取当前账号：null 为合法未选择，非 null 必须合法且属于本渠道。 */
function readCurrent(value: unknown, channel: ChannelId): AccountSummary | null {
  if (value === null) return null
  if (!isAccountSummary(value) || value.channelId !== channel) {
    throw new TypeError('accounts.current 非法或跨渠道')
  }
  return value
}

/** current 非 null 时必须能对应本渠道列表中的同 id 账号。 */
function assertCurrentInList(
  current: AccountSummary | null,
  accounts: readonly AccountSummary[],
): void {
  if (current === null) return
  if (!accounts.some(account => account.id === current.id)) {
    throw new TypeError('accounts.current 不在本渠道列表中')
  }
}

/** 校验 accounts.delete 的集合结果；不在此处做请求目标关系校验。 */
function readCollection(value: unknown, channel: ChannelId): AccountCollection {
  if (!isRecord(value) || !Array.isArray(value.accounts)) {
    throw new TypeError('accounts.delete 结果必须是带 accounts 的对象')
  }
  const accounts = readAccounts(value.accounts, channel)
  const current = readCurrent(value.current, channel)
  return Object.freeze({ accounts, current })
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
    refreshBusy: false,
    queue: Object.freeze([]),
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
  private activeFlowId: string | null = null
  private readonly cancelledFlowIds = new Set<string>()
  private operationQueue: InternalQueuedOperation[] = []
  private queueRunning = false
  private queueSequence = 0
  private readonly rpcControllers = new Map<string, AbortController>()

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

  /** 每个 RPC 都有独立 AbortController；同 scope 新操作取消旧等待，dispose 全量 abort。 */
  private async callRpc<M extends ManagementRpcMethod>(
    scope: 'load' | 'auth' | 'action',
    method: M,
    payload: ManagementRpcPayloads[M],
  ): Promise<RpcResult<ManagementRpcResults[M]>> {
    const connection = this.connection
    if (connection === undefined) throw new Error('connection unavailable')
    this.rpcControllers.get(scope)?.abort()
    const controller = new AbortController()
    this.rpcControllers.set(scope, controller)
    try {
      return await callManagementRpc(connection, method, payload, controller.signal)
    } finally {
      if (this.rpcControllers.get(scope) === controller) this.rpcControllers.delete(scope)
    }
  }

  /**
   * 读取当前渠道的账号列表与当前账号；失败保留旧列表并显示错误。
   * @returns 是否成功发布了新的 ready 快照。
   */
  async reload(): Promise<boolean> {
    if (this.disposed) return false
    const connection = this.connection
    const generation = ++this.loadGeneration
    this.patch({
      status: this.state.accounts.length === 0 && this.state.current === null
        ? 'loading'
        : this.state.status,
    })
    if (connection === undefined) {
      this.patch({ status: 'error', error: 'channel.accounts.loadFailed' })
      return false
    }
    try {
      const listed = await this.callRpc('load', 'accounts.list', {
        channel: this.channel,
      })
      if (!this.activeLoad(generation)) return false
      if (!listed.ok) throw new Error('accounts.list failed')
      const accounts = readAccounts(listed.value, this.channel)

      const currentResult = await this.callRpc('load', 'accounts.current', {
        channel: this.channel,
      })
      if (!this.activeLoad(generation)) return false
      if (!currentResult.ok) throw new Error('accounts.current failed')
      const current = readCurrent(currentResult.value, this.channel)
      assertCurrentInList(current, accounts)

      this.patch({ status: 'ready', accounts, current, error: null })
      // completed 自身的 reload 期间 refreshBusy 仍为 true，drainQueue 会安全返回；
      // completed 分支清除 refreshBusy 后再按原路径 drain。手动重试成功时这里
      // 直接恢复既有已接受队列，无需额外 dismiss/新操作。
      void this.drainQueue()
      return true
    } catch {
      if (!this.activeLoad(generation)) return false
      this.patch({ status: 'error', error: 'channel.accounts.loadFailed' })
      return false
    }
  }

  /**
   * 显式选择当前账号；按点击顺序排队执行，不自动递补。
   * @param accountId - 目标账号稳定 ID。
   */
  async setCurrent(accountId: string): Promise<void> {
    if (this.state.current?.id === accountId) return
    return this.enqueueOperation('setCurrent', accountId, async () => {
      await this.performSetCurrent(accountId)
    })
  }

  /** 执行一次 setCurrent；只在队列轮到该操作时调用。 */
  private async performSetCurrent(accountId: string): Promise<void> {
    const connection = this.connection
    if (connection === undefined) return
    const target = this.state.accounts.find(account => account.id === accountId)
    if (target === undefined || this.state.current?.id === accountId) return

    const generation = ++this.actionGeneration
    this.patch({
      busyAccountId: accountId,
      busyAction: 'setCurrent',
      notice: null,
    })
    try {
      const result = await this.callRpc('action', 'accounts.setCurrent', {
        channel: this.channel,
        accountId,
      })
      if (!this.activeAction(generation)) return
      if (!result.ok) throw new Error('accounts.setCurrent failed')
      const current = readCurrent(result.value, this.channel)
      if (current === null || current.id !== accountId) {
        throw new Error('accounts.setCurrent returned a different account')
      }
      if (!this.state.accounts.some(account => account.id === accountId)) {
        throw new Error('accounts.setCurrent returned an account outside the list')
      }
      this.patch({ current, busyAccountId: null, busyAction: null, error: null })
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
    if (!this.state.accounts.some(account => account.id === accountId)) return
    return this.enqueueOperation('delete', accountId, async () => {
      await this.performDelete(accountId, replacementAccountId)
    })
  }

  /** 执行一次删除；只在队列轮到该操作时调用，并在当时重新计算当前账号关系。 */
  private async performDelete(
    accountId: string,
    replacementAccountId: string | null,
  ): Promise<void> {
    const connection = this.connection
    if (connection === undefined) return
    const target = this.state.accounts.find(account => account.id === accountId)
    if (target === undefined) return

    const deletingCurrent = this.state.current?.id === accountId
    const previousCurrent = this.state.current
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
      notice: null,
    })
    try {
      const result = await this.callRpc('action', 'accounts.delete', {
        channel: this.channel,
        accountId,
        ...(deletingCurrent ? { replacementAccountId: replacement } : {}),
      })
      if (!this.activeAction(generation)) return
      if (!result.ok) throw new Error('accounts.delete failed')
      const collection = readCollection(result.value, this.channel)
      this.assertDeleteRelation({
        accountId,
        deletingCurrent,
        previousCurrent,
        replacement,
        collection,
      })
      this.patch({
        accounts: collection.accounts,
        current: collection.current,
        busyAccountId: null,
        busyAction: null,
        error: null,
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

  /**
   * 校验删除回包与请求目标/替代账号/删除前当前账号的关系。
   * @param input - 请求意图与 Host 返回集合。
   */
  private assertDeleteRelation(input: {
    readonly accountId: string
    readonly deletingCurrent: boolean
    readonly previousCurrent: AccountSummary | null
    readonly replacement: string | null
    readonly collection: AccountCollection
  }): void {
    const { accountId, deletingCurrent, previousCurrent, replacement, collection } = input
    if (collection.accounts.some(account => account.id === accountId)) {
      throw new Error('accounts.delete returned the deleted account')
    }
    if (deletingCurrent) {
      if (replacement === null) {
        if (collection.current !== null) {
          throw new Error('accounts.delete auto-selected a replacement')
        }
        return
      }
      if (collection.current === null
        || collection.current.id !== replacement
        || !collection.accounts.some(account => account.id === replacement)) {
        throw new Error('accounts.delete did not apply the requested replacement')
      }
      return
    }
    if (previousCurrent === null) {
      if (collection.current !== null) {
        throw new Error('accounts.delete changed an unset current account')
      }
      return
    }
    if (collection.current === null
      || collection.current.id !== previousCurrent.id
      || !collection.accounts.some(account => account.id === previousCurrent.id)) {
      throw new Error('accounts.delete changed the current account')
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
      const result = await this.callRpc('action', 'accounts.clearAll', {})
      if (!this.activeAction(generation)) return
      if (!result.ok || !isRecord(result.value) || typeof result.value.cleared !== 'number') {
        throw new Error('accounts.clearAll failed')
      }
      this.patch({ clearBusy: false })
      const refreshed = await this.reload()
      if (!this.disposed && generation === this.actionGeneration && refreshed) {
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
    if (accountId === undefined) {
      if (!this.canAct()) return
      await this.performStartAuth(null)
      return
    }
    if (!this.state.accounts.some(account => account.id === accountId)) return
    return this.enqueueOperation('reauth', accountId, async () => {
      await this.performStartAuth(accountId)
    })
  }

  /** 执行一次授权启动；添加账号直接调用，重登由队列调用。 */
  private async performStartAuth(targetAccountId: string | null): Promise<void> {
    const connection = this.connection
    if (connection === undefined) return
    if (targetAccountId !== null
      && !this.state.accounts.some(account => account.id === targetAccountId)) return

    const generation = ++this.authGeneration
    this.clearPoll()
    this.activeFlowId = null
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
      const result = await this.callRpc(
        'auth',
        'auth.start',
        targetAccountId === null
          ? { channel: this.channel }
          : { channel: this.channel, accountId: targetAccountId },
      )
      if (!this.activeAuth(generation)) {
        // 卸载/切换后迟到的 start 可能已在 Host 创建流程；best-effort 取消返回的
        // pending flow，但不恢复 generation、不轮询、不写 UI/通知。
        if (result.ok
          && isAuthFlowStatusForChannel(result.value, this.channel)
          && result.value.status === 'pending') {
          this.bestEffortCancel(result.value.flowId)
        }
        return
      }
      if (!result.ok || !isAuthFlowStatusForChannel(result.value, this.channel)) {
        throw new Error('auth.start failed')
      }
      await this.applyAuthStatus(result.value, generation, null)
    } catch {
      if (!this.activeAuth(generation)) return
      this.clearPoll()
      this.activeFlowId = null
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
      void this.drainQueue()
    }
  }

  /** 取消当前等待中的授权；立即停止轮询并失效在飞 status。 */
  async cancelAuth(): Promise<void> {
    const expectedFlowId = this.state.auth.flowId
    if (this.disposed || expectedFlowId === null) return
    if (this.state.auth.phase !== 'pending') return
    const connection = this.connection
    if (connection === undefined) return

    const generation = ++this.authGeneration
    this.clearPoll()
    this.activeFlowId = null
    // 用户取消本身就是对原 flow 的清理；dispose 不得重复发第二次。
    this.cancelledFlowIds.add(expectedFlowId)
    this.patch({
      auth: { ...this.state.auth, phase: 'cancelling' },
      error: null,
    })
    try {
      const result = await this.callRpc('auth', 'auth.cancel', {
        channel: this.channel,
        flowId: expectedFlowId,
      })
      if (!this.activeAuth(generation)) return
      if (!result.ok || !isAuthFlowStatusForChannel(result.value, this.channel)) {
        throw new Error('auth.cancel failed')
      }
      if (result.value.flowId !== expectedFlowId) {
        this.failClosedAuth(expectedFlowId)
        return
      }
      if (result.value.status === 'pending') {
        throw new Error('auth.cancel did not terminate the flow')
      }
      await this.applyAuthStatus(result.value, generation, expectedFlowId)
    } catch {
      if (!this.activeAuth(generation)) return
      this.clearPoll()
      this.activeFlowId = null
      this.patch({
        error: 'channel.auth.cancelFailed',
        auth: {
          ...this.state.auth,
          phase: 'failed',
          authUrl: null,
          errorCode: null,
        },
      })
      void this.drainQueue()
    }
  }

  /**
   * 取消一个尚未开始的删除确认项；已开始执行的删除不可取消。
   * @param accountId - 目标账号。
   */
  cancelQueuedDelete(accountId: string): void {
    if (this.disposed) return
    const index = this.operationQueue.findIndex(
      operation => operation.kind === 'delete' && operation.accountId === accountId,
    )
    if (index < 0) return
    const [operation] = this.operationQueue.splice(index, 1)
    operation?.resolve()
    this.patch({})
  }

  /** 关闭终态授权提示；在飞授权不得被直接关闭。 */
  dismissAuth(): void {
    if (this.disposed || this.state.authBusy) return
    this.authGeneration += 1
    this.clearPoll()
    this.activeFlowId = null
    this.patch({
      auth: {
        phase: 'idle',
        flowId: null,
        authUrl: null,
        errorCode: null,
        targetAccountId: null,
      },
    })
    void this.drainQueue()
  }

  /** 释放订阅与定时器，并使全部在飞回包失效；best-effort 取消已知 pending flow。 */
  dispose(): void {
    if (this.disposed) return
    const pendingFlowId = this.activeFlowId
    this.disposed = true
    this.loadGeneration += 1
    this.authGeneration += 1
    this.actionGeneration += 1
    for (const controller of this.rpcControllers.values()) controller.abort()
    this.rpcControllers.clear()
    this.activeFlowId = null
    this.clearPoll()
    this.listeners.clear()
    const queued = this.operationQueue.splice(0)
    for (const operation of queued) operation.resolve()
    if (pendingFlowId !== null) this.bestEffortCancel(pendingFlowId)
  }

  /**
   * 对已知 flow 做一次 best-effort cancel；失败静默，不写 UI、不通知订阅者。
   * @param flowId - 本渠道待清理的授权 flow。
   */
  private bestEffortCancel(flowId: string): void {
    const connection = this.connection
    if (connection === undefined || this.cancelledFlowIds.has(flowId)) return
    this.cancelledFlowIds.add(flowId)
    try {
      // 独立、有界、at-most-once：不得使用刚被 dispose abort 的 scope controller。
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(1_000)])
      void callManagementRpc(connection, 'auth.cancel', {
        channel: this.channel,
        flowId,
      }, signal).catch(() => {})
    } catch {
      // flowId 非法等同步校验失败：没有可安全清理的流程。
    }
  }

  /**
   * 无效授权响应 fail closed：不保存 URL/错误 flow，停止轮询并只清理原 flow。
   * @param flowIdToCancel - 需要 best-effort 清理的原 flow；null 表示无已知待清理 flow。
   */
  private failClosedAuth(flowIdToCancel: string | null): void {
    if (this.disposed) return
    this.clearPoll()
    this.activeFlowId = null
    if (flowIdToCancel !== null) this.bestEffortCancel(flowIdToCancel)
    this.patch({
      error: null,
      auth: {
        phase: 'failed',
        flowId: null,
        authUrl: null,
        errorCode: 'auth/invalid-response',
        targetAccountId: this.state.auth.targetAccountId,
      },
    })
    void this.drainQueue()
  }

  /** 应用 Host 返回的授权状态；expectedFlowId 非空时必须与回包 flowId 精确一致。 */
  private async applyAuthStatus(
    status: AuthFlowStatus,
    generation: number,
    expectedFlowId: string | null,
  ): Promise<void> {
    if (!this.activeAuth(generation)) return
    if (expectedFlowId !== null && status.flowId !== expectedFlowId) {
      this.failClosedAuth(expectedFlowId)
      return
    }
    if (status.status === 'pending') {
      if (status.authUrl !== null
        && !isAuthUrlForChannel(status.authUrl, this.channel)) {
        this.failClosedAuth(status.flowId)
        return
      }
      this.activeFlowId = status.flowId
      this.clearPoll()
      this.patch({
        auth: {
          phase: 'pending',
          flowId: status.flowId,
          authUrl: status.authUrl,
          errorCode: status.errorCode,
          targetAccountId: this.state.auth.targetAccountId,
        },
      })
      this.schedulePoll(generation)
      return
    }

    this.clearPoll()
    this.activeFlowId = null
    const targetAccountId = this.state.auth.targetAccountId
    if (status.status === 'completed') {
      const account = status.account
      const validAccount = account !== null
        && account.channelId === this.channel
        && (targetAccountId === null || account.id === targetAccountId)
      if (!validAccount) {
        this.failClosedAuth(null)
        return
      }
      this.patch({
        auth: {
          phase: 'completed',
          flowId: status.flowId,
          authUrl: null,
          errorCode: status.errorCode,
          targetAccountId,
        },
        refreshBusy: true,
      })
      const refreshed = await this.reload()
      if (!this.disposed && generation === this.authGeneration) {
        this.patch({
          refreshBusy: false,
          ...(refreshed
            ? {
                notice: targetAccountId === null
                  ? 'channel.accounts.notice.added'
                  : 'channel.accounts.notice.reauthSucceeded',
              }
            : {}),
        })
        void this.drainQueue()
      }
      return
    }

    this.patch({
      auth: {
        phase: status.status,
        flowId: status.flowId,
        authUrl: null,
        errorCode: status.errorCode,
        targetAccountId,
      },
    })
    void this.drainQueue()
  }

  /** 安排下一次授权状态轮询。 */
  private schedulePoll(generation: number): void {
    this.clearPoll()
    this.pollTimer = setTimeout(() => {
      void this.pollAuth(generation)
    }, this.pollIntervalMs)
  }

  /** 查询一次授权状态；只有当前 generation 与 expectedFlowId 的结果可以继续。 */
  private async pollAuth(generation: number): Promise<void> {
    if (!this.activeAuth(generation)) return
    const expectedFlowId = this.state.auth.flowId
    const connection = this.connection
    if (expectedFlowId === null || connection === undefined) return
    try {
      const result = await this.callRpc('auth', 'auth.status', {
        channel: this.channel,
        flowId: expectedFlowId,
      })
      if (!this.activeAuth(generation)) return
      if (!result.ok || !isAuthFlowStatusForChannel(result.value, this.channel)) {
        throw new Error('auth.status failed')
      }
      if (result.value.flowId !== expectedFlowId) {
        this.failClosedAuth(expectedFlowId)
        return
      }
      await this.applyAuthStatus(result.value, generation, expectedFlowId)
    } catch {
      if (!this.activeAuth(generation)) return
      this.clearPoll()
      this.activeFlowId = null
      this.patch({
        error: 'channel.auth.statusFailed',
        auth: {
          ...this.state.auth,
          phase: 'failed',
          authUrl: null,
          errorCode: null,
        },
      })
      void this.drainQueue()
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

  /** 当前是否允许发起会立即执行的非队列操作（添加账号/清除全部）。 */
  private canAct(): boolean {
    return !this.disposed
      && this.connection !== undefined
      && this.state.status === 'ready'
      && !this.state.authBusy
      && !this.state.refreshBusy
      && this.state.busyAccountId === null
      && !this.state.clearBusy
      && !this.queueRunning
      && this.operationQueue.length === 0
  }

  /** 是否允许接受一个新的行操作进入顺序队列。 */
  private canEnqueue(): boolean {
    return !this.disposed
      && this.connection !== undefined
      && this.state.status === 'ready'
      && !this.state.authBusy
      && !this.state.refreshBusy
      && !this.state.clearBusy
  }

  /** 队列当前是否可以开始下一项。 */
  private canExecuteQueue(): boolean {
    return !this.disposed
      && this.connection !== undefined
      && this.state.status === 'ready'
      && !this.state.authBusy
      && !this.state.refreshBusy
      && !this.state.clearBusy
  }

  /** 判断同一行同一操作是否已在执行或排队。 */
  private isDuplicateOperation(
    kind: AccountsQueuedOperation['kind'],
    accountId: string,
  ): boolean {
    if (this.state.busyAccountId === accountId && this.state.busyAction === kind) return true
    return this.operationQueue.some(
      operation => operation.kind === kind && operation.accountId === accountId,
    )
  }

  /**
   * 接受一个账号行操作并按点击顺序排队；重复操作直接忽略（UI 同时会禁用重复入口）。
   * @param kind - 操作类型。
   * @param accountId - 目标账号。
   * @param execute - 轮到该项时执行的动作。
   * @returns 操作 settle 后 resolve。
   */
  private enqueueOperation(
    kind: AccountsQueuedOperation['kind'],
    accountId: string,
    execute: () => Promise<void>,
  ): Promise<void> {
    if (this.disposed || !this.canEnqueue() || this.isDuplicateOperation(kind, accountId)) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.operationQueue.push({
        id: ++this.queueSequence,
        kind,
        accountId,
        execute,
        resolve,
      })
      this.patch({})
      void this.drainQueue()
    })
  }

  /** 依次执行队列；authBusy/refreshBusy/清除在飞时暂停，settle 后继续。 */
  private async drainQueue(): Promise<void> {
    if (this.disposed || this.queueRunning || !this.canExecuteQueue()) return
    const operation = this.operationQueue.shift()
    if (operation === undefined) {
      if (this.state.queue.length > 0) this.patch({})
      return
    }
    this.queueRunning = true
    this.patch({})
    try {
      await operation.execute()
    } finally {
      this.queueRunning = false
      operation.resolve()
      if (!this.disposed) {
        this.patch({})
        void this.drainQueue()
      }
    }
  }

  /** 公开队列投影；内部 execute/resolve 不进入快照。 */
  private publicQueue(): readonly AccountsQueuedOperation[] {
    return Object.freeze(this.operationQueue.map(operation => Object.freeze({
      id: operation.id,
      kind: operation.kind,
      accountId: operation.accountId,
    })))
  }

  /** 合并状态并通知订阅者；authBusy 由授权阶段推导，queue 由内部队列推导。 */
  private patch(partial: AccountsStatePatch): void {
    if (this.disposed) return
    const auth = partial.auth ?? this.state.auth
    this.state = Object.freeze({
      ...this.state,
      ...partial,
      auth,
      authBusy: isAuthBusy(auth.phase),
      queue: partial.queue ?? this.publicQueue(),
    })
    for (const listener of [...this.listeners]) listener()
  }
}