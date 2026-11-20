/**
 * Qoder 国际版双域端点策略（`center.qoder.sh` / `api2.qoder.sh`）。
 *
 * ## 边界
 *
 * 本层只回答一个问题：**这一次搜索该发给哪个域，失败后是否允许换域一次**。
 * 它不持有账号、不解析凭据、不签名、不发请求、不写日志；真正的网络动作由调用方
 * 注入的 `operation` 完成，而 `operation` 只收到域名。
 *
 * ## 规则（§9.6）
 *
 * - **固定模式**：`center` / `api2` 只走所选域，任何错误都不切换。
 * - **自动模式**：初始 `center.qoder.sh`；只有连接失败（DNS/TCP/TLS）、请求超时、
 *   上游 5xx 才在首域 settle 后**顺序**尝试另一域一次。401/403、429、坏响应、
 *   签名/配置/账号/本地校验错误、调用方取消都不切换；未知异常默认不切换。
 * - **R43 全局路由**：成功的域成为本机唯一最近成功域，所有国际版账号共用；
 *   新 activation 从 Host 持久值开始，fixed 与 capability probe 不写入。
 * - **可归因**：单 query 每域最多一次；两域都失败时抛出含两个域名与结构化类别
 *   的安全错误（不含 query、凭据、账号键、持久路由字段或底层异常原文）。
 *
 * ## 明确不做
 *
 * 不做并行双发、后台测速、周期性探测、延迟评分、滞回窗口、networkExitKey 或 OS 探测。
 */
import { isQoderEndpointPreference, type QoderEndpointPreference } from '../../../shared/channels.ts'
import { ChannelSearchError } from '../../search/errors.ts'
import {
  QoderSearchProtocolError,
  type QoderProtocolFailureCode,
} from './protocol.ts'

/** 国际版允许的两个搜索域；顺序即自动模式的默认优先级。 */
export const QODER_INTERNATIONAL_HOSTS = ['center.qoder.sh', 'api2.qoder.sh'] as const

/** 国际版搜索域名。 */
export type QoderInternationalHost = (typeof QODER_INTERNATIONAL_HOSTS)[number]

/** 自动模式在进程启动时的初始首选域。 */
export const QODER_AUTO_INITIAL_HOST: QoderInternationalHost = 'center.qoder.sh'

const CENTER_HOST: QoderInternationalHost = 'center.qoder.sh'
const API2_HOST: QoderInternationalHost = 'api2.qoder.sh'

/** 本层能够归因的失败类别；观察记录与聚合错误只使用这些值。 */
export type QoderEndpointFailureCategory =
  | 'connection'
  | 'timeout'
  | 'server_error'
  | 'unauthorized'
  | 'rate_limited'
  | 'bad_response'
  | 'signing'
  | 'config'
  | 'no_account'
  | 'aborted'
  | 'other'

/** 单次尝试的脱敏观察记录；不含 query、凭据或请求头。 */
export interface QoderEndpointAttempt {
  readonly host: QoderInternationalHost
  readonly outcome: 'succeeded' | 'failed'
  /** 失败类别；成功时为 undefined。 */
  readonly failure?: QoderEndpointFailureCategory
  /** 上游 HTTP 状态（收到响应时才有）。 */
  readonly status?: number
  /** 本域耗时（毫秒，非负）。 */
  readonly durationMs: number
}

/** 一次 `execute` 的脱敏观察记录；配置区据此显示「本次实际使用」。 */
export interface QoderEndpointObservation {
  readonly preference: QoderEndpointPreference
  readonly outcome: 'succeeded' | 'failed'
  /** 实际成功的域名；失败时为 undefined。 */
  readonly host?: QoderInternationalHost
  readonly attempts: readonly QoderEndpointAttempt[]
}

/** `operation` 只收到域名，拿不到账号/凭据，结构上无法在切换时换账号。 */
export interface QoderEndpointOperationContext {
  readonly host: QoderInternationalHost
}

/** `execute` 的入参形状（与计划一致）。 */
export interface QoderEndpointExecuteInput<T> {
  readonly preference: QoderEndpointPreference
  /** 账号库中的稳定账号 ID；只用于粘性键，不进入错误或观察记录。 */
  readonly accountKey: string
  /** 用同一账号、同一 query 发往指定域的一次尝试。 */
  readonly operation: (context: QoderEndpointOperationContext) => Promise<T>
  readonly signal: AbortSignal
  /** 真实用户搜索默认为 true；capability probe 必须为 false，禁止写持久路由。 */
  readonly rememberSuccess?: boolean
  /** invocation-bound 持久化门禁；可携带本次 selection generation。 */
  readonly writeLastSuccessfulHost?: (
    host: QoderInternationalHost,
    signal: AbortSignal,
  ) => Promise<'written' | 'stale' | void>
  /** invocation-bound observation；闭包携带 Host 内部选择代际，不进入 DTO。 */
  readonly onObservation?: (observation: QoderEndpointObservation) => void
}

/** R43：单一本机全局路由值；fixed 不调用这两个依赖。 */
export interface QoderEndpointPolicyDeps {
  readonly readLastSuccessfulHost?: () => QoderInternationalHost | null
    | Promise<QoderInternationalHost | null>
  readonly writeLastSuccessfulHost?: (
    host: QoderInternationalHost,
    signal: AbortSignal,
  ) => Promise<'written' | 'stale' | void>
  /** 脱敏观察钩子；抛错会被吞掉，绝不影响搜索本身。 */
  readonly onObservation?: (observation: QoderEndpointObservation) => void
}

/** 结构化失败分类；只有 `retryable` 为 true 才允许跨域切换。 */
export interface QoderEndpointFailureClassification {
  readonly category: QoderEndpointFailureCategory
  readonly retryable: boolean
  readonly status?: number
}

/**
 * 两域都失败时的可归因错误。
 *
 * 只带结构化类别与域名，不带 query、凭据、签名头或底层异常原文（R16）。
 */
export class QoderEndpointUnavailableError extends Error {
  override readonly name = 'QoderEndpointUnavailableError'

  constructor(
    /** 可路由类别：两域都超时为 `TIMEOUT`，否则 `SEARCH_FAILED`。 */
    readonly code: QoderProtocolFailureCode,
    message: string,
    readonly attempts: readonly QoderEndpointAttempt[],
    /** 第二域为非换域类错误时保留其可信状态与 host；聚合连接错误时为 undefined。 */
    readonly httpStatus?: number,
    readonly host?: QoderInternationalHost,
  ) {
    super(message)
  }
}

/**
 * 把任意失败映射为可切换判定。
 *
 * ⚠️ 只信共享协议层的结构化 `kind`/`status`：`SEARCH_FAILED` 同时覆盖连接失败、
 * 签名失败与配置错误，靠消息文本猜测会误切换。
 */
export function classifyQoderEndpointFailure(error: unknown): QoderEndpointFailureClassification {
  if (error instanceof ChannelSearchError) {
    const status = error.httpStatus
    if (error.code === 'TIMEOUT') return { category: 'timeout', retryable: true, ...statusOption(status) }
    if (error.code === 'UNAUTHORIZED') return { category: 'unauthorized', retryable: false, ...statusOption(status) }
    if (error.code === 'RATE_LIMITED') return { category: 'rate_limited', retryable: false, ...statusOption(status) }
    if (error.code === 'BAD_RESPONSE') return { category: 'bad_response', retryable: false, ...statusOption(status) }
    if (error.code === 'NO_ACCOUNT') return { category: 'no_account', retryable: false, ...statusOption(status) }
    if (status !== undefined && status >= 500) {
      return { category: 'server_error', retryable: true, status }
    }
    return { category: 'other', retryable: false, ...statusOption(status) }
  }
  if (!(error instanceof QoderSearchProtocolError)) {
    // 未知异常（含第三方包装错误）默认不可切换。
    return { category: 'other', retryable: false }
  }
  const status = error.status
  switch (error.kind) {
    case 'connection':
      return { category: 'connection', retryable: true }
    case 'timeout':
      return { category: 'timeout', retryable: true }
    case 'http_status':
      return classifyHttpStatus(status)
    case 'bad_response':
      return { category: 'bad_response', retryable: false, ...statusOption(status) }
    case 'signing':
      return { category: 'signing', retryable: false, ...statusOption(status) }
    case 'config':
      return { category: 'config', retryable: false, ...statusOption(status) }
    case 'no_account':
      return { category: 'no_account', retryable: false, ...statusOption(status) }
    case 'aborted':
      return { category: 'aborted', retryable: false, ...statusOption(status) }
    default:
      return { category: 'other', retryable: false, ...statusOption(status) }
  }
}

/**
 * 只有上游 5xx 可跨域；401/403/429 与其他 4xx 都不切换。
 *
 * ⚠️ HTTP 408 等 4xx 也按「其他」处理：可切换的超时只认共享协议层已归因的
 * `timeout` 阶段（本层 20s 预算或宿主 deadline），不从 HTTP 状态反推。
 */
function classifyHttpStatus(status: number | undefined): QoderEndpointFailureClassification {
  if (status !== undefined && status >= 500) {
    return { category: 'server_error', retryable: true, status }
  }
  if (status === 401 || status === 403) {
    return { category: 'unauthorized', retryable: false, ...statusOption(status) }
  }
  if (status === 429) {
    return { category: 'rate_limited', retryable: false, status }
  }
  return { category: 'other', retryable: false, ...statusOption(status) }
}

/**
 * 双域端点策略实例。
 *
 * 本实例缓存唯一全局值；新 activation 从 Host 持久最近成功域开始，缺失才回 center。
 */
export class QoderEndpointPolicy {
  /** R43：只有一个有界全局值，不按账号/网络建 Map。 */
  private lastSuccessfulHost: QoderInternationalHost | null = null
  private routeInitialized = false

  constructor(private readonly deps: QoderEndpointPolicyDeps) {}

  /**
   * 执行一次搜索；返回 `operation` 的值，失败时抛出可归因错误。
   *
   * 固定模式只调用 `operation` 一次；自动模式在限定故障下最多调用两次
   * （两域各一次，严格顺序）。
   */
  async execute<T>(input: QoderEndpointExecuteInput<T>): Promise<T> {
    const preference = requirePreference(input.preference)
    requireAccountKey(input.accountKey)
    // fixed 不读取持久路由；auto 从本机唯一全局值开始，账号切换不影响它。
    const hosts = await this.hostsFor(preference)
    const attempts: QoderEndpointAttempt[] = []

    let firstError: unknown
    try {
      const value = await this.runAttempt(hosts[0]!, input.operation, attempts)
      await this.rememberSuccessfulHost(input, hosts[0]!)
      this.report({ preference, outcome: 'succeeded', host: hosts[0]!, attempts: [...attempts] }, input.onObservation)
      return value
    } catch (error) {
      firstError = error
    }

    // 固定模式（hosts 只有一个）绝不切换；非限定错误与调用方取消也不切换。
    const classification = classifyQoderEndpointFailure(firstError)
    if (hosts.length === 1 || !classification.retryable || isAborted(input.signal)) {
      this.report({ preference, outcome: 'failed', attempts: [...attempts] }, input.onObservation)
      throw firstError
    }

    // 自动模式：首域 settle 之后顺序尝试另一域，且只尝试这一次。
    const fallbackHost = hosts[1]!
    try {
      const value = await this.runAttempt(fallbackHost, input.operation, attempts)
      await this.rememberSuccessfulHost(input, fallbackHost)
      this.report({ preference, outcome: 'succeeded', host: fallbackHost, attempts: [...attempts] }, input.onObservation)
      return value
    } catch (secondError) {
      this.report({ preference, outcome: 'failed', attempts: [...attempts] }, input.onObservation)
      const secondClassification = classifyQoderEndpointFailure(secondError)
      // 第二域 401/403/429/bad response 等必须保留自己的结构化归因；只有两个
      // 都属于允许换域类时才聚合为双域连接/服务失败。
      if (!secondClassification.retryable
        && (secondError instanceof QoderSearchProtocolError || secondError instanceof ChannelSearchError)) {
        throw new QoderEndpointUnavailableError(
          secondError.code === 'INVALID_ARGUMENTS' ? 'SEARCH_FAILED' : secondError.code,
          secondError.message,
          [...attempts],
          secondClassification.status,
          fallbackHost,
        )
      }
      throw new QoderEndpointUnavailableError(
        aggregateFailureCode(attempts),
        aggregateFailureMessage(attempts),
        [...attempts],
      )
    }
  }

  /** 本次调用允许的域名顺序；固定模式只有一个且绝不读取持久路由。 */
  private async hostsFor(
    preference: QoderEndpointPreference,
  ): Promise<readonly QoderInternationalHost[]> {
    if (preference === 'center') return [CENTER_HOST]
    if (preference === 'api2') return [API2_HOST]
    // 有持久 writer 时可重读 volatile 值；纯内存策略在首次读取后使用唯一缓存，
    // 避免一个返回 null 的 reader 把刚成功的内存值覆盖掉。
    if (this.deps.writeLastSuccessfulHost !== undefined || !this.routeInitialized) {
      let persisted: QoderInternationalHost | null | undefined
      try {
        persisted = await this.deps.readLastSuccessfulHost?.()
      } catch {
        throw new ChannelSearchError(
          'SEARCH_FAILED',
          'qoder',
          'Qoder international search could not read the last successful host',
        )
      }
      if (persisted !== undefined) this.lastSuccessfulHost = persisted
      this.routeInitialized = true
    }
    const sticky = this.lastSuccessfulHost ?? QODER_AUTO_INITIAL_HOST
    return sticky === CENTER_HOST ? [CENTER_HOST, API2_HOST] : [API2_HOST, CENTER_HOST]
  }

  /** 真实用户 auto 成功后才更新；probe 与 fixed 都不写全局路由。 */
  private async rememberSuccessfulHost<T>(
    input: QoderEndpointExecuteInput<T>,
    host: QoderInternationalHost,
  ): Promise<void> {
    if (input.preference !== 'auto' || input.rememberSuccess === false) return
    const write = input.writeLastSuccessfulHost ?? this.deps.writeLastSuccessfulHost
    if (write === undefined) {
      if (input.signal.aborted) throw qoderCancellationFailure(input.signal)
      this.lastSuccessfulHost = host
      return
    }
    let result: 'written' | 'stale' | void
    try {
      result = await write(host, input.signal)
    } catch {
      // 只吞普通非取消持久化失败；caller/root cancellation 必须继续归因。
      if (input.signal.aborted) throw qoderCancellationFailure(input.signal)
      return
    }
    if (input.signal.aborted) throw qoderCancellationFailure(input.signal)
    if (result !== 'stale') this.lastSuccessfulHost = host
  }

  /** 一次尝试：计时、记录脱敏结果，然后把原始错误继续抛出。 */
  private async runAttempt<T>(
    host: QoderInternationalHost,
    operation: (context: QoderEndpointOperationContext) => Promise<T>,
    attempts: QoderEndpointAttempt[],
  ): Promise<T> {
    const startedAt = Date.now()
    try {
      const value = await operation({ host })
      attempts.push({ host, outcome: 'succeeded', durationMs: elapsedSince(startedAt) })
      return value
    } catch (error) {
      const classification = classifyQoderEndpointFailure(error)
      attempts.push({
        host,
        outcome: 'failed',
        failure: classification.category,
        ...statusOption(classification.status),
        durationMs: elapsedSince(startedAt),
      })
      throw error
    }
  }

  /** 观察钩子只用于脱敏状态；它失败绝不能影响搜索结果。 */
  private report(
    observation: QoderEndpointObservation,
    invocationHook?: (observation: QoderEndpointObservation) => void,
  ): void {
    const hook = invocationHook ?? this.deps.onObservation
    if (hook === undefined) return
    try {
      hook(observation)
    } catch {
      /* 静默：状态上报失败不改变搜索结论 */
    }
  }
}

/** 两域都失败时的可路由类别：都超时才是 TIMEOUT。 */
function aggregateFailureCode(attempts: readonly QoderEndpointAttempt[]): QoderProtocolFailureCode {
  return attempts.length > 0 && attempts.every(attempt => attempt.failure === 'timeout')
    ? 'TIMEOUT'
    : 'SEARCH_FAILED'
}

/** 两域都失败时的固定模板：只含域名、类别与 HTTP 状态。 */
function aggregateFailureMessage(attempts: readonly QoderEndpointAttempt[]): string {
  const details = attempts
    .map((attempt) => {
      const category = attempt.failure ?? 'other'
      const status = attempt.status === undefined ? '' : ` (HTTP ${attempt.status})`
      return `${attempt.host}: ${category}${status}`
    })
    .join('; ')
  return `qoder search failed on both endpoints (${details})`
}

function qoderCancellationFailure(signal: AbortSignal): QoderSearchProtocolError {
  const reason = signal.reason as { name?: unknown; code?: unknown } | undefined
  const timeout = reason?.name === 'TimeoutReason'
    || reason?.name === 'TimeoutError'
    || reason?.code === 'TOOL_TIMEOUT'
  return new QoderSearchProtocolError(
    timeout ? 'TIMEOUT' : 'SEARCH_FAILED',
    timeout
      ? 'qoder search timed out before this search returned (the host tool budget elapsed)'
      : 'qoder search aborted by the caller',
    'aborted',
  )
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt)
}

function statusOption(status: number | undefined): { readonly status?: number } {
  return status === undefined ? {} : { status }
}

function isAborted(signal: AbortSignal): boolean {
  return signal === undefined || signal === null || signal.aborted
}

function requirePreference(value: QoderEndpointPreference): QoderEndpointPreference {
  if (!isQoderEndpointPreference(value)) {
    throw new ChannelSearchError(
      'INVALID_ARGUMENTS',
      'qoder',
      'Qoder international search received an unsupported endpoint preference',
    )
  }
  return value
}

function requireAccountKey(value: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed.length === 0) {
    throw new ChannelSearchError(
      'INVALID_ARGUMENTS',
      'qoder',
      'Qoder international search requires a stable account key for endpoint stickiness',
    )
  }
  return trimmed
}
