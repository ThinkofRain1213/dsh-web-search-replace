/**
 * 腾讯系产品（CodeBuddy / WorkBuddy）共用的授权流程状态机。
 *
 * 本文件只复用**协议状态机与安全边界**：auth/state → 轮询 token → 轮询
 * account → 保存前能力探测 → 落码 → 首个账号设当前；以及刷新单飞、CAS、
 * 严格 401 重试、取消/dispose/迟到写入保护。
 *
 * 渠道隔离由实例状态保证：
 * - 每个产品 flow 实例各自持有 flows、pendingStarts、刷新 map、controller 与
 *   activeFlow；不存在跨产品共享的 currentAccount/credential/refresh 状态；
 * - 所有账号读写都使用构造时固定的 `channel`，绝不读取另一渠道记录；
 * - 产品参数（platform/endpoint/UA/authUrl host）与错误类/文案由产品 flow
 *   注入，本文件不内置任何产品常量。
 *
 * 本文件不注册 RPC、不创建账号服务、不自动启动授权；根组合由 Task 15 负责。
 */
import type { AccountSummary } from '../../../shared/accounts.ts'
import {
  isAuthFlowError,
  isAuthFlowId,
  type AuthChannel,
  type AuthFlowError,
  type AuthFlowErrorCode,
  type AuthFlowPort,
  type AuthFlowStartOptions,
  type AuthFlowState,
  type AuthFlowStatus,
} from '../../../shared/auth.ts'
import { isStableChannelAccountId } from '../../../shared/contracts.ts'
import { AccountError } from '../../accounts/errors.ts'
import type { AccountService } from '../../accounts/service.ts'
import type {
  AccountStore,
  StoredAccountEntry,
  StoredAccountRecord,
} from '../../accounts/store.ts'
import { ChannelSearchError } from '../../search/errors.ts'
import { combineAuthSignals, waitWithAuthAbort } from '../auth-abort.ts'
import { runCapabilityVerifierWithDeadline } from '../capability.ts'
import {
  SYSTEM_CLOCK,
  TencentExternalLinkClient,
  TencentExternalLinkError,
  readJwtClaim,
  type TencentAccount,
  type TencentExternalLinkClock,
  type TencentExternalLinkProduct,
  type TencentToken,
} from './auth-flow.ts'

/** 执行期访问令牌快照；只交给调用方操作，不进入 RPC。 */
export interface TencentAccessCredential<C extends AuthChannel> {
  readonly channelId: C
  readonly accountId: string
  readonly accessToken: string
}

/** 保存前能力探测的输入；不含 refreshToken 或账号秘密。 */
export interface TencentCapabilityCredential<C extends AuthChannel> {
  readonly channelId: C
  readonly accessToken: string
  readonly vendorAccountId: string
}

/**
 * 保存前 Search 能力探测。
 *
 * 必须是 Host-only、可注入且不可省略的依赖；Task 15 用真实产品搜索路径实现。
 * 探测失败/超时/取消时流程不得落码或设当前。
 */
export type TencentCapabilityVerifier<C extends AuthChannel> = (
  credential: TencentCapabilityCredential<C>,
  signal: AbortSignal,
) => Promise<void>

/** 产品授权流程依赖；全部网络/时钟/随机 ID 可注入。 */
export interface TencentProductAuthFlowOptions<C extends AuthChannel> {
  /** 本流程固定归属的顶层渠道。 */
  readonly channel: C
  /** 本产品固定的 external-link 参数；不随模型/账号变化。 */
  readonly product: TencentExternalLinkProduct
  readonly store: AccountStore
  readonly accounts: AccountService
  /** 测试注入；生产默认使用全局 fetch。 */
  readonly fetcher?: typeof fetch
  /** 测试注入；生产默认使用系统时钟。 */
  readonly clock?: TencentExternalLinkClock
  /** 测试注入；生产默认使用 crypto.randomUUID。 */
  readonly randomId?: () => string
  /** 轮询间隔；默认 1000ms。 */
  readonly pollIntervalMs?: number
  /** 整个授权流程的预算；默认 5 分钟。 */
  readonly authTimeoutMs?: number
  /** 单次普通请求超时；默认 60s。 */
  readonly requestTimeoutMs?: number
  /** auth/state 请求超时；默认 10s。 */
  readonly stateRequestTimeoutMs?: number
  /** 请求超时信号工厂；测试可注入永不触发的信号。 */
  readonly timeoutSignal?: (ms: number) => AbortSignal
  /** 展示说明；由产品 flow 提供固定文案。 */
  readonly displayHint: string
  /** 保存前 Search 能力探测；Host-only 且不可省略。 */
  readonly verifyCapability: TencentCapabilityVerifier<C>
  /**
   * 可选的授权 URL 装饰器；返回 undefined 表示装饰结果不可接受。
   * WorkBuddy 用它追加 version/loginSessionId；CodeBuddy 不提供。
   */
  readonly decorateAuthUrl?: (authUrl: string) => string | undefined
  /** 产品固定错误工厂；不得设置 cause。 */
  readonly errorFactory: (code: AuthFlowErrorCode) => AuthFlowError
}

/** 简单 deferred。 */
interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

/** 构造 deferred。 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** 一次授权流程的内部状态。 */
interface FlowState {
  readonly flowId: string
  readonly state: string
  readonly authUrl: string
  readonly displayHint: string
  readonly deadline: number
  readonly controller: AbortController
  readonly targetAccountId: string | undefined
  readonly targetVendorAccountId: string | undefined
  readonly done: Deferred<void>
  status: AuthFlowState
  account: AccountSummary | null
  errorCode: AuthFlowErrorCode | null
  cancelRequested: boolean
  terminal: boolean
}

/**
 * 腾讯系产品授权、刷新与重新登录流程。
 *
 * 泛型 `C` 只用于编译期区分渠道；运行时所有账号/配置写入都经构造参数
 * `channel`，实例之间不共享任何可变状态。
 */
export class TencentProductAuthFlow<C extends AuthChannel> implements AuthFlowPort {
  readonly channel: C
  private readonly store: AccountStore
  private readonly accounts: AccountService
  private readonly client: TencentExternalLinkClient
  private readonly clock: TencentExternalLinkClock
  private readonly randomId: () => string
  private readonly pollIntervalMs: number
  private readonly authTimeoutMs: number
  private readonly displayHint: string
  private readonly verifyCapability: TencentCapabilityVerifier<C>
  private readonly decorateAuthUrl: ((authUrl: string) => string | undefined) | undefined
  private readonly errorFactory: (code: AuthFlowErrorCode) => AuthFlowError

  private readonly flows = new Map<string, FlowState>()
  private readonly pendingStarts = new Set<Promise<unknown>>()
  private readonly pendingOperations = new Set<Promise<unknown>>()
  private readonly operationControllers = new Set<AbortController>()
  private readonly inFlightRefreshes = new Map<string, Promise<AccountSummary>>()
  private readonly refreshControllers = new Map<string, AbortController>()
  private activeFlow: FlowState | undefined
  private startController: AbortController | undefined
  private starting = false
  private disposed = false
  private disposePromise: Promise<void> | undefined

  constructor(options: TencentProductAuthFlowOptions<C>) {
    if (typeof options.verifyCapability !== 'function') {
      throw new TypeError('TencentProductAuthFlow requires a verifyCapability function')
    }
    this.channel = options.channel
    this.store = options.store
    this.accounts = options.accounts
    this.clock = options.clock ?? SYSTEM_CLOCK
    this.randomId = options.randomId ?? (() => globalThis.crypto.randomUUID())
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000
    this.authTimeoutMs = options.authTimeoutMs ?? 5 * 60 * 1000
    this.displayHint = options.displayHint
    this.verifyCapability = options.verifyCapability
    this.decorateAuthUrl = options.decorateAuthUrl
    this.errorFactory = options.errorFactory
    this.client = new TencentExternalLinkClient({
      product: options.product,
      clock: this.clock,
      ...options.fetcher === undefined ? {} : { fetcher: options.fetcher },
      ...options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
      ...options.stateRequestTimeoutMs === undefined
        ? {}
        : { stateRequestTimeoutMs: options.stateRequestTimeoutMs },
      ...options.timeoutSignal === undefined ? {} : { timeoutSignal: options.timeoutSignal },
    })
  }

  /** 固定文案的授权错误；产品错误类由 errorFactory 决定。 */
  private error(code: AuthFlowErrorCode): AuthFlowError {
    return this.errorFactory(code)
  }

  /**
   * 启动一次新增账号授权；提供 accountId 时走重新登录。
   *
   * 只由显式用户 RPC 调用；构造与状态查询都不会启动授权。
   */
  async start(options: AuthFlowStartOptions = {}): Promise<AuthFlowStatus> {
    this.assertNotDisposed()
    if (options.accountId !== undefined) return await this.reauthenticate(options.accountId)
    return await this.beginFlow(undefined)
  }

  /**
   * 对既有账号重新登录。
   *
   * 先验证目标账号存在于本渠道；成功后必须仍是同一厂商身份，否则失败且
   * 不覆盖原记录。重新登录不改变当前账号选择（目标原本是当前则保持）。
   */
  async reauthenticate(accountId: string): Promise<AuthFlowStatus> {
    this.assertNotDisposed()
    const controller = new AbortController()
    this.operationControllers.add(controller)
    const run = this.performReauthenticate(accountId, controller.signal)
    this.pendingOperations.add(run)
    try {
      return await run
    } finally {
      this.pendingOperations.delete(run)
      this.operationControllers.delete(controller)
    }
  }

  /** 重登预读与启动；预读也纳入 dispose 的在飞集合。 */
  private async performReauthenticate(
    accountId: string,
    signal: AbortSignal,
  ): Promise<AuthFlowStatus> {
    this.assertNotDisposed()
    if (!isStableChannelAccountId(accountId)) throw this.error('auth/invalid')
    let entry: StoredAccountEntry | undefined
    try {
      entry = await waitWithAuthAbort(
        this.store.readEntry(this.channel, accountId),
        signal,
        () => this.error(this.disposed ? 'auth/disposed' : 'auth/cancelled'),
      )
    } catch (error) {
      if (this.disposed || signal.aborted) this.throwIfOperationAborted(signal)
      throw this.error('auth/credential-unavailable')
    }
    this.assertNotDisposed()
    if (signal.aborted) throw this.error('auth/disposed')
    if (entry === undefined) throw this.error('auth/account-not-found')
    if (entry.account === undefined) throw this.error('auth/credential-unavailable')
    return await this.beginFlow(entry.account)
  }

  /** 查询指定流程的脱敏状态；未知 flowId 返回固定错误。 */
  async status(flowId: string): Promise<AuthFlowStatus> {
    const flow = this.requireFlow(flowId)
    return this.toStatus(flow)
  }

  /**
   * 取消指定流程。
   *
   * 立即把状态置为 cancelled 并 abort；等待后台轮询真正退出后才返回，因此
   * 取消返回后不会再出现本流程的账号/当前账号写入。终态流程幂等返回。
   */
  async cancel(flowId: string): Promise<AuthFlowStatus> {
    const flow = this.requireFlow(flowId)
    if (flow.terminal) return this.toStatus(flow)
    flow.cancelRequested = true
    flow.controller.abort()
    this.finishFlow(flow, 'cancelled', 'auth/cancelled')
    await flow.done.promise
    return this.toStatus(flow)
  }

  /**
   * 刷新指定账号的凭据。
   *
   * 同一账号单飞；刷新 token 轮换通过 `rotateSecret` 原子比较当前记录，旧刷新
   * 不会覆盖新记录。明确 401/403 标记 reauth_required；其他失败标记
   * temporarily_unavailable 并抛固定错误，不重试、不换账号。
   */
  async refresh(accountId: string, callerSignal?: AbortSignal): Promise<AccountSummary> {
    this.assertNotDisposed()
    if (!isStableChannelAccountId(accountId)) throw this.error('auth/invalid')
    if (callerSignal?.aborted) throw this.error('auth/cancelled')
    const existing = this.inFlightRefreshes.get(accountId)
    if (existing !== undefined) {
      return callerSignal === undefined
        ? await existing
        : await waitWithAuthAbort(existing, callerSignal, () => this.error('auth/cancelled'))
    }

    const controller = new AbortController()
    this.refreshControllers.set(accountId, controller)
    // R45：真实 run 只归 flow owner；首个 caller 不拥有全组取消权。
    const run = this.performRefresh(accountId, controller.signal)
    this.inFlightRefreshes.set(accountId, run)
    const cleanup = () => {
      if (this.inFlightRefreshes.get(accountId) === run) this.inFlightRefreshes.delete(accountId)
      if (this.refreshControllers.get(accountId) === controller) {
        this.refreshControllers.delete(accountId)
      }
    }
    // map/controller 只在真实 run settle 分支清理，绝不在 caller wait 的 finally 清理。
    void run.then(cleanup, cleanup)
    return callerSignal === undefined
      ? await run
      : await waitWithAuthAbort(run, callerSignal, () => this.error('auth/cancelled'))
  }

  /**
   * 执行一次需要账号凭据的操作；可信 HTTP 401 时刷新同账号并重试一次。
   *
   * 只有 `ChannelSearchError` 的 `UNAUTHORIZED`、`channel` 等于本 flow 渠道且
   * `httpStatus===401` 才触发刷新；超时、限流、403、无 HTTP 证据、跨渠道错误
   * 一律原样抛出，不刷新、不重试。
   */
  async runWithAuthRetry<T>(
    accountId: string,
    operation: (credential: TencentAccessCredential<C>, signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    this.assertNotDisposed()
    if (callerSignal?.aborted) throw this.error('auth/cancelled')
    const controller = new AbortController()
    this.operationControllers.add(controller)
    const signal = combineAuthSignals(controller.signal, callerSignal)
    const run = this.performAuthRetry(accountId, operation, signal, callerSignal)
    this.pendingOperations.add(run)
    try {
      return await run
    } finally {
      this.pendingOperations.delete(run)
      this.operationControllers.delete(controller)
    }
  }

  /** 401 重试的实际执行；每个 await 后检查 dispose，dispose 会 abort operation。 */
  private async performAuthRetry<T>(
    accountId: string,
    operation: (credential: TencentAccessCredential<C>, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const first = await this.resolveCredential(accountId, signal)
    this.throwIfOperationAborted(signal)

    try {
      const result = await operation(first, signal)
      this.throwIfOperationAborted(signal)
      return result
    } catch (error) {
      if (this.disposed || signal.aborted) this.throwIfOperationAborted(signal)
      if (!isTencentUnauthorized(error, this.channel)) throw error
    }

    await this.refresh(accountId, callerSignal)
    this.throwIfOperationAborted(signal)
    const second = await this.resolveCredential(accountId, signal)
    this.throwIfOperationAborted(signal)
    const result = await operation(second, signal)
    this.throwIfOperationAborted(signal)
    return result
  }

  /**
   * 停止接受新任务，取消在飞授权/刷新并等待全部 settle。
   *
   * 幂等；dispose 返回后迟到响应不会写账号或配置。已经完成的历史流程状态仍可
   * 通过 `status` 查询，但不会再有后台任务。
   */
  async dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return await this.disposePromise
    this.disposed = true
    // 第一个 await 之前同步 abort 全部来源，尤其 operation 内嵌 refresh；否则
    // pendingOperations 会等待一个尚未收到 abort 的 refresh，形成死锁。
    this.startController?.abort()
    for (const controller of this.operationControllers.values()) controller.abort()
    for (const controller of this.refreshControllers.values()) controller.abort()
    for (const flow of this.flows.values()) {
      if (flow.terminal) continue
      flow.cancelRequested = true
      flow.controller.abort()
      this.finishFlow(flow, 'cancelled', 'auth/cancelled')
    }
    this.disposePromise = (async () => {
      await Promise.allSettled([
        ...this.pendingStarts,
        ...this.pendingOperations,
        ...[...this.flows.values()].map((flow) => flow.done.promise),
        ...this.inFlightRefreshes.values(),
      ])
    })()
    return await this.disposePromise
  }

  /** 打开 auth/state 并启动后台轮询。 */
  private async beginFlow(target: StoredAccountRecord | undefined): Promise<AuthFlowStatus> {
    this.assertNotDisposed()
    if (this.starting || this.activeFlow !== undefined) throw this.error('auth/flow-active')
    this.starting = true
    const controller = new AbortController()
    this.startController = controller
    const run = this.openFlow(target, controller)
    this.pendingStarts.add(run)
    try {
      return await run
    } catch (error) {
      if (isAuthFlowError(error)) throw error
      throw this.error('auth/internal')
    } finally {
      this.pendingStarts.delete(run)
      if (this.startController === controller) this.startController = undefined
      this.starting = false
    }
  }

  /** 获取 auth/state；成功后创建流程并异步轮询。 */
  private async openFlow(
    target: StoredAccountRecord | undefined,
    controller: AbortController,
  ): Promise<AuthFlowStatus> {
    let state: { state: string; authUrl: string }
    try {
      state = await this.client.fetchAuthState(controller.signal)
    } catch (error) {
      throw this.error(mapStartErrorCode(error, this.disposed))
    }
    if (this.disposed) throw this.error('auth/disposed')
    if (controller.signal.aborted) throw this.error('auth/cancelled')

    const authUrl = this.decorate(state.authUrl)
    if (authUrl === undefined) throw this.error('auth/invalid-response')

    let rawFlowId: string
    try {
      rawFlowId = this.randomId()
    } catch {
      throw this.error('auth/internal')
    }
    if (!isAuthFlowId(rawFlowId)) throw this.error('auth/internal')
    if (this.flows.has(rawFlowId)) throw this.error('auth/internal')
    const flow: FlowState = {
      flowId: rawFlowId,
      state: state.state,
      authUrl,
      displayHint: this.displayHint,
      deadline: this.clock.now() + this.authTimeoutMs,
      controller,
      targetAccountId: target?.accountId,
      targetVendorAccountId: target?.vendorAccountId,
      done: deferred<void>(),
      status: 'pending',
      account: null,
      errorCode: null,
      cancelRequested: false,
      terminal: false,
    }
    this.activeFlow = flow
    this.rememberFlow(flow)
    void this.runFlow(flow)
    return this.toStatus(flow)
  }

  /** 执行产品注入的 authUrl 装饰；装饰失败按无效响应收口。 */
  private decorate(authUrl: string): string | undefined {
    if (this.decorateAuthUrl === undefined) return authUrl
    try {
      return this.decorateAuthUrl(authUrl)
    } catch {
      return undefined
    }
  }

  /** 后台轮询 token → account → 校验身份 → 能力探测 → 落码。 */
  private async runFlow(flow: FlowState): Promise<void> {
    try {
      const pollOptions = {
        signal: flow.controller.signal,
        deadline: flow.deadline,
        pollIntervalMs: this.pollIntervalMs,
      }
      const token = await this.client.pollToken(flow.state, pollOptions)
      this.ensureFlowActive(flow)
      const account = await this.client.pollAccount(flow.state, token, pollOptions)
      this.ensureFlowActive(flow)

      const vendorAccountId = resolveVendorAccountId(token, account, this.errorFactory)
      if (flow.targetVendorAccountId !== undefined
        && vendorAccountId !== flow.targetVendorAccountId) {
        throw this.error('auth/identity-mismatch')
      }
      if (this.clock.now() >= flow.deadline) throw this.error('auth/timeout')
      try {
        await runCapabilityVerifierWithDeadline(
          (signal) => this.verifyCapability(
            {
              channelId: this.channel,
              accessToken: token.accessToken,
              vendorAccountId,
            },
            signal,
          ),
          flow.controller.signal,
          flow.deadline,
          () => this.clock.now(),
        )
      } catch (error) {
        if (flow.cancelRequested || this.disposed) throw this.error('auth/cancelled')
        if (isTimeoutError(error)) throw this.error('auth/timeout')
        throw this.error('auth/failed')
      }
      this.ensureFlowActive(flow)
      if (this.clock.now() >= flow.deadline) throw this.error('auth/timeout')

      const displayName = resolveDisplayName(token, account)
      const hadUsableAccounts = await this.hasUsableAccounts()
      this.ensureFlowActive(flow)
      if (this.clock.now() >= flow.deadline) throw this.error('auth/timeout')

      const saved = await this.store.saveAccount({
        channel: this.channel,
        vendorAccountId,
        ...displayName === undefined ? {} : { displayName },
        status: 'ready',
        secret: buildSecret(token),
        signal: flow.controller.signal,
      })
      flow.account = toSummary(saved)

      // 取消/卸载若已先行，绝不继续写当前账号；状态保持 cancelled。
      if (flow.cancelRequested || this.disposed) return

      if (flow.targetAccountId === undefined && !hadUsableAccounts) {
        try {
          await this.accounts.setCurrent(this.channel, saved.accountId, flow.controller.signal)
        } catch {
          if (flow.cancelRequested || this.disposed) {
            this.finishFlow(flow, 'cancelled', 'auth/cancelled')
            return
          }
          this.finishFlow(flow, 'failed', 'auth/current-account-failed')
          return
        }
      }
      if (flow.cancelRequested || this.disposed) return
      this.finishFlow(flow, 'completed')
    } catch (error) {
      if (flow.cancelRequested || this.disposed) {
        this.finishFlow(flow, 'cancelled', 'auth/cancelled')
        return
      }
      if (isAuthFlowError(error)) {
        this.finishFlow(
          flow,
          error.code === 'auth/timeout' ? 'timed_out' : 'failed',
          error.code,
        )
        return
      }
      if (error instanceof AccountError) {
        this.finishFlow(flow, 'failed', 'auth/failed')
        return
      }
      const mapped = mapFlowError(error)
      this.finishFlow(flow, mapped.status, mapped.code)
    } finally {
      flow.done.resolve()
    }
  }

  /** 刷新实现；调用方已保证单飞。 */
  private async performRefresh(
    accountId: string,
    signal: AbortSignal,
  ): Promise<AccountSummary> {
    if (this.disposed) throw this.error('auth/disposed')
    let entry: StoredAccountEntry | undefined
    try {
      entry = await waitWithAuthAbort(
        this.store.readEntry(this.channel, accountId),
        signal,
        () => this.error(this.disposed ? 'auth/disposed' : 'auth/cancelled'),
      )
    } catch (error) {
      if (this.disposed || signal.aborted) this.throwIfOperationAborted(signal)
      throw this.error('auth/refresh-failed')
    }
    if (entry === undefined) throw this.error('auth/account-not-found')
    if (entry.account === undefined) throw this.error('auth/credential-unavailable')
    this.assertNotDisposed()
    if (signal.aborted) throw this.error('auth/disposed')
    const secret = entry.account.secret
    const accessToken = readSecretString(secret, 'accessToken')
    if (accessToken === undefined) throw this.error('auth/credential-unavailable')
    const refreshToken = readSecretString(secret, 'refreshToken') ?? ''

    if (refreshToken.length === 0) {
      await this.updateAccountState(accountId, refreshToken, 'reauth_required', signal)
      throw this.error('auth/reauth-required')
    }

    let token: TencentToken
    try {
      token = await this.client.refresh({ accessToken, refreshToken, signal })
    } catch (error) {
      if (this.disposed || signal.aborted) throw this.error('auth/disposed')
      if (error instanceof TencentExternalLinkError && error.code === 'reauth-required') {
        await this.updateAccountState(accountId, refreshToken, 'reauth_required', signal)
        throw this.error('auth/reauth-required')
      }
      await this.updateAccountState(accountId, refreshToken, 'temporarily_unavailable', signal)
      throw this.error('auth/refresh-failed')
    }

    if (this.disposed || signal.aborted) throw this.error('auth/disposed')

    let updated: StoredAccountRecord | undefined
    try {
      updated = await this.store.rotateSecret({
        channel: this.channel,
        accountId,
        expectedRefreshToken: refreshToken,
        secret: mergeRefreshedSecret(secret, token),
        status: 'ready',
        signal,
      })
    } catch {
      if (this.disposed || signal.aborted) this.throwIfOperationAborted(signal)
      throw this.error('auth/refresh-failed')
    }
    if (this.disposed || signal.aborted) throw this.error('auth/disposed')
    if (updated !== undefined) return toSummary(updated)

    // 当前记录已被更新（重新登录/另一次刷新/删除）：返回当前值，绝不覆盖。
    let current: StoredAccountEntry | undefined
    try {
      current = await waitWithAuthAbort(
        this.store.readEntry(this.channel, accountId),
        signal,
        () => this.error(this.disposed ? 'auth/disposed' : 'auth/cancelled'),
      )
    } catch {
      throw this.error('auth/refresh-failed')
    }
    if (this.disposed || signal.aborted) throw this.error('auth/disposed')
    if (current === undefined) throw this.error('auth/account-not-found')
    if (current.account === undefined) throw this.error('auth/credential-unavailable')
    return toSummary(current.account)
  }

  /** 刷新失败状态标记；仅当 refresh token 仍匹配时写，失败不掩盖原错误。 */
  private async updateAccountState(
    accountId: string,
    expectedRefreshToken: string,
    status: 'reauth_required' | 'temporarily_unavailable',
    signal: AbortSignal,
  ): Promise<void> {
    if (this.disposed || signal.aborted) this.throwIfOperationAborted(signal)
    try {
      await this.store.rotateSecret({
        channel: this.channel,
        accountId,
        expectedRefreshToken,
        status,
        signal,
      })
    } catch {
      if (this.disposed || signal.aborted) this.throwIfOperationAborted(signal)
      /* 其他状态标记失败是尽力而为；凭据错误仍是主结果。 */
    }
  }

  /** 读取账号执行期访问令牌。 */
  private async resolveCredential(
    accountId: string,
    signal: AbortSignal,
  ): Promise<TencentAccessCredential<C>> {
    this.throwIfOperationAborted(signal)
    if (!isStableChannelAccountId(accountId)) throw this.error('auth/invalid')
    let entry: StoredAccountEntry | undefined
    try {
      entry = await waitWithAuthAbort(
        this.store.readEntry(this.channel, accountId),
        signal,
        () => this.error(this.disposed ? 'auth/disposed' : 'auth/cancelled'),
      )
    } catch (error) {
      if (this.disposed || signal.aborted) this.throwIfOperationAborted(signal)
      throw this.error('auth/credential-unavailable')
    }
    if (entry === undefined) throw this.error('auth/account-not-found')
    if (entry.account === undefined) throw this.error('auth/credential-unavailable')
    this.throwIfOperationAborted(signal)
    const accessToken = readSecretString(entry.account.secret, 'accessToken')
    if (accessToken === undefined) throw this.error('auth/credential-unavailable')
    return Object.freeze({
      channelId: this.channel,
      accountId,
      accessToken,
    })
  }

  /** 是否存在本渠道可用账号；损坏记录或缺 accessToken 的记录不算「首个账号」。 */
  private async hasUsableAccounts(): Promise<boolean> {
    const entries = await this.store.listEntries(this.channel)
    return entries.some((entry) => entry.account !== undefined
      && readSecretString(entry.account.secret, 'accessToken') !== undefined)
  }

  /** dispose 与 caller cancel 使用不同固定码；两者都在继续工作前停止。 */
  private throwIfOperationAborted(signal: AbortSignal): void {
    this.assertNotDisposed()
    if (signal.aborted) throw this.error('auth/cancelled')
  }

  /** 断言未 dispose；dispose 后拒绝一切新授权/刷新任务。 */
  private assertNotDisposed(): void {
    if (this.disposed) throw this.error('auth/disposed')
  }

  /** 校验并取回流程。 */
  private requireFlow(flowId: string): FlowState {
    if (!isAuthFlowId(flowId)) throw this.error('auth/invalid')
    const flow = this.flows.get(flowId)
    if (flow === undefined) throw this.error('auth/flow-not-found')
    return flow
  }

  /** 轮询步骤前确认流程仍可写；取消/卸载时立即退出。 */
  private ensureFlowActive(flow: FlowState): void {
    if (this.disposed) throw this.error('auth/disposed')
    if (flow.cancelRequested || flow.controller.signal.aborted) {
      throw this.error('auth/cancelled')
    }
  }

  /** 记录最近流程；只淘汰已终态的最旧流程。 */
  private rememberFlow(flow: FlowState): void {
    this.flows.set(flow.flowId, flow)
    if (this.flows.size <= MAX_REMEMBERED_FLOWS) return
    for (const [flowId, candidate] of this.flows) {
      if (!candidate.terminal) continue
      this.flows.delete(flowId)
      return
    }
  }

  /** 置终态并释放 activeFlow；重复调用无副作用。 */
  private finishFlow(
    flow: FlowState,
    status: AuthFlowState,
    errorCode: AuthFlowErrorCode | null = null,
  ): void {
    if (flow.terminal) return
    flow.terminal = true
    flow.status = status
    flow.errorCode = errorCode
    if (this.activeFlow === flow) this.activeFlow = undefined
  }

  /** 投影为 Client 可见的七字段 DTO。 */
  private toStatus(flow: FlowState): AuthFlowStatus {
    return Object.freeze({
      flowId: flow.flowId,
      channel: this.channel,
      status: flow.status,
      authUrl: flow.authUrl,
      displayHint: flow.displayHint,
      account: flow.account,
      errorCode: flow.errorCode,
    })
  }
}

/** 保留最近多少个流程状态供 Client 查询。 */
const MAX_REMEMBERED_FLOWS = 16

/** 把 auth/state 阶段错误映射为固定授权错误码。 */
function mapStartErrorCode(error: unknown, disposed: boolean): AuthFlowErrorCode {
  if (disposed) return 'auth/disposed'
  if (error instanceof TencentExternalLinkError) {
    switch (error.code) {
      case 'cancelled':
        return 'auth/cancelled'
      case 'timeout':
        return 'auth/timeout'
      case 'invalid-response':
        return 'auth/invalid-response'
      case 'reauth-required':
        return 'auth/reauth-required'
      case 'request-timeout':
      case 'temporary':
      case 'failed':
        return 'auth/failed'
    }
  }
  return 'auth/internal'
}

/** 把轮询阶段错误映射为流程终态。 */
function mapFlowError(error: unknown): {
  readonly status: AuthFlowState
  readonly code: AuthFlowErrorCode
} {
  if (error instanceof TencentExternalLinkError) {
    switch (error.code) {
      case 'cancelled':
        return { status: 'cancelled', code: 'auth/cancelled' }
      case 'timeout':
        return { status: 'timed_out', code: 'auth/timeout' }
      case 'invalid-response':
        return { status: 'failed', code: 'auth/invalid-response' }
      case 'reauth-required':
        return { status: 'failed', code: 'auth/reauth-required' }
      case 'request-timeout':
      case 'temporary':
      case 'failed':
        return { status: 'failed', code: 'auth/failed' }
    }
  }
  return { status: 'failed', code: 'auth/internal' }
}

/** 明确 401 且同渠道才允许刷新重试。 */
function isTencentUnauthorized(error: unknown, channel: AuthChannel): boolean {
  return error instanceof ChannelSearchError
    && error.code === 'UNAUTHORIZED'
    && error.channel === channel
    && error.httpStatus === 401
}

/** 能力探测抛出的超时类错误；只用于固定错误映射，不读取原文。 */
function isTimeoutError(error: unknown): boolean {
  const record = typeof error === 'object' && error !== null
    ? error as { name?: unknown; code?: unknown }
    : {}
  return record.name === 'TimeoutError'
    || record.code === 'TOOL_TIMEOUT'
    || record.code === 'ETIMEDOUT'
}

/** 从 login/account 或 JWT sub 解析稳定厂商身份。 */
function resolveVendorAccountId(
  token: TencentToken,
  account: TencentAccount,
  errorFactory: (code: AuthFlowErrorCode) => AuthFlowError,
): string {
  const uid = account.uid.trim()
  if (uid.length > 0 && uid.length <= 256) return uid
  const subject = readJwtClaim(token.accessToken, 'sub')
  if (typeof subject === 'string') {
    const trimmed = stripControlChars(subject)
    if (trimmed.length > 0 && trimmed.length <= 256) return trimmed
  }
  throw errorFactory('auth/invalid-response')
}

/** 解析展示名：account.nickname → JWT 昵称；缺省交给账号库渠道名。 */
function resolveDisplayName(token: TencentToken, account: TencentAccount): string | undefined {
  const candidates: unknown[] = [
    account.nickname,
    readJwtClaim(token.accessToken, 'nickname'),
    readJwtClaim(token.accessToken, 'preferred_username'),
    readJwtClaim(token.accessToken, 'name'),
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const trimmed = stripControlChars(candidate).slice(0, 120)
    if (trimmed.length > 0) return trimmed
  }
  return undefined
}

/** 清理控制字符并折叠空白。 */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** 授权成功写入的秘密材料；只进入 credentials grant。 */
function buildSecret(token: TencentToken): Readonly<Record<string, unknown>> {
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    ...token.expiresAtMs === undefined ? {} : { expiresAtMs: token.expiresAtMs },
    ...token.refreshExpiresAtMs === undefined
      ? {}
      : { refreshExpiresAtMs: token.refreshExpiresAtMs },
    tokenType: token.tokenType,
    ...token.domain.length === 0 ? {} : { domain: token.domain },
  }
}

/** 合并刷新结果；后端未下发的新 refreshToken/domain 保留原值。 */
function mergeRefreshedSecret(
  current: Readonly<Record<string, unknown>>,
  token: TencentToken,
): Readonly<Record<string, unknown>> {
  return {
    ...current,
    accessToken: token.accessToken,
    ...token.refreshToken.length === 0 ? {} : { refreshToken: token.refreshToken },
    ...token.expiresAtMs === undefined ? {} : { expiresAtMs: token.expiresAtMs },
    ...token.refreshExpiresAtMs === undefined
      ? {}
      : { refreshExpiresAtMs: token.refreshExpiresAtMs },
    ...token.tokenType.length === 0 ? {} : { tokenType: token.tokenType },
    ...token.domain.length === 0 ? {} : { domain: token.domain },
  }
}

/** 读取非空秘密字符串。 */
function readSecretString(
  secret: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = secret[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** 内部记录 → Client DTO；只保留六个非秘密字段。 */
function toSummary(record: StoredAccountRecord): AccountSummary {
  return Object.freeze({
    id: record.accountId,
    displayName: record.displayName,
    channelId: record.channelId,
    endpointLabel: record.endpointLabel,
    status: record.status,
    maskedIdentifier: record.maskedIdentifier,
  })
}
