/**
 * Qoder 设备授权（PKCE）共享协议层。
 *
 * 本文件只处理纯协议形状与可注入的产品参数：
 *
 * - 授权页 `{authBase}/device/selectAccounts`（PKCE + nonce + machine_id +
 *   产品 client_id）；
 * - 轮询 `{openApiBase}/api/v1/deviceToken/poll`（404 = 用户尚未授权）；
 * - 续期 `{openApiBase}/api/v1/deviceToken/refresh`（body 为
 *   `{refresh_token, machine_id}`，响应字段为 `device_token`）。
 *
 * 国际版默认参数为 `https://qoder.com` / `https://openapi.qoder.sh` / 精确
 * 国际版 client_id；中国版由 `qodercn/auth.ts` 注入自己的产品参数，绝不把
 * 两套参数混用。本文件不读写账号库、配置或 RPC，也不持有任何流程状态。
 *
 * 安全与可测性约束：
 * - 所有网络经可注入 fetcher；时钟、请求超时信号、PKCE 随机源与设备会话均可注入；
 * - 所有控制面请求 `redirect: 'error'`，绝不跟随 3xx 把秘密转发到其他 host；
 * - 任何错误都使用固定消息，不携带上游响应正文、异常原文或 cause；
 * - 授权 URL 只接受调用方注入的精确 host 白名单，不做后缀匹配。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'

/** 国际版授权页基址（与参考实现 `authBase` 一致）。 */
export const QODER_DEVICE_AUTH_BASE = 'https://qoder.com'

/** 国际版控制面基址（轮询与续期都走它）。 */
export const QODER_DEVICE_OPEN_API_BASE = 'https://openapi.qoder.sh'

/**
 * 国际版 prod client_id（参考实现 `QODER.clientId`，即源码 `J_a`）。
 *
 * ⚠️ 绝不能使用中国版 `732aef47-9cf2-46a2-95fe-4cebb5d0d1fa`；用错会让
 * 授权回调阶段被服务端拒绝。
 */
export const QODER_INTERNATIONAL_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb'

/** 授权页路径（挂 `QODER_DEVICE_AUTH_BASE`）。 */
export const QODER_DEVICE_SELECT_PATH = '/device/selectAccounts'

/** 设备码轮询路径（挂 `QODER_DEVICE_OPEN_API_BASE`）。 */
export const QODER_DEVICE_POLL_PATH = '/api/v1/deviceToken/poll'

/** 续期路径（挂 `QODER_DEVICE_OPEN_API_BASE`）。 */
export const QODER_DEVICE_REFRESH_PATH = '/api/v1/deviceToken/refresh'

/** 国际版授权 URL 允许的精确 host；空匹配/后缀匹配一律拒绝。 */
export const QODER_AUTH_URL_HOSTS = Object.freeze(['qoder.com'])

/**
 * 一个 Qoder 区域版本固定的设备授权产品参数。
 *
 * 只描述协议常量，不包含任何账号/流程状态；国际版与中国版各自持有独立实例，
 * 绝不把一套参数用于另一渠道。
 */
export interface QoderDeviceProduct {
  /** 授权页基址（浏览器 URL 的 origin）。 */
  readonly authBase: string
  /** 设备码轮询与续期基址。 */
  readonly openApiBase: string
  /** 精确产品 client_id。 */
  readonly clientId: string
  /** 授权 URL 允许的精确 host 白名单。 */
  readonly authUrlHosts: readonly string[]
}

/** 国际版固定产品参数（`QODER_DEVICE_AUTH_BASE` 等常量的结构化形式）。 */
export const QODER_INTERNATIONAL_PRODUCT: QoderDeviceProduct = Object.freeze({
  authBase: QODER_DEVICE_AUTH_BASE,
  openApiBase: QODER_DEVICE_OPEN_API_BASE,
  clientId: QODER_INTERNATIONAL_CLIENT_ID,
  authUrlHosts: QODER_AUTH_URL_HOSTS,
})

/** 设备授权整体预算（与参考实现 5 分钟一致）。 */
export const QODER_LOGIN_TIMEOUT_MS = 300_000

/** 轮询间隔（参考实现 1000ms）。 */
export const QODER_POLL_INTERVAL_MS = 1_000

/** 单次控制面请求超时（参考实现 30s）。 */
export const QODER_REQUEST_TIMEOUT_MS = 30_000

/** 控制面 `User-Agent`（与参考实现一致）。 */
export const QODER_USER_AGENT = 'qoder/1.0.0'

/** 可注入时钟；sleep 必须在 signal abort 时尽快 reject。 */
export interface QoderAuthClock {
  now(): number
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

/** 固定错误消息；任何上游文本都不得进入这里。 */
const MESSAGE_CANCELLED = 'qoder device authorization was cancelled'
const MESSAGE_TIMEOUT = 'qoder device authorization timed out'
const MESSAGE_INVALID = 'qoder device authorization response was invalid'
const MESSAGE_POLL_FAILED = 'qoder device authorization polling was rejected'
const MESSAGE_REFRESH_FAILED = 'qoder credential refresh failed'
const MESSAGE_REAUTH_REQUIRED = 'qoder credential must be renewed'
const MESSAGE_NETWORK = 'qoder device authorization request failed'

/** 设备授权/续期底层错误类别。 */
export type QoderDeviceTokenErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'request-timeout'
  | 'invalid-response'
  | 'failed'
  | 'temporary'
  | 'reauth-required'

/** 设备授权底层错误；消息固定，不携带 cause。 */
export class QoderDeviceTokenError extends Error {
  override readonly name = 'QoderDeviceTokenError'

  constructor(
    readonly code: QoderDeviceTokenErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** 默认时钟；sleep 在 abort 时立即 reject，避免取消后继续轮询。 */
export const SYSTEM_CLOCK: QoderAuthClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new QoderDeviceTokenError('cancelled', MESSAGE_CANCELLED))
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
      reject(new QoderDeviceTokenError('cancelled', MESSAGE_CANCELLED))
    }
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // 覆盖「检查 aborted 之后、挂监听之前」的竞态。
    if (signal.aborted) onAbort()
  }),
}

/** PKCE 字符集：RFC 7636 unreserved（共 66 个字符，与参考实现一致）。 */
const PKCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

/** 一次 PKCE 生成的结果。 */
export interface QoderPkce {
  /** 明文 verifier（轮询时提交）。 */
  readonly verifier: string
  /** `base64url(sha256(verifier))`，**无 padding**。 */
  readonly challenge: string
}

/** 可注入的 PKCE 随机源；测试用它生成确定性 verifier。 */
export interface QoderPkceEntropy {
  /** 生成长度为 `length` 的随机字节。 */
  readonly bytes: (length: number) => Uint8Array
  /** 生成本次 verifier 长度（43..128）。 */
  readonly length: () => number
}

/** 默认随机源。 */
const DEFAULT_PKCE_ENTROPY: QoderPkceEntropy = {
  bytes: (length) => randomBytes(length),
  length: () => 43 + Math.floor(86 * Math.random()),
}

/**
 * 生成 PKCE verifier / challenge。
 *
 * verifier 长度 43..128；challenge 用 `base64url(sha256(verifier))` 且去掉
 * padding —— 带 `=` 会让服务端校验失败。
 */
export function createQoderPkce(entropy: Partial<QoderPkceEntropy> = {}): QoderPkce {
  const bytes = entropy.bytes ?? DEFAULT_PKCE_ENTROPY.bytes
  const lengthOf = entropy.length ?? DEFAULT_PKCE_ENTROPY.length
  const rawLength = Math.floor(lengthOf())
  const length = Number.isFinite(rawLength) ? Math.min(128, Math.max(43, rawLength)) : 43
  const random = bytes(length)
  let verifier = ''
  for (let index = 0; index < length; index++) {
    const value = random[index] ?? 0
    verifier += PKCE_ALPHABET[value % PKCE_ALPHABET.length]
  }
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return Object.freeze({ verifier, challenge })
}

/** 一次设备登录会话；`machineId` 由本插件生成并随凭据持久化。 */
export interface QoderDeviceSession {
  readonly pkce: QoderPkce
  /** 一次性随机串（UUID）。 */
  readonly nonce: string
  /** 设备标识（本插件生成的随机 UUID，需持久化；续期时原样回传）。 */
  readonly machineId: string
}

/** 生成一次性设备登录会话；测试可注入确定性的 PKCE/nonce/machineId。 */
export function createQoderDeviceSession(
  overrides: Partial<QoderDeviceSession> = {},
): QoderDeviceSession {
  return Object.freeze({
    pkce: overrides.pkce ?? createQoderPkce(),
    nonce: overrides.nonce ?? randomUUID(),
    machineId: overrides.machineId ?? randomUUID(),
  })
}

/**
 * 构造浏览器授权 URL。
 *
 * 形态：`{authBase}/device/selectAccounts?challenge&challenge_method=S256&nonce&machine_id&client_id`
 */
export function buildQoderAuthUrl(
  session: QoderDeviceSession,
  product: QoderDeviceProduct = QODER_INTERNATIONAL_PRODUCT,
): string {
  const query = new URLSearchParams({
    challenge: session.pkce.challenge,
    challenge_method: 'S256',
    nonce: session.nonce,
    machine_id: session.machineId,
    client_id: product.clientId,
  })
  return `${product.authBase}${QODER_DEVICE_SELECT_PATH}?${query.toString()}`
}

/**
 * 构造轮询 URL。
 *
 * 挂产品 `openApiBase`（国际版 `openapi.qoder.sh`、中国版
 * `openapi.qoder.com.cn`），不是授权页 host；写错 host 会让登录永远失败。
 */
export function buildQoderPollUrl(
  session: QoderDeviceSession,
  product: QoderDeviceProduct = QODER_INTERNATIONAL_PRODUCT,
): string {
  const query = new URLSearchParams({
    nonce: session.nonce,
    verifier: session.pkce.verifier,
    challenge_method: 'S256',
  })
  return `${product.openApiBase}${QODER_DEVICE_POLL_PATH}?${query.toString()}`
}

/**
 * 授权 URL 只接受精确白名单 host、https、无 userinfo、无自定义端口、无 fragment
 * 的绝对 URL；不做后缀匹配。
 */
export function normalizeQoderAuthUrl(
  value: unknown,
  hosts: readonly string[] = QODER_AUTH_URL_HOSTS,
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
    if (!hosts.includes(url.hostname)) return undefined
    return trimmed
  } catch {
    return undefined
  }
}

/** 从设备码/续期响应解析出的规范化载荷。 */
export interface QoderTokenPayload {
  readonly accessToken: string
  readonly refreshToken?: string
  /** 访问令牌过期时间（毫秒时间戳）。 */
  readonly expiresAt?: number
  /** refresh token 过期时间（毫秒时间戳）。 */
  readonly refreshTokenExpiresAt?: number
  /** 用户 id（`user_id`）；签名与身份去重都需要。 */
  readonly uid?: string
  /** 用户名（`user_name`）；仅用于展示。 */
  readonly userName?: string
}

/** 读字符串字段（容忍非字符串与缺失）。 */
function readString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * 把时间值解析成毫秒时间戳。
 *
 * 兼容 ISO 字符串与数字（秒或毫秒）。无法解析时返回 undefined —— 绝不填 0。
 */
function readTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 解析 token 响应。
 *
 * 登录响应用 `token`，续期响应用 `device_token` —— 两者字段名不同，故都接受；
 * 垃圾输入返回空 `accessToken`（而非抛错），由调用方判定失败。
 */
export function parseQoderTokenPayload(value: unknown): QoderTokenPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return Object.freeze({ accessToken: '' })
  }
  const source = value as Record<string, unknown>
  const accessToken = readString(source, ['token', 'device_token', 'access_token']) ?? ''
  const refreshToken = readString(source, ['refresh_token', 'refreshToken'])
  const expiresAt = readTimestamp(source.expires_at ?? source.expiresAt)
  const refreshTokenExpiresAt = readTimestamp(
    source.refresh_token_expires_at ?? source.refreshTokenExpiresAt,
  )
  const uid = readString(source, ['user_id', 'userId'])
  const userName = readString(source, ['user_name', 'userName'])
  return Object.freeze({
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    ...expiresAt === undefined ? {} : { expiresAt },
    ...refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt },
    ...uid === undefined ? {} : { uid },
    ...userName === undefined ? {} : { userName },
  })
}

/** 设备授权客户端依赖；网络/时钟/超时全部可注入。 */
export interface QoderDeviceAuthClientOptions {
  /** 产品参数；默认国际版。中国版由 CN flow 显式注入。 */
  readonly product?: QoderDeviceProduct
  /** 测试注入；生产默认使用全局 fetch。 */
  readonly fetcher?: typeof fetch
  /** 测试注入；生产默认使用系统时钟。 */
  readonly clock?: QoderAuthClock
  /** 单次请求超时；默认 30s。 */
  readonly requestTimeoutMs?: number
  /** 请求超时信号工厂；测试可注入永不触发的信号。 */
  readonly timeoutSignal?: (ms: number) => AbortSignal
}

/** 轮询参数；deadline 是绝对毫秒时间。 */
export interface QoderPollOptions {
  readonly signal: AbortSignal
  readonly deadline: number
  readonly pollIntervalMs: number
}

/** 续期参数。 */
export interface QoderRefreshInput {
  readonly refreshToken: string
  readonly machineId: string
  readonly signal: AbortSignal
}

/** 设备授权/续期协议客户端；不持有账号或流程状态。 */
export class QoderDeviceAuthClient {
  private readonly product: QoderDeviceProduct
  private readonly fetcher: typeof fetch
  private readonly clock: QoderAuthClock
  private readonly requestTimeoutMs: number
  private readonly timeoutSignal: (ms: number) => AbortSignal

  constructor(options: QoderDeviceAuthClientOptions = {}) {
    this.product = options.product ?? QODER_INTERNATIONAL_PRODUCT
    this.fetcher = options.fetcher ?? fetch
    this.clock = options.clock ?? SYSTEM_CLOCK
    this.requestTimeoutMs = options.requestTimeoutMs ?? QODER_REQUEST_TIMEOUT_MS
    this.timeoutSignal = options.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms))
  }

  /**
   * 轮询设备码直到拿到 token 或整体 deadline 到期。
   *
   * 404 表示「用户尚未完成授权」，2xx 但无 token 同样继续；其他非 2xx 立即失败
   * （服务端异常不是「等用户」）。网络错误与单次请求超时继续轮询，整体 deadline
   * 负责收口。
   */
  async pollDeviceToken(
    session: QoderDeviceSession,
    options: QoderPollOptions,
  ): Promise<QoderTokenPayload> {
    const url = buildQoderPollUrl(session, this.product)
    for (;;) {
      this.throwIfAborted(options.signal)
      if (this.clock.now() >= options.deadline) {
        throw new QoderDeviceTokenError('timeout', MESSAGE_TIMEOUT)
      }
      await this.sleep(options.pollIntervalMs, options.signal)
      this.throwIfAborted(options.signal)
      if (this.clock.now() >= options.deadline) {
        throw new QoderDeviceTokenError('timeout', MESSAGE_TIMEOUT)
      }

      let result: { readonly status: number; readonly body: unknown }
      try {
        result = await this.request('GET', url, { Accept: 'application/json' }, options.signal)
      } catch (error) {
        if (error instanceof QoderDeviceTokenError
          && (error.code === 'cancelled' || error.code === 'timeout')) {
          throw error
        }
        // 网络错误与单次请求超时继续轮询。
        continue
      }

      if (result.status === 404) continue
      if (result.status === 200) {
        const payload = parseQoderTokenPayload(result.body)
        if (payload.accessToken.length === 0) continue
        return payload
      }
      throw new QoderDeviceTokenError('failed', MESSAGE_POLL_FAILED)
    }
  }

  /**
   * POST 续期；401/403 归为 reauth-required，其他失败归为 temporary。
   *
   * 200 但没有 `device_token` 视为无法续期（需重新登录），而不是可重试故障。
   */
  async refresh(input: QoderRefreshInput): Promise<QoderTokenPayload> {
    if (input.refreshToken.length === 0 || input.machineId.length === 0) {
      throw new QoderDeviceTokenError('reauth-required', MESSAGE_REAUTH_REQUIRED)
    }
    const url = `${this.product.openApiBase}${QODER_DEVICE_REFRESH_PATH}`
    let result: { readonly status: number; readonly body: unknown }
    try {
      result = await this.request(
        'POST',
        url,
        {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': QODER_USER_AGENT,
        },
        input.signal,
        JSON.stringify({
          refresh_token: input.refreshToken,
          machine_id: input.machineId,
        }),
      )
    } catch (error) {
      if (error instanceof QoderDeviceTokenError && error.code === 'cancelled') throw error
      throw new QoderDeviceTokenError('temporary', MESSAGE_REFRESH_FAILED)
    }

    if (result.status === 401 || result.status === 403) {
      throw new QoderDeviceTokenError('reauth-required', MESSAGE_REAUTH_REQUIRED)
    }
    if (result.status !== 200) {
      throw new QoderDeviceTokenError('temporary', MESSAGE_REFRESH_FAILED)
    }
    const payload = parseQoderTokenPayload(result.body)
    if (payload.accessToken.length === 0) {
      throw new QoderDeviceTokenError('reauth-required', MESSAGE_REAUTH_REQUIRED)
    }
    return payload
  }

  /** 发起一次控制面请求；非 200 不读取响应体，避免回显上游错误正文。 */
  private async request(
    method: 'GET' | 'POST',
    url: string,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
    body?: string,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    if (signal.aborted) {
      throw new QoderDeviceTokenError('cancelled', MESSAGE_CANCELLED)
    }
    const timeout = this.timeoutSignal(this.requestTimeoutMs)
    const composed = AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await this.fetcher(url, {
        method,
        headers,
        ...body === undefined ? {} : { body },
        signal: composed,
        // 控制面请求绝不跟随 3xx：跨源/降级重定向不得转发秘密。
        redirect: 'error',
      })
    } catch {
      if (signal.aborted) throw new QoderDeviceTokenError('cancelled', MESSAGE_CANCELLED)
      if (timeout.aborted) {
        throw new QoderDeviceTokenError('request-timeout', MESSAGE_NETWORK)
      }
      throw new QoderDeviceTokenError('temporary', MESSAGE_NETWORK)
    }
    if (signal.aborted) throw new QoderDeviceTokenError('cancelled', MESSAGE_CANCELLED)
    if (response.status !== 200) {
      return { status: response.status, body: null }
    }
    let parsed: unknown = null
    try {
      parsed = await response.json()
    } catch {
      parsed = null
    }
    if (signal.aborted) throw new QoderDeviceTokenError('cancelled', MESSAGE_CANCELLED)
    return { status: response.status, body: parsed }
  }

  /** 取消检查。 */
  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new QoderDeviceTokenError('cancelled', MESSAGE_CANCELLED)
    }
  }

  /** 可注入 sleep；取消时由时钟或下一轮检查收口。 */
  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    await this.clock.sleep(ms, signal)
  }
}
