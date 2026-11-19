/**
 * 腾讯系 external-link-v2 授权协议底层状态机。
 *
 * 只实现 CodeBuddy / WorkBuddy 共用的 HTTP 形状：auth/state → 轮询 token →
 * 轮询 account，以及 refresh。产品 platform、endpoint、域名和 User-Agent 全部
 * 由调用方注入，本文件不内置任何产品参数，也不读写账号记录。
 *
 * 安全与可测性约束：
 * - 所有网络经可注入 fetcher；时钟、sleep、请求超时信号同样可注入；
 * - 任何错误都使用固定消息，不携带上游响应正文、异常原文或 cause；
 * - 取消通过 AbortSignal 传播，取消后不再继续解析或返回令牌；
 * - 轮询网络错误可继续重试，但整体 deadline 由调用方控制。
 */

/** 腾讯 external-link 底层错误类别。 */
export type TencentExternalLinkErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'request-timeout'
  | 'invalid-response'
  | 'failed'
  | 'temporary'
  | 'reauth-required'

/** 腾讯 external-link 底层错误；消息固定，不携带 cause。 */
export class TencentExternalLinkError extends Error {
  override readonly name = 'TencentExternalLinkError'

  constructor(
    readonly code: TencentExternalLinkErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** 可注入时钟；sleep 必须在 signal abort 时尽快 reject。 */
export interface TencentExternalLinkClock {
  now(): number
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

/** 一个腾讯系产品的协议参数；本文件不提供任何内置产品。 */
export interface TencentExternalLinkProduct {
  readonly platform: string
  readonly endpoint: string
  readonly apiDomain: string
  readonly userAgent: string
  /**
   * authUrl 允许的精确 host 列表；必须由产品显式提供，本文件不做后缀匹配。
   * 空列表意味着所有 authUrl 都失败（fail-closed）。
   */
  readonly authUrlHosts: readonly string[]
}

/** 构造 external-link 客户端的依赖。 */
export interface TencentExternalLinkOptions {
  readonly product: TencentExternalLinkProduct
  /** 测试注入；生产默认使用全局 fetch。 */
  readonly fetcher?: typeof fetch
  /** 测试注入；生产默认使用 Date.now + 可 abort 的 setTimeout。 */
  readonly clock?: TencentExternalLinkClock
  /** 单次普通请求超时；默认 60s。 */
  readonly requestTimeoutMs?: number
  /** auth/state 请求超时；默认 10s。 */
  readonly stateRequestTimeoutMs?: number
  /** 请求超时信号工厂；测试可注入永不触发的信号。 */
  readonly timeoutSignal?: (ms: number) => AbortSignal
}

/** 令牌数据；字段名与厂商响应保持 camelCase。 */
export interface TencentToken {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAtMs?: number
  readonly refreshExpiresAtMs?: number
  readonly tokenType: string
  readonly scope: string
  readonly domain: string
}

/** 账户数据。 */
export interface TencentAccount {
  readonly uid: string
  readonly nickname: string
  readonly enterpriseId: string
  readonly accountType: string
}

/** 轮询参数；deadline 是绝对毫秒时间。 */
export interface TencentPollOptions {
  readonly signal: AbortSignal
  readonly deadline: number
  readonly pollIntervalMs: number
}

/** 刷新参数。 */
export interface TencentRefreshInput {
  readonly accessToken: string
  readonly refreshToken: string
  readonly signal: AbortSignal
}

/** 固定路径。 */
export const AUTH_STATE_PATH = '/v2/plugin/auth/state'
export const AUTH_TOKEN_PATH = '/v2/plugin/auth/token'
export const LOGIN_ACCOUNT_PATH = '/v2/plugin/login/account'
export const AUTH_REFRESH_PATH = '/v2/plugin/auth/token/refresh'

/** 厂商「尚未就绪」错误码。 */
export const CODE_TOKEN_NOT_READY = 11217
export const CODE_ACCOUNT_NOT_READY = 12151

/** 刷新请求的固定来源头值。 */
export const AUTH_REFRESH_SOURCE = 'ide-main'

/** 请求头名。 */
const HEADER_DOMAIN = 'X-Domain'
const HEADER_NO_AUTHORIZATION = 'X-No-Authorization'
const HEADER_NO_USER_ID = 'X-No-User-Id'
const HEADER_NO_ENTERPRISE_ID = 'X-No-Enterprise-Id'
const HEADER_NO_DEPARTMENT_INFO = 'X-No-Department-Info'
const HEADER_REFRESH_TOKEN = 'X-Refresh-Token'
const HEADER_AUTH_REFRESH_SOURCE = 'X-Auth-Refresh-Source'

/** 固定错误消息；任何上游文本都不得进入这里。 */
const MESSAGE_CANCELLED = 'external-link authorization was cancelled'
const MESSAGE_TIMEOUT = 'external-link authorization timed out'
const MESSAGE_STATE_FAILED = 'external-link authorization state request failed'
const MESSAGE_INVALID = 'external-link authorization response was invalid'
const MESSAGE_POLL_FAILED = 'external-link authorization polling was rejected'
const MESSAGE_REFRESH_FAILED = 'external-link credential refresh failed'
const MESSAGE_REAUTH_REQUIRED = 'external-link credential must be renewed'
const MESSAGE_NETWORK = 'external-link request failed'

/** 默认时钟；sleep 在 abort 时立即 reject，避免取消后继续轮询。 */
export const SYSTEM_CLOCK: TencentExternalLinkClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new TencentExternalLinkError('cancelled', MESSAGE_CANCELLED))
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, Math.max(0, ms))
    ;(timer as { unref?: () => void }).unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(new TencentExternalLinkError('cancelled', MESSAGE_CANCELLED))
    }
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // 覆盖「检查 aborted 之后、挂监听之前」的竞态；否则取消最多要等一个轮询间隔。
    if (signal.aborted) onAbort()
  }),
}

/** 腾讯 external-link 协议客户端；不持有账号或产品刷新状态。 */
export class TencentExternalLinkClient {
  private readonly product: TencentExternalLinkProduct
  private readonly fetcher: typeof fetch
  private readonly clock: TencentExternalLinkClock
  private readonly requestTimeoutMs: number
  private readonly stateRequestTimeoutMs: number
  private readonly timeoutSignal: (ms: number) => AbortSignal

  constructor(options: TencentExternalLinkOptions) {
    this.product = options.product
    this.fetcher = options.fetcher ?? fetch
    this.clock = options.clock ?? SYSTEM_CLOCK
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000
    this.stateRequestTimeoutMs = options.stateRequestTimeoutMs ?? 10_000
    this.timeoutSignal = options.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms))
  }

  /** POST auth/state；返回 state 与已校验为 https 的 authUrl。 */
  async fetchAuthState(signal: AbortSignal): Promise<{ state: string; authUrl: string }> {
    const url = `${this.product.endpoint}${AUTH_STATE_PATH}?platform=${encodeURIComponent(this.product.platform)}`
    const { status, body } = await this.request(
      'POST',
      url,
      {
        [HEADER_DOMAIN]: this.product.apiDomain,
        [HEADER_NO_AUTHORIZATION]: 'true',
        [HEADER_NO_USER_ID]: 'true',
        [HEADER_NO_ENTERPRISE_ID]: 'true',
        [HEADER_NO_DEPARTMENT_INFO]: 'true',
        'User-Agent': this.product.userAgent,
      },
      signal,
      this.stateRequestTimeoutMs,
    )
    if (status !== 200) {
      throw new TencentExternalLinkError('failed', MESSAGE_STATE_FAILED)
    }
    const data = responseData(body)
    if (!isRecord(data)) {
      throw new TencentExternalLinkError('invalid-response', MESSAGE_INVALID)
    }
    const state = normalizeState(data.state)
    const authUrl = normalizeTencentAuthUrl(data.authUrl, this.product.authUrlHosts)
    if (state === undefined || authUrl === undefined) {
      throw new TencentExternalLinkError('invalid-response', MESSAGE_INVALID)
    }
    return { state, authUrl }
  }

  /** 轮询 auth/token 直到拿到 accessToken 或整体 deadline 到期。 */
  async pollToken(state: string, options: TencentPollOptions): Promise<TencentToken> {
    const url = `${this.product.endpoint}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`
    const headers = {
      [HEADER_NO_AUTHORIZATION]: 'true',
      'User-Agent': this.product.userAgent,
    }
    for (;;) {
      this.throwIfAborted(options.signal)
      if (this.clock.now() >= options.deadline) {
        throw new TencentExternalLinkError('timeout', MESSAGE_TIMEOUT)
      }
      await this.sleep(options.pollIntervalMs, options.signal)
      this.throwIfAborted(options.signal)
      if (this.clock.now() >= options.deadline) {
        throw new TencentExternalLinkError('timeout', MESSAGE_TIMEOUT)
      }

      let result: { readonly status: number; readonly body: unknown }
      try {
        result = await this.request('GET', url, headers, options.signal, this.requestTimeoutMs)
      } catch (error) {
        if (error instanceof TencentExternalLinkError
          && (error.code === 'cancelled' || error.code === 'timeout')) {
          throw error
        }
        // 网络错误与单次请求超时继续轮询，整体 deadline 负责收口。
        continue
      }

      if (result.status === 200) {
        const data = responseData(result.body)
        if (data === undefined) continue
        if (!isRecord(data)) {
          throw new TencentExternalLinkError('invalid-response', MESSAGE_INVALID)
        }
        return parseTokenData(data, this.clock.now())
      }
      if (responseCode(result.body) === CODE_TOKEN_NOT_READY) continue
      throw new TencentExternalLinkError('failed', MESSAGE_POLL_FAILED)
    }
  }

  /** 轮询 login/account 直到账户就绪；Bearer token 来自上一步。 */
  async pollAccount(
    state: string,
    token: TencentToken,
    options: TencentPollOptions,
  ): Promise<TencentAccount> {
    if (token.accessToken.length === 0) {
      throw new TencentExternalLinkError('invalid-response', MESSAGE_INVALID)
    }
    const url = `${this.product.endpoint}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`
    const headers = {
      [HEADER_DOMAIN]: token.domain.length > 0 ? token.domain : this.product.apiDomain,
      Authorization: `Bearer ${token.accessToken}`,
      [HEADER_NO_USER_ID]: 'true',
      [HEADER_NO_ENTERPRISE_ID]: 'true',
      'User-Agent': this.product.userAgent,
    }
    for (;;) {
      this.throwIfAborted(options.signal)
      if (this.clock.now() >= options.deadline) {
        throw new TencentExternalLinkError('timeout', MESSAGE_TIMEOUT)
      }
      await this.sleep(options.pollIntervalMs, options.signal)
      this.throwIfAborted(options.signal)
      if (this.clock.now() >= options.deadline) {
        throw new TencentExternalLinkError('timeout', MESSAGE_TIMEOUT)
      }

      let result: { readonly status: number; readonly body: unknown }
      try {
        result = await this.request('GET', url, headers, options.signal, this.requestTimeoutMs)
      } catch (error) {
        if (error instanceof TencentExternalLinkError
          && (error.code === 'cancelled' || error.code === 'timeout')) {
          throw error
        }
        continue
      }

      if (result.status === 200) {
        const data = responseData(result.body)
        if (data === undefined) continue
        if (!isRecord(data)) {
          throw new TencentExternalLinkError('invalid-response', MESSAGE_INVALID)
        }
        return parseAccountData(data)
      }
      if (responseCode(result.body) === CODE_ACCOUNT_NOT_READY) continue
      throw new TencentExternalLinkError('failed', MESSAGE_POLL_FAILED)
    }
  }

  /** POST auth/token/refresh；401/403 归为 reauth-required。 */
  async refresh(input: TencentRefreshInput): Promise<TencentToken> {
    if (input.accessToken.length === 0 || input.refreshToken.length === 0) {
      throw new TencentExternalLinkError('reauth-required', MESSAGE_REAUTH_REQUIRED)
    }
    const url = `${this.product.endpoint}${AUTH_REFRESH_PATH}`
    let result: { readonly status: number; readonly body: unknown }
    try {
      result = await this.request(
        'POST',
        url,
        {
          [HEADER_DOMAIN]: this.product.apiDomain,
          'User-Agent': this.product.userAgent,
          Authorization: `Bearer ${input.accessToken}`,
          [HEADER_REFRESH_TOKEN]: input.refreshToken,
          [HEADER_AUTH_REFRESH_SOURCE]: AUTH_REFRESH_SOURCE,
        },
        input.signal,
        this.requestTimeoutMs,
      )
    } catch (error) {
      if (error instanceof TencentExternalLinkError) {
        if (error.code === 'cancelled') throw error
        if (error.code === 'request-timeout' || error.code === 'temporary') {
          throw new TencentExternalLinkError('temporary', MESSAGE_REFRESH_FAILED)
        }
      }
      throw new TencentExternalLinkError('temporary', MESSAGE_REFRESH_FAILED)
    }

    if (result.status === 401 || result.status === 403) {
      throw new TencentExternalLinkError('reauth-required', MESSAGE_REAUTH_REQUIRED)
    }
    if (result.status !== 200) {
      throw new TencentExternalLinkError('temporary', MESSAGE_REFRESH_FAILED)
    }
    const data = responseData(result.body)
    if (!isRecord(data)) {
      throw new TencentExternalLinkError('invalid-response', MESSAGE_INVALID)
    }
    return parseTokenData(data, this.clock.now())
  }

  /** 发起一次控制面请求；响应体只解析 JSON，不把文本带入错误。 */
  private async request(
    method: 'GET' | 'POST',
    url: string,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    if (signal.aborted) {
      throw new TencentExternalLinkError('cancelled', MESSAGE_CANCELLED)
    }
    const timeout = this.timeoutSignal(timeoutMs)
    const composed = AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await this.fetcher(url, {
        method,
        headers,
        signal: composed,
        // 控制面请求绝不跟随 3xx：跨源/降级重定向不得转发 Authorization、
        // X-Refresh-Token 或其他秘密。3xx 会以 fetch TypeError 进入固定错误映射。
        redirect: 'error',
      })
    } catch {
      if (signal.aborted) throw new TencentExternalLinkError('cancelled', MESSAGE_CANCELLED)
      if (timeout.aborted) {
        throw new TencentExternalLinkError('request-timeout', MESSAGE_NETWORK)
      }
      throw new TencentExternalLinkError('temporary', MESSAGE_NETWORK)
    }
    if (signal.aborted) {
      throw new TencentExternalLinkError('cancelled', MESSAGE_CANCELLED)
    }
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    if (signal.aborted) {
      throw new TencentExternalLinkError('cancelled', MESSAGE_CANCELLED)
    }
    return { status: response.status, body }
  }

  /** 取消检查。 */
  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new TencentExternalLinkError('cancelled', MESSAGE_CANCELLED)
    }
  }

  /** 可注入 sleep；取消时由时钟或下一轮检查收口。 */
  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    await this.clock.sleep(ms, signal)
  }
}

/** 读取响应体 code 字段。 */
function responseCode(body: unknown): number {
  if (!isRecord(body)) return 0
  return typeof body.code === 'number' ? body.code : 0
}

/** 读取响应体 data 字段；null 视为缺失。 */
function responseData(body: unknown): unknown {
  if (!isRecord(body)) return undefined
  return body.data === null ? undefined : body.data
}

/** 安全读取字符串字段并清理控制字符。 */
function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value === 'string') return stripControlChars(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 安全读取数字字段，兼容数字型字符串。 */
function readNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

/** 去掉控制字符并折叠空白。 */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** 解析 auth/token 与 refresh 的令牌数据；缺少 accessToken 视为无效。 */
function parseTokenData(record: Record<string, unknown>, now: number): TencentToken {
  const accessToken = readStringField(record, 'accessToken')
  if (accessToken.length === 0) {
    throw new TencentExternalLinkError('invalid-response', MESSAGE_INVALID)
  }
  const tokenType = readStringField(record, 'tokenType')
  const expiresAtMs = absoluteExpiryMs(record, 'expiresAt', 'expiresIn', accessToken, now)
  const refreshExpiresAtMs = absoluteExpiryMs(
    record,
    'refreshExpiresAt',
    'refreshExpiresIn',
    accessToken,
    now,
  )
  return Object.freeze({
    accessToken,
    refreshToken: readStringField(record, 'refreshToken'),
    ...expiresAtMs === undefined ? {} : { expiresAtMs },
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    tokenType: tokenType.length > 0 ? tokenType : 'Bearer',
    scope: readStringField(record, 'scope'),
    domain: readStringField(record, 'domain'),
  })
}

/** 解析 login/account 数据；缺 uid 由上层决定是否接受 JWT sub。 */
function parseAccountData(record: Record<string, unknown>): TencentAccount {
  const accountType = readStringField(record, 'type')
  return Object.freeze({
    uid: readStringField(record, 'uid'),
    nickname: readStringField(record, 'nickname'),
    enterpriseId: readStringField(record, 'enterpriseId'),
    accountType: accountType.length > 0 ? accountType : 'personal',
  })
}

/**
 * 绝对过期时间（毫秒）。
 *
 * 优先绝对字段（毫秒/秒时间戳或 ISO），缺失时用 expiresIn/refreshExpiresIn
 * 相对秒数；相对基准优先 JWT iat，其次注入时钟的当前时刻。
 */
function absoluteExpiryMs(
  record: Record<string, unknown>,
  absoluteKey: string,
  relativeKey: string,
  accessToken: string,
  now: number,
): number | undefined {
  const absolute = readStringField(record, absoluteKey)
  if (absolute.length > 0) {
    if (/^\d+$/.test(absolute)) {
      const value = Number(absolute)
      return value > 1_000_000_000_000 ? value : value * 1000
    }
    const parsed = Date.parse(absolute)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  const relativeSeconds = readNumberField(record, relativeKey)
  if (relativeSeconds === undefined) return undefined
  return (jwtIssuedAtMs(accessToken) ?? now) + relativeSeconds * 1000
}

/** 从 JWT payload 读取 iat（秒）并换算毫秒；失败返回 undefined。 */
function jwtIssuedAtMs(token: string): number | undefined {
  const payload = jwtPayload(token)
  return typeof payload?.iat === 'number' && Number.isFinite(payload.iat)
    ? payload.iat * 1000
    : undefined
}

/**
 * 读取 JWT 声明；只做 base64url 解码，不验签。
 *
 * 该值只用于身份去重与展示名，不参与鉴权判断。非 JWT/解析失败返回 undefined。
 */
export function readJwtClaim(token: string, key: string): unknown {
  return jwtPayload(token)?.[key]
}

/** 从 JWT payload 读取任意对象；非 JWT/解析失败返回 undefined。 */
function jwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** state 只接受短的非控制字符串。 */
function normalizeState(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 256) return undefined
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined
  return trimmed
}

/**
 * authUrl 只接受产品显式允许的精确 host、https、无 userinfo、无自定义端口、
 * 无 fragment 的绝对 URL；不做后缀匹配。
 *
 * 导出给产品 flow 在追加登录 session 参数后做一次防御性复检；不允许因为
 * 装饰器实现错误而把 URL 指向其他 host。
 */
export function normalizeTencentAuthUrl(
  value: unknown,
  allowedHosts: readonly string[],
): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 2048) return undefined
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:') return undefined
    if (url.username.length > 0 || url.password.length > 0) return undefined
    if (url.port.length > 0 && url.port !== '443') return undefined
    if (url.hash.length > 0) return undefined
    if (!allowedHosts.includes(url.hostname)) return undefined
    return trimmed
  } catch {
    return undefined
  }
}

/** 判断普通数据对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
