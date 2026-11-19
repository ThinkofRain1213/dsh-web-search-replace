/**
 * Qoder 中国版独立设备授权、刷新与重新登录流程。
 *
 * 本文件只属于 `qodercn` 渠道：
 * - 固定中国版参数：授权页 `https://qoder.cn`、控制面
 *   `https://openapi.qoder.com.cn`、精确 clientId
 *   `732aef47-9cf2-46a2-95fe-4cebb5d0d1fa`，搜索能力 host
 *   `https://gateway.qoder.com.cn`；绝不使用国际版 `qoder.com` /
 *   `openapi.qoder.sh` / `e883ade2-…`；
 * - 复用 Qoder 设备授权协议状态机，但产品参数、账号、当前账号、grant、flowId、
 *   刷新单飞与 dispose 状态完全独立；国际版授权成功不能使中国版 ready；
 * - 成功授权只经 `AccountStore.saveAccount` 写本插件 qodercn grant，秘密包含
 *   签名所需的 `securityOauthToken` / `machineId` / `uid` 与刷新/过期材料；
 * - 首个可用账号经 `AccountService.setCurrent` 设为当前，后续账号不自动切换；
 * - 刷新按账号单飞，轮换经 `AccountStore.rotateSecret` 的原子 compare-and-set，
 *   旧刷新/旧 401 不会覆盖新记录；
 * - 只有明确 `UNAUTHORIZED`、channel=qodercn 且 `httpStatus===401` 的错误，才
 *   允许刷新同一账号并重试原操作一次；其他错误不重试、不换账号/渠道。
 *
 * 授权与重新登录只能由显式方法/RPC 触发：构造函数不启动任何任务，也不注册
 * Agent tool。取消、超时与 dispose 会 abort 在飞请求并等待 settle；状态与错误
 * 只含固定码和脱敏 DTO，不含 token、secret、上游正文或异常原文。
 *
 * R27：`machine_id` 只允许作为本流程 Client 可见 `authUrl` 的查询参数出现，并
 * 保存到本渠道 grant 供签名/续期；不得进入其他 DTO、普通配置、日志或错误。
 */
import {
  AuthFlowError,
  QODERCN_AUTH_CHANNEL,
  type AuthFlowErrorCode,
} from '../../../shared/auth.ts'
import type { AccountService } from '../../accounts/service.ts'
import type { AccountStore } from '../../accounts/store.ts'
import {
  QoderProductAuthFlow,
  type QoderAuthCredential,
  type QoderCapabilityCredential,
  type QoderCapabilityVerifier,
} from '../qoder/auth.ts'
import {
  buildQoderAuthUrl,
  buildQoderPollUrl,
  normalizeQoderAuthUrl,
  type QoderAuthClock,
  type QoderDeviceProduct,
  type QoderDeviceSession,
} from '../qoder/auth-flow.ts'

/** 中国版授权页基址。 */
export const QODER_CN_AUTH_BASE = 'https://qoder.cn'

/** 中国版设备码轮询与续期基址。 */
export const QODER_CN_OPEN_API_BASE = 'https://openapi.qoder.com.cn'

/** 中国版 prod client_id；绝不能改用国际版 `e883ade2-…`。 */
export const QODER_CN_CLIENT_ID = '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa'

/** 中国版授权 URL 允许的精确 host；空匹配/后缀匹配一律拒绝。 */
export const QODER_CN_AUTH_URL_HOSTS = Object.freeze(['qoder.cn'])

/** 中国版 Search 与 encrypted infer 固定 host。 */
export const QODER_CN_SEARCH_HOST = 'gateway.qoder.com.cn'

/** 中国版固定设备授权产品参数。 */
export const QODER_CN_PRODUCT: QoderDeviceProduct = Object.freeze({
  authBase: QODER_CN_AUTH_BASE,
  openApiBase: QODER_CN_OPEN_API_BASE,
  clientId: QODER_CN_CLIENT_ID,
  authUrlHosts: QODER_CN_AUTH_URL_HOSTS,
})

/** 默认展示说明；不含账号身份或任何秘密。 */
const DEFAULT_DISPLAY_HINT = '在浏览器中完成 Qoder 中国版登录后返回，插件会自动完成授权。'

/** 中国版授权流程错误码到固定文案。 */
const ERROR_MESSAGES: Readonly<Record<AuthFlowErrorCode, string>> = Object.freeze({
  'auth/invalid': 'Qoder 中国版授权请求非法',
  'auth/flow-active': '已有进行中的 Qoder 中国版授权流程',
  'auth/flow-not-found': '未找到指定的 Qoder 中国版授权流程',
  'auth/timeout': 'Qoder 中国版授权已超时',
  'auth/cancelled': 'Qoder 中国版授权已取消',
  'auth/failed': 'Qoder 中国版授权失败',
  'auth/invalid-response': 'Qoder 中国版授权响应无效',
  'auth/disposed': 'Qoder 中国版授权流程已停止',
  'auth/account-not-found': '该渠道下不存在指定账号',
  'auth/credential-unavailable': '账号凭据记录不可用，请重新登录',
  'auth/identity-mismatch': '重新登录的账号身份与目标账号不一致',
  'auth/reauth-required': 'Qoder 中国版凭据已失效，请重新登录',
  'auth/refresh-failed': 'Qoder 中国版凭据刷新失败',
  'auth/current-account-failed': 'Qoder 中国版账号已保存，但未能设为当前账号',
  'auth/internal': 'Qoder 中国版授权内部错误',
})

/** 中国版授权域错误；`cause` 永远不设置，避免秘密沿错误链泄漏。 */
export class QoderCnAuthError extends AuthFlowError {
  override readonly name = 'QoderCnAuthError'
}

/** 构造一个固定文案的中国版授权错误。 */
function authError(code: AuthFlowErrorCode): QoderCnAuthError {
  return new QoderCnAuthError(code, ERROR_MESSAGES[code])
}

/** 执行期签名凭据快照；只交给调用方操作，不进入 RPC。 */
export type QoderCnAuthCredential = QoderAuthCredential<typeof QODERCN_AUTH_CHANNEL>

/** 保存前能力探测的输入；不含 refreshToken。 */
export type QoderCnCapabilityCredential =
  QoderCapabilityCredential<typeof QODERCN_AUTH_CHANNEL>

/**
 * 保存前 Search 能力探测。
 *
 * 必须是 Host-only、可注入且不可省略的依赖；Task 15 用真实 Qoder 中国版搜索
 * 路径（固定 `gateway.qoder.com.cn`）实现。探测失败/超时/取消时流程不得落码
 * 或设当前。
 */
export type QoderCnCapabilityVerifier =
  QoderCapabilityVerifier<typeof QODERCN_AUTH_CHANNEL>

/** 中国版授权流程依赖；全部网络/时钟/随机/设备会话可注入。 */
export interface QoderCnAuthFlowOptions {
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
   * Qoder 中国版搜索路径；失败/超时/取消都不得落码或设当前。
   */
  readonly verifyCapability: QoderCnCapabilityVerifier
}

/** 中国版设备授权、刷新与重新登录流程。 */
export class QoderCnAuthFlow extends QoderProductAuthFlow<typeof QODERCN_AUTH_CHANNEL> {
  constructor(options: QoderCnAuthFlowOptions) {
    super({
      ...options,
      channel: QODERCN_AUTH_CHANNEL,
      product: QODER_CN_PRODUCT,
      displayHint: options.displayHint ?? DEFAULT_DISPLAY_HINT,
      errorFactory: authError,
    })
  }
}

/** 构造中国版浏览器授权 URL（测试与 Task 15 使用）。 */
export function buildQoderCnAuthUrl(session: QoderDeviceSession): string {
  return buildQoderAuthUrl(session, QODER_CN_PRODUCT)
}

/** 构造中国版设备码轮询 URL。 */
export function buildQoderCnPollUrl(session: QoderDeviceSession): string {
  return buildQoderPollUrl(session, QODER_CN_PRODUCT)
}

/** 只接受精确 `qoder.cn` 的授权 URL；不做后缀匹配。 */
export function normalizeQoderCnAuthUrl(value: unknown): string | undefined {
  return normalizeQoderAuthUrl(value, QODER_CN_PRODUCT.authUrlHosts)
}
