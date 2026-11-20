/**
 * Qoder 设备授权、刷新与重新登录的共享状态机，以及国际版产品包装。
 *
 * 协议状态机（auth-flow.ts）与流程状态机（本文件 `QoderProductAuthFlow`）只复用
 * **代码形状与安全边界**；每个产品 flow 实例独立持有账号、当前账号、grant、
 * flowId、刷新单飞 map、取消与 dispose 状态。所有账号读写都使用构造时固定的
 * `channel`，产品参数（authBase/openApiBase/clientId/authUrlHosts）、展示说明与
 * 错误工厂都由产品包装注入。
 *
 * 国际版包装只属于 `qoder` 渠道：
 * - 设备授权固定使用 `qoder.com` / `openapi.qoder.sh` 与精确
 *   `clientId=e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb`；绝不使用中国版
 *   clientId、`qoder.cn`、`gateway.qoder.com.cn` 或中国版账号；
 * - 成功授权只经 `AccountStore.saveAccount` 写本插件 qoder grant，秘密包含
 *   签名所需的 `securityOauthToken` / `machineId` / `uid` 与刷新/过期材料；
 * - 首个可用账号经 `AccountService.setCurrent` 设为当前，后续账号不自动切换；
 * - 刷新按账号单飞，轮换经 `AccountStore.rotateSecret` 的原子 compare-and-set，
 *   旧刷新/旧 401 不会覆盖新记录；
 * - 只有明确 `UNAUTHORIZED`、channel 匹配且 `httpStatus===401` 的错误，才允许
 *   刷新同一账号并重试原操作一次；其他错误不重试、不换账号/渠道。
 *
 * 授权与重新登录只能由显式方法/RPC 触发：构造函数不启动任何任务，也不注册
 * Agent tool。取消、超时与 dispose 会 abort 在飞请求并等待 settle；状态与错误
 * 只含固定码和脱敏 DTO，不含 token、secret、上游正文或异常原文。
 */
import type { AccountSummary } from '../../../shared/accounts.ts'
import {
  AuthFlowError,
  isAuthFlowError,
  isAuthFlowId,
  QODER_AUTH_CHANNEL,
  type AuthChannel,
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
import { combineAuthSignals, forwardAuthAbort, waitWithAuthAbort } from '../auth-abort.ts'
import {
  accessNeedsRefresh,
  readExpiryMs,
  refreshHasExpired,
} from '../auth-expiry.ts'
import { runCapabilityVerifierWithDeadline } from '../capability.ts'
import {
  QODER_INTERNATIONAL_PRODUCT,
  QODER_LOGIN_TIMEOUT_MS,
  QODER_POLL_INTERVAL_MS,
  QODER_REQUEST_TIMEOUT_MS,
  QoderDeviceAuthClient,
  QoderDeviceTokenError,
  SYSTEM_CLOCK,
  buildQoderAuthUrl,
  createQoderDeviceSession,
  normalizeQoderAuthUrl,
  type QoderAuthClock,
  type QoderDeviceProduct,
  type QoderDeviceSession,
  type QoderTokenPayload,
} from './auth-flow.ts'
import type { QoderSigningCredential } from './protocol.ts'

/** 国际版授权流程错误码到固定文案。 */
const ERROR_MESSAGES: Readonly<Record<AuthFlowErrorCode, string>> = Object.freeze({
  'auth/invalid': 'Qoder 国际版授权请求非法',
  'auth/flow-active': '已有进行中的 Qoder 国际版授权流程',
  'auth/flow-not-found': '未找到指定的 Qoder 国际版授权流程',
  'auth/timeout': 'Qoder 国际版授权已超时',
  'auth/cancelled': 'Qoder 国际版授权已取消',
  'auth/failed': 'Qoder 国际版授权失败',
  'auth/invalid-response': 'Qoder 国际版授权响应无效',
  'auth/disposed': 'Qoder 国际版授权流程已停止',
  'auth/account-not-found': '该渠道下不存在指定账号',
  'auth/credential-unavailable': '账号凭据记录不可用，请重新登录',
  'auth/identity-mismatch': '重新登录的账号身份与目标账号不一致',
  'auth/reauth-required': 'Qoder 凭据已失效，请重新登录',
  'auth/refresh-failed': 'Qoder 凭据刷新失败',
  'auth/current-account-failed': 'Qoder 账号已保存，但未能设为当前账号',
  'auth/internal': 'Qoder 国际版授权内部错误',
})

/** 国际版授权域错误；`cause` 永远不设置，避免秘密沿错误链泄漏。 */
export class QoderInternationalAuthError extends AuthFlowError {
  override readonly name = 'QoderInternationalAuthError'
}

/** 构造一个固定文案的国际版授权错误。 */
function authError(code: AuthFlowErrorCode): QoderInternationalAuthError {
  return new QoderInternationalAuthError(code, ERROR_MESSAGES[code])
}

/** 保存前能力探测的输入；不含 refreshToken。 */
export interface QoderCapabilityCredential<
  C extends AuthChannel = typeof QODER_AUTH_CHANNEL,
> {
  readonly channelId: C
  /** 厂商稳定身份（设备码 `user_id`），只用于同渠道去重。 */
  readonly vendorAccountId: string
  /** 签名凭据；只在进程内流转，不进入 RPC/日志。 */
  readonly credential: QoderSigningCredential
}

/**
 * 保存前 Search 能力探测。
 *
 * 必须是 Host-only、可注入且不可省略的依赖；Task 15 用真实 Qoder 搜索路径
 * 实现。探测失败/超时/取消时流程不得落码或设当前。
 */
export type QoderCapabilityVerifier<
  C extends AuthChannel = typeof QODER_AUTH_CHANNEL,
> = (
  credential: QoderCapabilityCredential<C>,
  signal: AbortSignal,
) => Promise<void>

/** 执行期签名凭据快照；只交给调用方操作，不进入 RPC。 */
export interface QoderAuthCredential<
  C extends AuthChannel = typeof QODER_AUTH_CHANNEL,
> {
  readonly channelId: C
  readonly accountId: string
  readonly credential: QoderSigningCredential
}

interface QoderInvocationGrant<C extends AuthChannel> {
  readonly credential: QoderAuthCredential<C>
  readonly expiresAtMs?: number
  readonly refreshExpiresAtMs?: number
  readonly refreshToken: string
}

/** 单次 tool invocation 的可推进 grant；只有本 invocation 的刷新可更新它。 */
export interface QoderAuthInvocation<C extends AuthChannel> {
  readonly accountId: string
  current?: QoderInvocationGrant<C>
  initializing?: Promise<QoderInvocationGrant<C>>
}

/** `start` 的选项；提供 accountId 时等价于重新登录。 */
export interface QoderStartOptions extends AuthFlowStartOptions {}

/**
 * 产品授权流程依赖；全部网络/时钟/随机/设备会话可注入。
 *
 * 本接口由国际版/中国版包装填充产品常量后传给共享状态机；调用方不应直接
 * 用它构造流程，避免把两套产品参数混用。
 */
export interface QoderProductAuthFlowOptions<C extends AuthChannel> {
  /** 本流程固定归属的顶层渠道。 */
  readonly channel: C
  /** 本产品固定的设备授权参数；不随模型/账号变化。 */
  readonly product: QoderDeviceProduct
  readonly store: AccountStore
  readonly accounts: AccountService
  /** 测试注入；生产默认使用全局 fetch。 */
  readonly fetcher?: typeof fetch
  /** 测试注入；生产默认使用系统时钟。 */
  readonly clock?: QoderAuthClock
  /** 测试注入；生产默认使用 crypto.randomUUID。 */
  readonly randomId?: () => string
  /** 设备会话生成器；测试注入确定性 PKCE/nonce/machineId。 */
  readonly createDeviceSession?: () => QoderDeviceSession
  /** 轮询间隔；默认 1000ms。 */
  readonly pollIntervalMs?: number
  /** 整个授权流程的预算；默认 5 分钟。 */
  readonly authTimeoutMs?: number
  /** 单次控制面请求超时；默认 30s。 */
  readonly requestTimeoutMs?: number
  /** 请求超时信号工厂；测试可注入永不触发的信号。 */
  readonly timeoutSignal?: (ms: number) => AbortSignal
  /** 展示说明；由产品包装提供固定文案。 */
  readonly displayHint: string
  /**
   * 保存前 Search 能力探测；Host-only 且不可省略。Task 15 必须提供真实
   * Search 路径；失败/超时/取消都不得落码或设当前。
   */
  readonly verifyCapability: QoderCapabilityVerifier<C>
  /** 产品固定错误工厂；不得设置 cause。 */
  readonly errorFactory: (code: AuthFlowErrorCode) => AuthFlowError
}

/** 国际版授权流程依赖；全部网络/时钟/随机/设备会话可注入。 */
export interface QoderInternationalAuthFlowOptions {
  readonly store: AccountStore
  readonly accounts: AccountService
  /** 测试注入；生产默认使用全局 fetch。 */
  readonly fetcher?: typeof fetch
  /** 测试注入；生产默认使用系统时钟。 */
  readonly clock?: QoderAuthClock
  /** 测试注入；生产默认使用 crypto.randomUUID。 */
  readonly randomId?: () => string
  /** 设备会话生成器；测试注入确定性 PKCE/nonce/machineId。 */
  readonly createDeviceSession?: () => QoderDeviceSession
  /** 轮询间隔；默认 1000ms。 */
  readonly pollIntervalMs?: number
  /** 整个授权流程的预算；默认 5 分钟。 */
  readonly authTimeoutMs?: number
  /** 单次控制面请求超时；默认 30s。 */
  readonly requestTimeoutMs?: number
  /** 请求超时信号工厂；测试可注入永不触发的信号。 */
  readonly timeoutSignal?: (ms: number) => AbortSignal
  /** 展示说明；默认固定中文说明。 */
  readonly displayHint?: string
  /**
   * 保存前 Search 能力探测；Host-only 且不可省略。Task 15 必须提供真实
   * Qoder Search 路径；失败/超时/取消都不得落码或设当前。
   */
  readonly verifyCapability: QoderCapabilityVerifier
}

/** 默认展示说明；不含账号身份或任何秘密。 */
const DEFAULT_DISPLAY_HINT = '在浏览器中完成 Qoder 国际版登录后返回，插件会自动完成授权。'

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
  readonly session: QoderDeviceSession
  readonly authUrl: string
  readonly displayHint: string
  readonly deadline: number
  readonly controller: AbortController
  readonly targetAccountId: string | undefined
  readonly targetVendorAccountId: string | undefined
  readonly targetRefreshToken: string | undefined
  readonly done: Deferred<void>
  status: AuthFlowState
  account: AccountSummary | null
  errorCode: AuthFlowErrorCode | null
  cancelRequested: boolean
  terminal: boolean
  detachCallerSignal?: () => void
}

/** 保留最近多少个流程状态供 Client 查询。 */
const MAX_REMEMBERED_FLOWS = 16

/**
 * Qoder 设备授权产品流程的共享状态机。
 *
 * 泛型 `C` 只用于编译期区分渠道；运行时所有账号/配置写入都经构造参数
 * `channel`，实例之间不共享任何可变状态。国际版/中国版各自包装成独立类，
 * 不直接暴露本基类给 Host 根组合。
 */
export class QoderProductAuthFlow<C extends AuthChannel> implements AuthFlowPort {
  readonly channel: C
  private readonly product: QoderDeviceProduct
  private readonly store: AccountStore
  private readonly accounts: AccountService
  private readonly client: QoderDeviceAuthClient
  private readonly clock: QoderAuthClock
  private readonly randomId: () => string
  private readonly createDeviceSession: () => QoderDeviceSession
  private readonly pollIntervalMs: number
  private readonly authTimeoutMs: number
  private readonly displayHint: string
  private readonly verifyCapability: QoderCapabilityVerifier<C>
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

  constructor(options: QoderProductAuthFlowOptions<C>) {
    if (typeof options.verifyCapability !== 'function') {
      throw new TypeError('QoderProductAuthFlow requires a verifyCapability function')
    }
    this.channel = options.channel
    this.product = options.product
    this.store = options.store
    this.accounts = options.accounts
    this.clock = options.clock ?? SYSTEM_CLOCK
    this.randomId = options.randomId ?? (() => globalThis.crypto.randomUUID())
    this.createDeviceSession = options.createDeviceSession ?? (() => createQoderDeviceSession())
    this.pollIntervalMs = options.pollIntervalMs ?? QODER_POLL_INTERVAL_MS
    this.authTimeoutMs = options.authTimeoutMs ?? QODER_LOGIN_TIMEOUT_MS
    this.displayHint = options.displayHint
    this.verifyCapability = options.verifyCapability
    this.errorFactory = options.errorFactory
    this.client = new QoderDeviceAuthClient({
      product: this.product,
      clock: this.clock,
      ...options.fetcher === undefined ? {} : { fetcher: options.fetcher },
      ...options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs },
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
  async start(
    options: QoderStartOptions = {},
    callerSignal?: AbortSignal,
  ): Promise<AuthFlowStatus> {
    this.assertNotDisposed()
    if (callerSignal?.aborted) throw this.error('auth/cancelled')
    if (options.accountId !== undefined) return await this.reauthenticate(options.accountId, callerSignal)
    return await this.beginFlow(undefined, callerSignal)
  }

  /**
   * 对既有账号重新登录。
   *
   * 先验证目标账号存在于本渠道；成功后必须仍是同一厂商身份，否则失败且
   * 不覆盖原记录。重新登录不改变当前账号选择（目标原本是当前则保持）。
   */
  async reauthenticate(accountId: string, callerSignal?: AbortSignal): Promise<AuthFlowStatus> {
    this.assertNotDisposed()
    if (callerSignal?.aborted) throw this.error('auth/cancelled')
    const controller = new AbortController()
    this.operationControllers.add(controller)
    const signal = combineAuthSignals(controller.signal, callerSignal)
    const run = this.performReauthenticate(accountId, signal)
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
    return await this.beginFlow(entry.account, signal)
  }

  /** 查询指定流程的脱敏状态；caller 可放弃等待，不影响 flow 本身。 */
  async status(flowId: string, callerSignal?: AbortSignal): Promise<AuthFlowStatus> {
    const flow = this.requireFlow(flowId)
    if (callerSignal === undefined) return this.toStatus(flow)
    return await waitWithAuthAbort(
      Promise.resolve(this.toStatus(flow)),
      callerSignal,
      () => this.error('auth/cancelled'),
    )
  }

  /**
   * 取消指定流程。
   *
   * 立即把状态置为 cancelled 并 abort；等待后台轮询真正退出后才返回，因此
   * 取消返回后不会再出现本流程的账号/当前账号写入。终态流程幂等返回。
   */
  async cancel(flowId: string, callerSignal?: AbortSignal): Promise<AuthFlowStatus> {
    const flow = this.requireFlow(flowId)
    if (flow.terminal) return this.toStatus(flow)
    flow.cancelRequested = true
    flow.controller.abort()
    this.finishFlow(flow, 'cancelled', 'auth/cancelled')
    if (callerSignal !== undefined) {
      await waitWithAuthAbort(flow.done.promise, callerSignal, () => this.error('auth/cancelled'))
    } else {
      await flow.done.promise
    }
    return this.toStatus(flow)
  }

  /**
   * 刷新指定账号的凭据。
   *
   * 同一账号单飞；refresh token 轮换通过 `rotateSecret` 原子比较当前记录，旧刷新
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
    const run = this.performRefresh(accountId, controller.signal)
    this.inFlightRefreshes.set(accountId, run)
    const cleanup = () => {
      if (this.inFlightRefreshes.get(accountId) === run) this.inFlightRefreshes.delete(accountId)
      if (this.refreshControllers.get(accountId) === controller) {
        this.refreshControllers.delete(accountId)
      }
    }
    void run.then(cleanup, cleanup)
    return callerSignal === undefined
      ? await run
      : await waitWithAuthAbort(run, callerSignal, () => this.error('auth/cancelled'))
  }

  /**
   * 执行一次需要签名凭据的操作；可信 HTTP 401 时刷新同账号并重试一次。
   *
   * 只有 `ChannelSearchError` 的 `UNAUTHORIZED`、channel 与本流程一致且
   * `httpStatus===401` 才触发刷新；超时、限流、403、无 HTTP 证据、跨渠道错误
   * 一律原样抛出，不刷新、不重试。
   */
  /** 创建只归属一次 tool invocation 的空快照；读取在实际首次 operation 前发生。 */
  createInvocation(accountId: string): QoderAuthInvocation<C> {
    return { accountId }
  }

  async runWithAuthRetry<T>(
    accountId: string,
    operation: (credential: QoderAuthCredential<C>, signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
    invocation?: QoderAuthInvocation<C>,
  ): Promise<T> {
    this.assertNotDisposed()
    if (callerSignal?.aborted) throw this.error('auth/cancelled')
    const controller = new AbortController()
    this.operationControllers.add(controller)
    const signal = combineAuthSignals(controller.signal, callerSignal)
    const run = this.performAuthRetry(
      accountId,
      operation,
      signal,
      callerSignal,
      invocation ?? this.createInvocation(accountId),
    )
    this.pendingOperations.add(run)
    try {
      return await run
    } finally {
      this.pendingOperations.delete(run)
      this.operationControllers.delete(controller)
    }
  }

  /** 临期初始化与 401 重试；只有本 invocation 内的刷新可推进 grant。 */
  private async performAuthRetry<T>(
    accountId: string,
    operation: (credential: QoderAuthCredential<C>, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    callerSignal: AbortSignal | undefined,
    invocation: QoderAuthInvocation<C>,
  ): Promise<T> {
    const first = await this.prepareInvocationGrant(accountId, invocation, signal, callerSignal)
    this.throwIfOperationAborted(signal)

    try {
      const result = await operation(first.credential, signal)
      this.throwIfOperationAborted(signal)
      return result
    } catch (error) {
      if (this.disposed || signal.aborted) this.throwIfOperationAborted(signal)
      if (!isQoderUnauthorized(error, this.channel)) throw error
    }

    await this.refresh(accountId, callerSignal)
    this.throwIfOperationAborted(signal)
    const second = await this.resolveGrant(accountId, signal)
    invocation.current = second
    this.throwIfOperationAborted(signal)
    const result = await operation(second.credential, signal)
    this.throwIfOperationAborted(signal)
    return result
  }

  private async prepareInvocationGrant(
    accountId: string,
    invocation: QoderAuthInvocation<C>,
    signal: AbortSignal,
    callerSignal: AbortSignal | undefined,
  ): Promise<QoderInvocationGrant<C>> {
    if (invocation.accountId !== accountId) throw this.error('auth/invalid')
    if (invocation.current !== undefined) return invocation.current
    invocation.initializing ??= this.initializeInvocationGrant(accountId, signal, callerSignal)
    const grant = await invocation.initializing
    invocation.current = grant
    return grant
  }

  private async initializeInvocationGrant(
    accountId: string,
    signal: AbortSignal,
    callerSignal: AbortSignal | undefined,
  ): Promise<QoderInvocationGrant<C>> {
    let grant = await this.resolveGrant(accountId, signal)
    this.throwIfOperationAborted(signal)
    if (refreshHasExpired(grant.refreshExpiresAtMs, this.clock.now())) {
      await this.updateAccountState(accountId, grant.refreshToken, 'reauth_required', signal)
      throw this.error('auth/reauth-required')
    }
    if (!accessNeedsRefresh(grant.expiresAtMs, this.clock.now())) return grant
    await this.refresh(accountId, callerSignal)
    this.throwIfOperationAborted(signal)
    grant = await this.resolveGrant(accountId, signal)
    this.throwIfOperationAborted(signal)
    return grant
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

  /** 创建设备会话并启动后台轮询。 */
  private async beginFlow(
    target: StoredAccountRecord | undefined,
    callerSignal?: AbortSignal,
  ): Promise<AuthFlowStatus> {
    this.assertNotDisposed()
    if (this.starting || this.activeFlow !== undefined) throw this.error('auth/flow-active')
    this.starting = true
    const controller = new AbortController()
    const detachCaller = forwardAuthAbort(controller, callerSignal)
    let registeredFlow: FlowState | undefined
    this.startController = controller
    const run = this.openFlow(target, controller, (flow) => {
      registeredFlow = flow
      flow.detachCallerSignal = detachCaller
    })
    this.pendingStarts.add(run)
    try {
      return await run
    } catch (error) {
      if (isAuthFlowError(error)) throw error
      throw this.error('auth/internal')
    } finally {
      if (registeredFlow === undefined) detachCaller()
      this.pendingStarts.delete(run)
      if (this.startController === controller) this.startController = undefined
      this.starting = false
    }
  }

  /** 生成设备会话与授权 URL；成功后创建流程并异步轮询。 */
  private async openFlow(
    target: StoredAccountRecord | undefined,
    controller: AbortController,
    onFlow: (flow: FlowState) => void,
  ): Promise<AuthFlowStatus> {
    let session: QoderDeviceSession
    try {
      session = this.createDeviceSession()
    } catch {
      throw this.error('auth/internal')
    }
    if (this.disposed) throw this.error('auth/disposed')
    if (controller.signal.aborted) throw this.error('auth/cancelled')

    let authUrl: string | undefined
    try {
      authUrl = normalizeQoderAuthUrl(
        buildQoderAuthUrl(session, this.product),
        this.product.authUrlHosts,
      )
    } catch {
      authUrl = undefined
    }
    if (authUrl === undefined) throw this.error('auth/internal')

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
      session,
      authUrl,
      displayHint: this.displayHint,
      deadline: this.clock.now() + this.authTimeoutMs,
      controller,
      targetAccountId: target?.accountId,
      targetVendorAccountId: target?.vendorAccountId,
      targetRefreshToken: target === undefined
        ? undefined
        : readSecretString(target.secret, 'refreshToken') ?? '',
      done: deferred<void>(),
      status: 'pending',
      account: null,
      errorCode: null,
      cancelRequested: false,
      terminal: false,
    }
    this.activeFlow = flow
    this.rememberFlow(flow)
    onFlow(flow)
    void this.runFlow(flow)
    return this.toStatus(flow)
  }

  /** 后台轮询 token → 身份校验 → 能力探测 → 落码。 */
  private async runFlow(flow: FlowState): Promise<void> {
    try {
      const pollOptions = {
        signal: flow.controller.signal,
        deadline: flow.deadline,
        pollIntervalMs: this.pollIntervalMs,
      }
      const token = await this.client.pollDeviceToken(flow.session, pollOptions)
      this.ensureFlowActive(flow)

      const vendorAccountId = resolveVendorAccountId(token, this.errorFactory)
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
              vendorAccountId,
              credential: signingCredential(token, flow.session.machineId, vendorAccountId),
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

      const displayName = resolveDisplayName(token)
      const hadUsableAccounts = await this.hasUsableAccounts(flow.controller.signal)
      this.ensureFlowActive(flow)
      if (this.clock.now() >= flow.deadline) throw this.error('auth/timeout')

      const saved = await this.store.saveAccount({
        channel: this.channel,
        vendorAccountId,
        ...flow.targetAccountId === undefined ? {} : {
          expectedAccountId: flow.targetAccountId,
          expectedRefreshToken: flow.targetRefreshToken ?? '',
        },
        ...displayName === undefined ? {} : { displayName },
        status: 'ready',
        secret: buildSecret(token, flow.session.machineId, vendorAccountId),
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
    const machineId = readSecretString(secret, 'machineId')
    if (machineId === undefined) throw this.error('auth/credential-unavailable')
    const refreshToken = readSecretString(secret, 'refreshToken') ?? ''

    if (refreshToken.length === 0) {
      await this.updateAccountState(accountId, refreshToken, 'reauth_required', signal)
      throw this.error('auth/reauth-required')
    }

    let token: QoderTokenPayload
    try {
      token = await this.client.refresh({ refreshToken, machineId, signal })
    } catch (error) {
      if (this.disposed || signal.aborted) throw this.error('auth/disposed')
      if (error instanceof QoderDeviceTokenError && error.code === 'reauth-required') {
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
    } catch (error) {
      // 取消发生在实际提交回调内时，账号库抛 accounts/cancelled；必须保持
      // dispose 语义，不能被无条件改写成 auth/refresh-failed。
      if (this.disposed || signal.aborted || isAccountCancelled(error)) {
        throw this.error('auth/disposed')
      }
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

  /**
   * 刷新失败状态标记；仅当 refresh token 仍匹配时写，失败不掩盖原错误。
   *
   * 状态写入同样经过带 signal 的 CAS 提交边界：dispose/取消在独占回调内生效时
   * 抛 `auth/disposed`，不得变成迟到状态写入；其他状态写入失败仍是尽力而为。
   */
  private async updateAccountState(
    accountId: string,
    expectedRefreshToken: string,
    status: 'reauth_required' | 'temporarily_unavailable',
    signal: AbortSignal,
  ): Promise<void> {
    if (this.disposed || signal.aborted) throw this.error('auth/disposed')
    try {
      await this.store.rotateSecret({
        channel: this.channel,
        accountId,
        expectedRefreshToken,
        status,
        signal,
      })
    } catch (error) {
      if (this.disposed || signal.aborted || isAccountCancelled(error)) {
        throw this.error('auth/disposed')
      }
      /* 其他状态标记失败是尽力而为；凭据错误仍是主结果。 */
    }
  }

  /** 读取账号执行期 grant；过期元数据只在 Host 内用于首次临期判断。 */
  private async resolveGrant(
    accountId: string,
    signal: AbortSignal,
  ): Promise<QoderInvocationGrant<C>> {
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
    const secret = entry.account.secret
    const securityOauthToken = readSecretString(secret, 'securityOauthToken')
    const machineId = readSecretString(secret, 'machineId')
    if (securityOauthToken === undefined || machineId === undefined) {
      throw this.error('auth/credential-unavailable')
    }
    const uid = readSecretString(secret, 'uid')
    const organizationId = readSecretString(secret, 'organizationId')
    const credential: QoderSigningCredential = Object.freeze({
      securityOauthToken,
      machineId,
      ...uid === undefined ? {} : { uid },
      ...organizationId === undefined ? {} : { organizationId },
    })
    const expiresAtMs = readExpiryMs(secret, 'expiresAtMs')
    const refreshExpiresAtMs = readExpiryMs(secret, 'refreshExpiresAtMs')
    return Object.freeze({
      credential: Object.freeze({
        channelId: this.channel,
        accountId,
        credential,
      }),
      ...expiresAtMs === undefined ? {} : { expiresAtMs },
      ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
      refreshToken: readSecretString(secret, 'refreshToken') ?? '',
    })
  }

  /** 是否存在本渠道可用账号；缺签名材料的记录不算「首个账号」。 */
  private async hasUsableAccounts(signal: AbortSignal): Promise<boolean> {
    const entries = await waitWithAuthAbort(
      this.store.listEntries(this.channel, signal),
      signal,
      () => this.error(this.disposed ? 'auth/disposed' : 'auth/cancelled'),
    )
    return entries.some((entry) => entry.account !== undefined
      && readSecretString(entry.account.secret, 'securityOauthToken') !== undefined
      && readSecretString(entry.account.secret, 'machineId') !== undefined)
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
    flow.detachCallerSignal?.()
    flow.detachCallerSignal = undefined
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

/** Qoder 国际版设备授权、刷新与重新登录流程。 */
export class QoderInternationalAuthFlow extends
  QoderProductAuthFlow<typeof QODER_AUTH_CHANNEL> {
  constructor(options: QoderInternationalAuthFlowOptions) {
    super({
      ...options,
      channel: QODER_AUTH_CHANNEL,
      product: QODER_INTERNATIONAL_PRODUCT,
      displayHint: options.displayHint ?? DEFAULT_DISPLAY_HINT,
      errorFactory: authError,
    })
  }
}

/** 把轮询阶段错误映射为流程终态。 */
function mapFlowError(error: unknown): {
  readonly status: AuthFlowState
  readonly code: AuthFlowErrorCode
} {
  if (error instanceof QoderDeviceTokenError) {
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
function isQoderUnauthorized(error: unknown, channel: AuthChannel): boolean {
  return error instanceof ChannelSearchError
    && error.code === 'UNAUTHORIZED'
    && error.channel === channel
    && error.httpStatus === 401
}

/** 账号库取消错误；刷新实际提交边界取消时映射为 auth/disposed。 */
function isAccountCancelled(error: unknown): boolean {
  return error instanceof AccountError && error.code === 'accounts/cancelled'
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

/** 从设备码响应解析稳定厂商身份（`user_id`）；缺失即无效响应。 */
function resolveVendorAccountId(
  token: QoderTokenPayload,
  errorFactory: (code: AuthFlowErrorCode) => AuthFlowError,
): string {
  const uid = typeof token.uid === 'string' ? stripControlChars(token.uid) : ''
  if (uid.length === 0 || uid.length > 256) throw errorFactory('auth/invalid-response')
  return uid
}

/** 解析展示名：`user_name`；缺省交给账号库渠道名。 */
function resolveDisplayName(token: QoderTokenPayload): string | undefined {
  if (typeof token.userName !== 'string') return undefined
  const trimmed = stripControlChars(token.userName).slice(0, 120)
  return trimmed.length > 0 ? trimmed : undefined
}

/** 清理控制字符并折叠空白。 */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** 设备码 → 签名凭据；只在进程内流转。 */
function signingCredential(
  token: QoderTokenPayload,
  machineId: string,
  uid: string,
): QoderSigningCredential {
  return Object.freeze({
    securityOauthToken: token.accessToken,
    machineId,
    uid,
  })
}

/** 授权成功写入的秘密材料；只进入 credentials grant。 */
function buildSecret(
  token: QoderTokenPayload,
  machineId: string,
  uid: string,
): Readonly<Record<string, unknown>> {
  return {
    securityOauthToken: token.accessToken,
    machineId,
    uid,
    ...token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken },
    ...token.expiresAt === undefined ? {} : { expiresAtMs: token.expiresAt },
    ...token.refreshTokenExpiresAt === undefined
      ? {}
      : { refreshExpiresAtMs: token.refreshTokenExpiresAt },
  }
}

/** 合并刷新结果；缺新 access expiry 时清除旧值，避免每次调用立即重复刷新。 */
function mergeRefreshedSecret(
  current: Readonly<Record<string, unknown>>,
  token: QoderTokenPayload,
): Readonly<Record<string, unknown>> {
  const retained: Record<string, unknown> = { ...current }
  delete retained.expiresAtMs
  return {
    ...retained,
    securityOauthToken: token.accessToken,
    ...token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken },
    ...token.expiresAt === undefined ? {} : { expiresAtMs: token.expiresAt },
    ...token.refreshTokenExpiresAt === undefined
      ? {}
      : { refreshExpiresAtMs: token.refreshTokenExpiresAt },
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
