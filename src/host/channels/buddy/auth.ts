/**
 * CodeBuddy 独立授权、刷新与重新登录流程。
 *
 * 本文件只属于 `buddy` 渠道：
 * - 产品参数固定为 CodeBuddy（platform=ide、copilot.tencent.com、CodeBuddy UA），
 *   绝不读取或写入 WorkBuddy 的产品、账号、当前账号或刷新状态；
 * - 成功授权只经 `AccountStore.saveAccount` 写本插件 buddy grant；
 * - 首个可用账号经 `AccountService.setCurrent` 设为当前，后续账号不自动切换；
 * - 刷新按账号单飞，轮换经 `AccountStore.rotateSecret` 的原子 compare-and-set，
 *   迟到/旧刷新不会覆盖新记录；
 * - 只有明确 `UNAUTHORIZED` 且渠道为 buddy 的错误，才允许刷新同一账号并重试
 *   原操作一次；其他错误不重试、不换账号/渠道。
 *
 * 授权与重新登录只能由显式方法/RPC 触发：构造函数不启动任何任务，也不注册
 * Agent tool。取消、超时与 dispose 会 abort 在飞请求并等待 settle；状态与错误
 * 只含固定码和脱敏 DTO，不含 token、secret、上游正文或异常原文。
 */
import type { AccountSummary } from '../../../shared/accounts.ts'
import {
  BUDDY_AUTH_CHANNEL,
  isAuthFlowId,
  type AuthFlowErrorCode,
  type AuthFlowState,
  type AuthFlowStatus,
} from '../../../shared/auth.ts'
import { isStableChannelAccountId } from '../../../shared/contracts.ts'
import type { ChannelId } from '../../../shared/channels.ts'
import { AccountError } from '../../accounts/errors.ts'
import type { AccountService } from '../../accounts/service.ts'
import type {
  AccountStore,
  StoredAccountEntry,
  StoredAccountRecord,
} from '../../accounts/store.ts'
import { ChannelSearchError } from '../../search/errors.ts'
import {
  SYSTEM_CLOCK,
  TencentExternalLinkClient,
  TencentExternalLinkError,
  readJwtClaim,
  type TencentAccount,
  type TencentExternalLinkClock,
  type TencentExternalLinkProduct,
  type TencentToken,
} from '../tencent/auth-flow.ts'

/** 本流程固定归属的渠道。 */
const CHANNEL: ChannelId = BUDDY_AUTH_CHANNEL

/** CodeBuddy 的固定 external-link 产品参数；不随模型/账号变化。 */
export const BUDDY_AUTH_PRODUCT: TencentExternalLinkProduct = Object.freeze({
  platform: 'ide',
  endpoint: 'https://copilot.tencent.com',
  apiDomain: 'copilot.tencent.com',
  userAgent: 'CodeBuddyIDE/1.106.1',
  // 真实样本只出现这两个精确 host；不做后缀匹配，其他域名一律 invalid-response。
  authUrlHosts: Object.freeze(['www.codebuddy.cn', 'copilot.tencent.com']),
})

/** 默认展示说明；不含账号身份或任何秘密。 */
const DEFAULT_DISPLAY_HINT = '在浏览器中完成 CodeBuddy 登录后返回，插件会自动完成授权。'

/** 保留最近多少个流程状态供 Client 查询。 */
const MAX_REMEMBERED_FLOWS = 16

/** 授权流程错误码到固定文案。 */
const ERROR_MESSAGES: Readonly<Record<AuthFlowErrorCode, string>> = Object.freeze({
  'auth/invalid': 'CodeBuddy 授权请求非法',
  'auth/flow-active': '已有进行中的 CodeBuddy 授权流程',
  'auth/flow-not-found': '未找到指定的 CodeBuddy 授权流程',
  'auth/timeout': 'CodeBuddy 授权已超时',
  'auth/cancelled': 'CodeBuddy 授权已取消',
  'auth/failed': 'CodeBuddy 授权失败',
  'auth/invalid-response': 'CodeBuddy 授权响应无效',
  'auth/disposed': 'CodeBuddy 授权流程已停止',
  'auth/account-not-found': '该渠道下不存在指定账号',
  'auth/credential-unavailable': '账号凭据记录不可用，请重新登录',
  'auth/identity-mismatch': '重新登录的账号身份与目标账号不一致',
  'auth/reauth-required': 'CodeBuddy 凭据已失效，请重新登录',
  'auth/refresh-failed': 'CodeBuddy 凭据刷新失败',
  'auth/current-account-failed': 'CodeBuddy 账号已保存，但未能设为当前账号',
  'auth/internal': 'CodeBuddy 授权内部错误',
})

/** 授权域错误；`cause` 永远不设置，避免秘密沿错误链泄漏。 */
export class BuddyAuthError extends Error {
  override readonly name = 'BuddyAuthError'

  constructor(
    readonly code: AuthFlowErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** 构造一个固定文案的授权错误。 */
function authError(code: AuthFlowErrorCode): BuddyAuthError {
  return new BuddyAuthError(code, ERROR_MESSAGES[code])
}

/** 执行期访问令牌快照；只交给调用方操作，不进入 RPC。 */
export interface BuddyAccessCredential {
  readonly channelId: 'buddy'
  readonly accountId: string
  readonly accessToken: string
}

/** 保存前能力探测的输入；不含 refreshToken 或账号秘密。 */
export interface BuddyCapabilityCredential {
  readonly channelId: 'buddy'
  readonly accessToken: string
  readonly vendorAccountId: string
}

/**
 * 保存前 Search 能力探测。
 *
 * 必须是 Host-only、可注入且不可省略的依赖；Task 15 用真实 CodeBuddy 搜索
 * 路径实现。探测失败/超时/取消时流程不得落码或设当前。
 */
export type BuddyCapabilityVerifier = (
  credential: BuddyCapabilityCredential,
  signal: AbortSignal,
) => Promise<void>

/** `start` 的选项；提供 accountId 时等价于重新登录。 */
export interface BuddyStartOptions {
  readonly accountId?: string
}

/** 授权流程依赖；全部网络/时钟/随机 ID 可注入。 */
export interface BuddyAuthFlowOptions {
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
  /** 展示说明；默认固定中文说明。 */
  readonly displayHint?: string
  /**
   * 保存前 Search 能力探测；Host-only 且不可省略。Task 15 必须提供真实
   * CodeBuddy 搜索路径；失败/超时/取消都不得落码或设当前。
   */
  readonly verifyCapability: BuddyCapabilityVerifier
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

/** CodeBuddy 授权、刷新与重新登录流程。 */
export class BuddyAuthFlow {
  private readonly store: AccountStore
  private readonly accounts: AccountService
  private readonly client: TencentExternalLinkClient
  private readonly clock: TencentExternalLinkClock
  private readonly randomId: () => string
  private readonly pollIntervalMs: number
  private readonly authTimeoutMs: number
  private readonly displayHint: string
  private readonly verifyCapability: BuddyCapabilityVerifier

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

  constructor(options: BuddyAuthFlowOptions) {
    if (typeof options.verifyCapability !== 'function') {
      throw new TypeError('BuddyAuthFlow requires a verifyCapability function')
    }
    this.store = options.store
    this.accounts = options.accounts
    this.clock = options.clock ?? SYSTEM_CLOCK
    this.randomId = options.randomId ?? (() => globalThis.crypto.randomUUID())
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000
    this.authTimeoutMs = options.authTimeoutMs ?? 5 * 60 * 1000
    this.displayHint = options.displayHint ?? DEFAULT_DISPLAY_HINT
    this.verifyCapability = options.verifyCapability
    this.client = new TencentExternalLinkClient({
      product: BUDDY_AUTH_PRODUCT,
      clock: this.clock,
      ...options.fetcher === undefined ? {} : { fetcher: options.fetcher },
      ...options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
      ...options.stateRequestTimeoutMs === undefined
        ? {}
        : { stateRequestTimeoutMs: options.stateRequestTimeoutMs },
      ...options.timeoutSignal === undefined ? {} : { timeoutSignal: options.timeoutSignal },
    })
  }

  /**
   * 启动一次新增账号授权；提供 accountId 时走重新登录。
   *
   * 只由显式用户 RPC 调用；构造与状态查询都不会启动授权。
   */
  async start(options: BuddyStartOptions = {}): Promise<AuthFlowStatus> {
    this.assertNotDisposed()
    if (options.accountId !== undefined) return await this.reauthenticate(options.accountId)
    return await this.beginFlow(undefined)
  }

  /**
   * 对既有账号重新登录。
   *
   * 先验证目标账号存在于 buddy 渠道；成功后必须仍是同一厂商身份，否则失败且
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
    if (!isStableChannelAccountId(accountId)) throw authError('auth/invalid')
    let entry: StoredAccountEntry | undefined
    try {
      entry = await this.store.readEntry(CHANNEL, accountId)
    } catch {
      throw authError('auth/credential-unavailable')
    }
    this.assertNotDisposed()
    if (signal.aborted) throw authError('auth/disposed')
    if (entry === undefined) throw authError('auth/account-not-found')
    if (entry.account === undefined) throw authError('auth/credential-unavailable')
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
  async refresh(accountId: string): Promise<AccountSummary> {
    this.assertNotDisposed()
    if (!isStableChannelAccountId(accountId)) throw authError('auth/invalid')
    const existing = this.inFlightRefreshes.get(accountId)
    if (existing !== undefined) return await existing

    const controller = new AbortController()
    this.refreshControllers.set(accountId, controller)
    const run = this.performRefresh(accountId, controller.signal)
    this.inFlightRefreshes.set(accountId, run)
    try {
      return await run
    } finally {
      this.inFlightRefreshes.delete(accountId)
      this.refreshControllers.delete(accountId)
    }
  }

  /**
   * 执行一次需要账号凭据的操作；明确 401 时刷新同账号并重试一次。
   *
   * 只有 `ChannelSearchError` 的 `UNAUTHORIZED` 且 channel=buddy 才触发刷新；
   * 超时、限流、响应错误、跨渠道错误一律原样抛出，不刷新、不重试。
   */
  async runWithAuthRetry<T>(
    accountId: string,
    operation: (credential: BuddyAccessCredential, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.assertNotDisposed()
    const controller = new AbortController()
    this.operationControllers.add(controller)
    const run = this.performAuthRetry(accountId, operation, controller.signal)
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
    operation: (credential: BuddyAccessCredential, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const first = await this.resolveCredential(accountId)
    this.assertNotDisposed()
    if (signal.aborted) throw authError('auth/disposed')

    try {
      const result = await operation(first, signal)
      this.assertNotDisposed()
      if (signal.aborted) throw authError('auth/disposed')
      return result
    } catch (error) {
      if (this.disposed || signal.aborted) throw authError('auth/disposed')
      if (!isBuddyUnauthorized(error)) throw error
    }

    await this.refresh(accountId)
    this.assertNotDisposed()
    if (signal.aborted) throw authError('auth/disposed')
    const second = await this.resolveCredential(accountId)
    this.assertNotDisposed()
    if (signal.aborted) throw authError('auth/disposed')
    const result = await operation(second, signal)
    this.assertNotDisposed()
    if (signal.aborted) throw authError('auth/disposed')
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
    this.startController?.abort()
    for (const controller of this.operationControllers.values()) controller.abort()
    this.disposePromise = (async () => {
      await Promise.allSettled([...this.pendingStarts, ...this.pendingOperations])
      for (const flow of this.flows.values()) {
        if (flow.terminal) continue
        flow.cancelRequested = true
        flow.controller.abort()
        this.finishFlow(flow, 'cancelled', 'auth/cancelled')
      }
      for (const controller of this.refreshControllers.values()) controller.abort()
      await Promise.allSettled([
        ...[...this.flows.values()].map((flow) => flow.done.promise),
        ...this.inFlightRefreshes.values(),
      ])
    })()
    return await this.disposePromise
  }

  /** 打开 auth/state 并启动后台轮询。 */
  private async beginFlow(target: StoredAccountRecord | undefined): Promise<AuthFlowStatus> {
    this.assertNotDisposed()
    if (this.starting || this.activeFlow !== undefined) throw authError('auth/flow-active')
    this.starting = true
    const controller = new AbortController()
    this.startController = controller
    const run = this.openFlow(target, controller)
    this.pendingStarts.add(run)
    try {
      return await run
    } catch (error) {
      if (error instanceof BuddyAuthError) throw error
      throw authError('auth/internal')
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
      throw mapStartError(error, this.disposed)
    }
    if (this.disposed) throw authError('auth/disposed')
    if (controller.signal.aborted) throw authError('auth/cancelled')

    let rawFlowId: string
    try {
      rawFlowId = this.randomId()
    } catch {
      throw authError('auth/internal')
    }
    if (!isAuthFlowId(rawFlowId)) throw authError('auth/internal')
    if (this.flows.has(rawFlowId)) throw authError('auth/internal')
    const flow: FlowState = {
      flowId: rawFlowId,
      state: state.state,
      authUrl: state.authUrl,
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

  /** 后台轮询 token → account → 校验身份 → 落码。 */
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

      const vendorAccountId = resolveVendorAccountId(token, account)
      if (flow.targetVendorAccountId !== undefined
        && vendorAccountId !== flow.targetVendorAccountId) {
        throw authError('auth/identity-mismatch')
      }
      if (this.clock.now() >= flow.deadline) throw authError('auth/timeout')
      try {
        await this.verifyCapability(
          {
            channelId: BUDDY_AUTH_CHANNEL,
            accessToken: token.accessToken,
            vendorAccountId,
          },
          flow.controller.signal,
        )
      } catch (error) {
        if (flow.cancelRequested || this.disposed) throw authError('auth/cancelled')
        if (isTimeoutError(error)) throw authError('auth/timeout')
        throw authError('auth/failed')
      }
      this.ensureFlowActive(flow)
      if (this.clock.now() >= flow.deadline) throw authError('auth/timeout')

      const displayName = resolveDisplayName(token, account)
      const hadUsableAccounts = await this.hasUsableAccounts()
      this.ensureFlowActive(flow)
      if (this.clock.now() >= flow.deadline) throw authError('auth/timeout')

      const saved = await this.store.saveAccount({
        channel: CHANNEL,
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
          await this.accounts.setCurrent(CHANNEL, saved.accountId, flow.controller.signal)
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
      if (error instanceof BuddyAuthError) {
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
  private async performRefresh(accountId: string, signal: AbortSignal): Promise<AccountSummary> {
    if (this.disposed) throw authError('auth/disposed')
    let entry: StoredAccountEntry | undefined
    try {
      entry = await this.store.readEntry(CHANNEL, accountId)
    } catch {
      throw authError('auth/refresh-failed')
    }
    if (entry === undefined) throw authError('auth/account-not-found')
    if (entry.account === undefined) throw authError('auth/credential-unavailable')
    this.assertNotDisposed()
    if (signal.aborted) throw authError('auth/disposed')
    const secret = entry.account.secret
    const accessToken = readSecretString(secret, 'accessToken')
    if (accessToken === undefined) throw authError('auth/credential-unavailable')
    const refreshToken = readSecretString(secret, 'refreshToken') ?? ''

    if (refreshToken.length === 0) {
      await this.updateAccountState(accountId, refreshToken, 'reauth_required')
      throw authError('auth/reauth-required')
    }

    let token: TencentToken
    try {
      token = await this.client.refresh({ accessToken, refreshToken, signal })
    } catch (error) {
      if (this.disposed || signal.aborted) throw authError('auth/disposed')
      if (error instanceof TencentExternalLinkError && error.code === 'reauth-required') {
        await this.updateAccountState(accountId, refreshToken, 'reauth_required')
        throw authError('auth/reauth-required')
      }
      await this.updateAccountState(accountId, refreshToken, 'temporarily_unavailable')
      throw authError('auth/refresh-failed')
    }

    if (this.disposed || signal.aborted) throw authError('auth/disposed')

    let updated: StoredAccountRecord | undefined
    try {
      updated = await this.store.rotateSecret({
        channel: CHANNEL,
        accountId,
        expectedRefreshToken: refreshToken,
        secret: mergeRefreshedSecret(secret, token),
        status: 'ready',
      })
    } catch {
      throw authError('auth/refresh-failed')
    }
    if (this.disposed || signal.aborted) throw authError('auth/disposed')
    if (updated !== undefined) return toSummary(updated)

    // 当前记录已被更新（重新登录/另一次刷新/删除）：返回当前值，绝不覆盖。
    let current: StoredAccountEntry | undefined
    try {
      current = await this.store.readEntry(CHANNEL, accountId)
    } catch {
      throw authError('auth/refresh-failed')
    }
    if (this.disposed || signal.aborted) throw authError('auth/disposed')
    if (current === undefined) throw authError('auth/account-not-found')
    if (current.account === undefined) throw authError('auth/credential-unavailable')
    return toSummary(current.account)
  }

  /** 刷新失败状态标记；仅当 refresh token 仍匹配时写，失败不掩盖原错误。 */
  private async updateAccountState(
    accountId: string,
    expectedRefreshToken: string,
    status: 'reauth_required' | 'temporarily_unavailable',
  ): Promise<void> {
    if (this.disposed) return
    try {
      await this.store.rotateSecret({
        channel: CHANNEL,
        accountId,
        expectedRefreshToken,
        status,
      })
    } catch {
      /* 状态标记是尽力而为；凭据错误仍是主结果。 */
    }
  }

  /** 读取账号执行期访问令牌。 */
  private async resolveCredential(accountId: string): Promise<BuddyAccessCredential> {
    this.assertNotDisposed()
    if (!isStableChannelAccountId(accountId)) throw authError('auth/invalid')
    let entry: StoredAccountEntry | undefined
    try {
      entry = await this.store.readEntry(CHANNEL, accountId)
    } catch {
      throw authError('auth/credential-unavailable')
    }
    if (entry === undefined) throw authError('auth/account-not-found')
    if (entry.account === undefined) throw authError('auth/credential-unavailable')
    this.assertNotDisposed()
    const accessToken = readSecretString(entry.account.secret, 'accessToken')
    if (accessToken === undefined) throw authError('auth/credential-unavailable')
    return Object.freeze({
      channelId: BUDDY_AUTH_CHANNEL,
      accountId,
      accessToken,
    })
  }

  /** 是否存在可用账号；损坏记录或缺 accessToken 的记录不算「首个账号」。 */
  private async hasUsableAccounts(): Promise<boolean> {
    const entries = await this.store.listEntries(CHANNEL)
    return entries.some((entry) => entry.account !== undefined
      && readSecretString(entry.account.secret, 'accessToken') !== undefined)
  }

  /** 断言未 dispose；dispose 后拒绝一切新授权/刷新任务。 */
  private assertNotDisposed(): void {
    if (this.disposed) throw authError('auth/disposed')
  }

  /** 校验并取回流程。 */
  private requireFlow(flowId: string): FlowState {
    if (!isAuthFlowId(flowId)) throw authError('auth/invalid')
    const flow = this.flows.get(flowId)
    if (flow === undefined) throw authError('auth/flow-not-found')
    return flow
  }

  /** 轮询步骤前确认流程仍可写；取消/卸载时立即退出。 */
  private ensureFlowActive(flow: FlowState): void {
    if (this.disposed) throw authError('auth/disposed')
    if (flow.cancelRequested || flow.controller.signal.aborted) {
      throw authError('auth/cancelled')
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
      channel: BUDDY_AUTH_CHANNEL,
      status: flow.status,
      authUrl: flow.authUrl,
      displayHint: flow.displayHint,
      account: flow.account,
      errorCode: flow.errorCode,
    })
  }
}

/** 把 auth/state 阶段错误映射为固定授权错误。 */
function mapStartError(error: unknown, disposed: boolean): BuddyAuthError {
  if (disposed) return authError('auth/disposed')
  if (error instanceof TencentExternalLinkError) {
    switch (error.code) {
      case 'cancelled':
        return authError('auth/cancelled')
      case 'timeout':
        return authError('auth/timeout')
      case 'invalid-response':
        return authError('auth/invalid-response')
      case 'reauth-required':
        return authError('auth/reauth-required')
      case 'request-timeout':
      case 'temporary':
      case 'failed':
        return authError('auth/failed')
    }
  }
  return authError('auth/internal')
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
function isBuddyUnauthorized(error: unknown): boolean {
  return error instanceof ChannelSearchError
    && error.code === 'UNAUTHORIZED'
    && error.channel === BUDDY_AUTH_CHANNEL
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
function resolveVendorAccountId(token: TencentToken, account: TencentAccount): string {
  const uid = account.uid.trim()
  if (uid.length > 0 && uid.length <= 256) return uid
  const subject = readJwtClaim(token.accessToken, 'sub')
  if (typeof subject === 'string') {
    const trimmed = stripControlChars(subject)
    if (trimmed.length > 0 && trimmed.length <= 256) return trimmed
  }
  throw authError('auth/invalid-response')
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
