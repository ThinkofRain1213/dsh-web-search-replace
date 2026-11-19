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
 * - 只有明确 `UNAUTHORIZED`、channel=buddy 且 `httpStatus===401` 的错误，才允许
 *   刷新同一账号并重试原操作一次；其他错误不重试、不换账号/渠道。
 *
 * 底层协议状态机与 WorkBuddy 共用 `TencentProductAuthFlow`，但每个实例独立
 * 持有账号、flowId、刷新单飞 map、取消与 dispose 状态；共享的只有代码形状。
 *
 * 授权与重新登录只能由显式方法/RPC 触发：构造函数不启动任何任务，也不注册
 * Agent tool。取消、超时与 dispose 会 abort 在飞请求并等待 settle；状态与错误
 * 只含固定码和脱敏 DTO，不含 token、secret、上游正文或异常原文。
 */
import {
  AuthFlowError,
  BUDDY_AUTH_CHANNEL,
  type AuthFlowErrorCode,
  type AuthFlowStartOptions,
  type AuthFlowStatus,
} from '../../../shared/auth.ts'
import type { AccountService } from '../../accounts/service.ts'
import type { AccountStore } from '../../accounts/store.ts'
import {
  type TencentAccessCredential,
  type TencentCapabilityCredential,
  type TencentCapabilityVerifier,
  TencentProductAuthFlow,
} from '../tencent/product-auth-flow.ts'
import type {
  TencentExternalLinkClock,
  TencentExternalLinkProduct,
} from '../tencent/auth-flow.ts'

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
export class BuddyAuthError extends AuthFlowError {
  override readonly name = 'BuddyAuthError'
}

/** 构造一个固定文案的授权错误。 */
function authError(code: AuthFlowErrorCode): BuddyAuthError {
  return new BuddyAuthError(code, ERROR_MESSAGES[code])
}

/** 执行期访问令牌快照；只交给调用方操作，不进入 RPC。 */
export type BuddyAccessCredential = TencentAccessCredential<typeof BUDDY_AUTH_CHANNEL>

/** 保存前能力探测的输入；不含 refreshToken 或账号秘密。 */
export type BuddyCapabilityCredential = TencentCapabilityCredential<typeof BUDDY_AUTH_CHANNEL>

/**
 * 保存前 Search 能力探测。
 *
 * 必须是 Host-only、可注入且不可省略的依赖；Task 15 用真实 CodeBuddy 搜索
 * 路径实现。探测失败/超时/取消时流程不得落码或设当前。
 */
export type BuddyCapabilityVerifier = TencentCapabilityVerifier<typeof BUDDY_AUTH_CHANNEL>

/** `start` 的选项；提供 accountId 时等价于重新登录。 */
export interface BuddyStartOptions extends AuthFlowStartOptions {}

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

/** CodeBuddy 授权、刷新与重新登录流程。 */
export class BuddyAuthFlow extends TencentProductAuthFlow<typeof BUDDY_AUTH_CHANNEL> {
  constructor(options: BuddyAuthFlowOptions) {
    if (typeof options.verifyCapability !== 'function') {
      throw new TypeError('BuddyAuthFlow requires a verifyCapability function')
    }
    super({
      channel: BUDDY_AUTH_CHANNEL,
      product: BUDDY_AUTH_PRODUCT,
      store: options.store,
      accounts: options.accounts,
      displayHint: options.displayHint ?? DEFAULT_DISPLAY_HINT,
      verifyCapability: options.verifyCapability,
      errorFactory: authError,
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
  override async start(options: BuddyStartOptions = {}): Promise<AuthFlowStatus> {
    return await super.start(options)
  }
}
