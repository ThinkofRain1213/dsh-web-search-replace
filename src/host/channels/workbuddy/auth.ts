/**
 * WorkBuddy 国际版独立授权、刷新与重新登录流程。
 *
 * 本文件只属于 `workbuddy` 渠道：
 * - 产品固定为 WorkBuddy 国际版：platform=workbuddy-ai、
 *   endpoint/apiDomain=www.workbuddy.ai、5.5.2 国际版 UA；
 * - 授权 URL 按参考实现 appendSessionParams=true 追加 `version` 与
 *   `loginSessionId`，platform/state/路径仍完全来自服务端 auth/state；
 * - 账号、当前账号、flowId、刷新单飞 map、取消与 dispose 状态由本实例独立
 *   持有，绝不读取/写入 CodeBuddy 的产品、账号、当前账号或刷新状态；
 * - 成功授权只经 `AccountStore.saveAccount` 写本插件 workbuddy grant；
 * - 首个可用账号经 `AccountService.setCurrent` 设为当前，后续账号不自动切换；
 * - 刷新按账号单飞，轮换经 `AccountStore.rotateSecret` 的原子 compare-and-set；
 * - 只有明确 `UNAUTHORIZED`、channel=workbuddy 且 `httpStatus===401` 的错误，
 *   才允许刷新同一账号并重试原操作一次。
 *
 * 授权与重新登录只能由显式方法/RPC 触发：构造函数不启动任何任务，也不注册
 * Agent tool。状态与错误只含固定码和脱敏 DTO，不含 token、secret、上游正文
 * 或异常原文。
 */
import {
  AuthFlowError,
  WORKBUDDY_AUTH_CHANNEL,
  type AuthFlowErrorCode,
  type AuthFlowStartOptions,
  type AuthFlowStatus,
} from '../../../shared/auth.ts'
import type { AccountService } from '../../accounts/service.ts'
import type { AccountStore } from '../../accounts/store.ts'
import {
  normalizeTencentAuthUrl,
  type TencentExternalLinkClock,
  type TencentExternalLinkProduct,
} from '../tencent/auth-flow.ts'
import {
  type TencentAccessCredential,
  type TencentCapabilityCredential,
  type TencentCapabilityVerifier,
  TencentProductAuthFlow,
} from '../tencent/product-auth-flow.ts'

/** WorkBuddy 国际版固定 external-link 产品参数；不随模型/账号变化。 */
export const WORKBUDDY_AUTH_PRODUCT: TencentExternalLinkProduct = Object.freeze({
  platform: 'workbuddy-ai',
  endpoint: 'https://www.workbuddy.ai',
  apiDomain: 'www.workbuddy.ai',
  userAgent: 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2',
  // 批准参考只给出 www.workbuddy.ai 作为登录/API 域；workbuddy.ai、
  // auth.workbuddy.ai、api.workbuddy.ai 是凭据 knownDomains，不是 authUrl
  // 的实证登录站，因此不纳入精确白名单。
  authUrlHosts: Object.freeze(['www.workbuddy.ai']),
})

/** 追加到登录 URL 的产品版本号（对齐 WorkBuddy 5.5.2）。 */
export const WORKBUDDY_PLUGIN_VERSION = '5.5.2'

/** 默认展示说明；不含账号身份或任何秘密。 */
const DEFAULT_DISPLAY_HINT = '在浏览器中完成 WorkBuddy 登录后返回，插件会自动完成授权。'

/** 授权流程错误码到固定文案。 */
const ERROR_MESSAGES: Readonly<Record<AuthFlowErrorCode, string>> = Object.freeze({
  'auth/invalid': 'WorkBuddy 授权请求非法',
  'auth/flow-active': '已有进行中的 WorkBuddy 授权流程',
  'auth/flow-not-found': '未找到指定的 WorkBuddy 授权流程',
  'auth/timeout': 'WorkBuddy 授权已超时',
  'auth/cancelled': 'WorkBuddy 授权已取消',
  'auth/failed': 'WorkBuddy 授权失败',
  'auth/invalid-response': 'WorkBuddy 授权响应无效',
  'auth/disposed': 'WorkBuddy 授权流程已停止',
  'auth/account-not-found': '该渠道下不存在指定账号',
  'auth/credential-unavailable': '账号凭据记录不可用，请重新登录',
  'auth/identity-mismatch': '重新登录的账号身份与目标账号不一致',
  'auth/reauth-required': 'WorkBuddy 凭据已失效，请重新登录',
  'auth/refresh-failed': 'WorkBuddy 凭据刷新失败',
  'auth/current-account-failed': 'WorkBuddy 账号已保存，但未能设为当前账号',
  'auth/internal': 'WorkBuddy 授权内部错误',
})

/** 授权域错误；`cause` 永远不设置，避免秘密沿错误链泄漏。 */
export class WorkbuddyAuthError extends AuthFlowError {
  override readonly name = 'WorkbuddyAuthError'
}

/** 构造一个固定文案的授权错误。 */
function authError(code: AuthFlowErrorCode): WorkbuddyAuthError {
  return new WorkbuddyAuthError(code, ERROR_MESSAGES[code])
}

/** 执行期访问令牌快照；只交给调用方操作，不进入 RPC。 */
export type WorkbuddyAccessCredential = TencentAccessCredential<typeof WORKBUDDY_AUTH_CHANNEL>

/** 保存前能力探测的输入；不含 refreshToken 或账号秘密。 */
export type WorkbuddyCapabilityCredential =
  TencentCapabilityCredential<typeof WORKBUDDY_AUTH_CHANNEL>

/**
 * 保存前 WorkBuddy Search 能力探测。
 *
 * 必须是 Host-only、可注入且不可省略的依赖；Task 15 用真实 WorkBuddy 搜索
 * 路径实现。探测失败/超时/取消时流程不得落码或设当前。
 */
export type WorkbuddyCapabilityVerifier =
  TencentCapabilityVerifier<typeof WORKBUDDY_AUTH_CHANNEL>

/** `start` 的选项；提供 accountId 时等价于重新登录。 */
export interface WorkbuddyStartOptions extends AuthFlowStartOptions {}

/** 授权流程依赖；全部网络/时钟/随机 ID 可注入。 */
export interface WorkbuddyAuthFlowOptions {
  readonly store: AccountStore
  readonly accounts: AccountService
  /** 测试注入；生产默认使用全局 fetch。 */
  readonly fetcher?: typeof fetch
  /** 测试注入；生产默认使用系统时钟。 */
  readonly clock?: TencentExternalLinkClock
  /** 测试注入；生产默认使用 crypto.randomUUID。 */
  readonly randomId?: () => string
  /** 登录 session ID 生成器；测试注入确定性值，生产默认 crypto.randomUUID。 */
  readonly randomSessionId?: () => string
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
   * 保存前 WorkBuddy Search 能力探测；Host-only 且不可省略。Task 15 必须提供
   * 真实 WorkBuddy 搜索路径；失败/超时/取消都不得落码或设当前。
   */
  readonly verifyCapability: WorkbuddyCapabilityVerifier
}

/**
 * 按参考实现 appendSessionParams=true 装饰授权 URL。
 *
 * 只追加参数，不重建 platform/state/路径；追加后再次按精确 host 白名单复检，
 * 防止装饰器把 URL 指向其他 host。
 */
export function decorateWorkbuddyAuthUrl(
  authUrl: string,
  loginSessionId: string,
): string | undefined {
  try {
    const url = new URL(authUrl)
    url.searchParams.set('version', WORKBUDDY_PLUGIN_VERSION)
    url.searchParams.set('loginSessionId', loginSessionId)
    return normalizeTencentAuthUrl(url.toString(), WORKBUDDY_AUTH_PRODUCT.authUrlHosts)
  } catch {
    return undefined
  }
}

/** WorkBuddy 国际版授权、刷新与重新登录流程。 */
export class WorkbuddyAuthFlow extends TencentProductAuthFlow<
  typeof WORKBUDDY_AUTH_CHANNEL
> {
  constructor(options: WorkbuddyAuthFlowOptions) {
    if (typeof options.verifyCapability !== 'function') {
      throw new TypeError('WorkbuddyAuthFlow requires a verifyCapability function')
    }
    const randomSessionId = options.randomSessionId
      ?? (() => globalThis.crypto.randomUUID())
    super({
      channel: WORKBUDDY_AUTH_CHANNEL,
      product: WORKBUDDY_AUTH_PRODUCT,
      store: options.store,
      accounts: options.accounts,
      displayHint: options.displayHint ?? DEFAULT_DISPLAY_HINT,
      verifyCapability: options.verifyCapability,
      errorFactory: authError,
      decorateAuthUrl: (authUrl) => decorateWorkbuddyAuthUrl(authUrl, randomSessionId()),
      ...options.fetcher === undefined ? {} : { fetcher: options.fetcher },
      ...options.clock === undefined ? {} : { clock: options.clock },
      ...options.randomId === undefined ? {} : { randomId: options.randomId },
      ...options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs },
      ...options.authTimeoutMs === undefined ? {} : { authTimeoutMs: options.authTimeoutMs },
      ...options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs },
      ...options.stateRequestTimeoutMs === undefined
        ? {}
        : { stateRequestTimeoutMs: options.stateRequestTimeoutMs },
      ...options.timeoutSignal === undefined ? {} : { timeoutSignal: options.timeoutSignal },
    })
  }

  /** 显式保留 start 的产品选项类型（实现由通用状态机提供）。 */
  override async start(
    options: WorkbuddyStartOptions = {},
    callerSignal?: AbortSignal,
  ): Promise<AuthFlowStatus> {
    return await super.start(options, callerSignal)
  }
}
