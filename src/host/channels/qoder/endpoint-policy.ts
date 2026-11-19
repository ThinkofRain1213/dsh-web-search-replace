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
 * - **粘性**：成功的域成为「该账号 + 该网络出口」在当前进程内的首选；重启回
 *   center；固定模式不写入粘性；不同账号、不同出口互不共享。
 * - **可归因**：单 query 每域最多一次；两域都失败时抛出含两个域名与结构化类别
 *   的安全错误（不含 query、凭据、账号键、网络出口键或底层异常原文）。
 *
 * ## 明确不做
 *
 * 不做并行双发、后台测速、周期性探测、延迟评分或滞回窗口；不自动探测 OS 网络。
 * `networkExitKey` 由外部显式注入，本层只把它并入粘性键。
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
}

/** 策略依赖：网络出口键必须显式注入，本层不探测 OS 网络。 */
export interface QoderEndpointPolicyDeps {
  /**
   * 当前网络出口的稳定标识；每次 `execute` 解析一次并并入粘性键。
   *
   * 生产实现由调用方提供（例如用户配置的网络出口 ID）；本层绝不自动探测或
   * 伪造「已识别网络出口」。
   */
  readonly networkExitKey: () => string
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
 * 粘性只保存在本实例（= 当前进程）内；实例重建即回到 center。
 */
export class QoderEndpointPolicy {
  /** 粘性键：`accountKey\0networkExitKey` → 最近成功域名。 */
  private readonly stickyHosts = new Map<string, QoderInternationalHost>()

  constructor(private readonly deps: QoderEndpointPolicyDeps) {}

  /**
   * 执行一次搜索；返回 `operation` 的值，失败时抛出可归因错误。
   *
   * 固定模式只调用 `operation` 一次；自动模式在限定故障下最多调用两次
   * （两域各一次，严格顺序）。
   */
  async execute<T>(input: QoderEndpointExecuteInput<T>): Promise<T> {
    const preference = requirePreference(input.preference)
    const accountKey = requireAccountKey(input.accountKey)
    // 网络出口键只服务于 auto 粘性：固定模式没有粘性语义，绝不能读取该依赖，
    // 否则一个与固定端点无关的 resolver 故障会阻断搜索（修复轮 1 / I1）。
    const stickyKey = preference === 'auto'
      ? `${accountKey}\u0000${requireNetworkExitKey(this.deps)}`
      : ''
    const hosts = this.hostsFor(preference, stickyKey)
    const attempts: QoderEndpointAttempt[] = []

    let firstError: unknown
    try {
      const value = await this.runAttempt(hosts[0]!, input.operation, attempts)
      this.rememberSuccessfulHost(preference, stickyKey, hosts[0]!)
      this.report({ preference, outcome: 'succeeded', host: hosts[0]!, attempts: [...attempts] })
      return value
    } catch (error) {
      firstError = error
    }

    // 固定模式（hosts 只有一个）绝不切换；非限定错误与调用方取消也不切换。
    const classification = classifyQoderEndpointFailure(firstError)
    if (hosts.length === 1 || !classification.retryable || isAborted(input.signal)) {
      this.report({ preference, outcome: 'failed', attempts: [...attempts] })
      throw firstError
    }

    // 自动模式：首域 settle 之后顺序尝试另一域，且只尝试这一次。
    const fallbackHost = hosts[1]!
    try {
      const value = await this.runAttempt(fallbackHost, input.operation, attempts)
      this.rememberSuccessfulHost(preference, stickyKey, fallbackHost)
      this.report({ preference, outcome: 'succeeded', host: fallbackHost, attempts: [...attempts] })
      return value
    } catch {
      this.report({ preference, outcome: 'failed', attempts: [...attempts] })
      throw new QoderEndpointUnavailableError(
        aggregateFailureCode(attempts),
        aggregateFailureMessage(attempts),
        [...attempts],
      )
    }
  }

  /** 本次调用允许的域名顺序；固定模式只有一个。 */
  private hostsFor(
    preference: QoderEndpointPreference,
    stickyKey: string,
  ): readonly QoderInternationalHost[] {
    if (preference === 'center') return [CENTER_HOST]
    if (preference === 'api2') return [API2_HOST]
    const sticky = this.stickyHosts.get(stickyKey) ?? QODER_AUTO_INITIAL_HOST
    return sticky === CENTER_HOST ? [CENTER_HOST, API2_HOST] : [API2_HOST, CENTER_HOST]
  }

  /** 只有自动模式的成功域成为粘性首选；固定模式不污染 auto 粘性。 */
  private rememberSuccessfulHost(
    preference: QoderEndpointPreference,
    stickyKey: string,
    host: QoderInternationalHost,
  ): void {
    if (preference !== 'auto') return
    this.stickyHosts.set(stickyKey, host)
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
  private report(observation: QoderEndpointObservation): void {
    const hook = this.deps.onObservation
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

/**
 * 解析网络出口键。
 *
 * 失败时 fail-closed：宁可本次搜索失败，也不在没有出口标识时把不同网络的粘性
 * 混在一起。错误消息固定，不透传底层异常原文（可能含环境信息）。
 */
function requireNetworkExitKey(deps: QoderEndpointPolicyDeps): string {
  let value: unknown
  try {
    value = deps.networkExitKey()
  } catch {
    throw networkExitKeyFailure()
  }
  const key = typeof value === 'string' ? value.trim() : ''
  if (key.length === 0) throw networkExitKeyFailure()
  return key
}

function networkExitKeyFailure(): ChannelSearchError {
  return new ChannelSearchError(
    'SEARCH_FAILED',
    'qoder',
    'Qoder international search could not resolve the network exit key',
  )
}
