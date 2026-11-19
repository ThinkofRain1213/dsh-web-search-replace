/**
 * Qoder 国际版搜索驱动。
 *
 * 与 Qoder 中国版共用同一份共享协议层（`../qoder/protocol.ts` 与真实 WASM 签名器），
 * 但**账号、凭据、端点与失败策略完全独立**：本驱动只解析注入的 Qoder 国际版账号，
 * 只在 `center.qoder.sh` / `api2.qoder.sh` 之间按用户偏好选择，绝不使用
 * `gateway.qoder.com.cn`、其他渠道账号或官方 DeepSeek Provider。
 *
 * 端点选择委托给 {@link QoderEndpointPolicy}：
 *
 * - `center` / `api2`：只走所选域，任何错误都不切换；
 * - `auto`：初始 center，只有连接失败/超时/上游 5xx 才在同一账号、同一 query 下
 *   顺序换域一次，并按「账号 + 网络出口」在当前进程内粘性。
 *
 * ⚠️ 账号由 Task 8 的 `createQoderInternationalSearchBinding` 以精确渠道快照注入；
 * 本驱动不读账号库、不做授权/刷新/UI，也不接触其他渠道账号。
 */
import type { ChannelId, QoderEndpointPreference } from '../../../shared/channels.ts'
import type { SearchDriver, SearchDriverResult } from '../../drivers/mock-driver.ts'
import { ChannelSearchError } from '../../search/errors.ts'
import { toChannelAccountSearchError } from '../../accounts/resolver-errors.ts'
import {
  QODER_INTERNATIONAL_HOSTS,
  QoderEndpointPolicy,
  QoderEndpointUnavailableError,
  type QoderEndpointObservation,
  type QoderEndpointOperationContext,
} from './endpoint-policy.ts'
import {
  postQoderSearch,
  QODER_SEARCH_PATH,
  toQoderChannelSearchError,
  type QoderSigningCredential,
} from './protocol.ts'
import { QoderSigner } from './signer.ts'

/** 本驱动固定归属的渠道；账号与错误都只使用这个值。 */
export const QODER_CHANNEL = 'qoder' as const satisfies ChannelId

/** 国际版签名输入路径（与共享协议一致）。 */
export const QODER_INTERNATIONAL_SEARCH_PATH = QODER_SEARCH_PATH

/** 国际版允许的搜索域（只读导出，供状态与测试断言）。 */
export const QODER_INTERNATIONAL_SEARCH_HOSTS = QODER_INTERNATIONAL_HOSTS

/** 一次搜索使用的账号快照：稳定账号 ID 与签名凭据绑定在一起。 */
export interface QoderInternationalAccount {
  /**
   * 编译期精确渠道；运行期仍会校验，防止解析器返回中国版/其他渠道快照。
   */
  readonly channelId: 'qoder'
  /**
   * 账号库中的稳定账号 ID。
   *
   * 只用于端点粘性键（与网络出口键一起）；不进入错误消息、观察记录或日志。
   */
  readonly accountId: string
  /** 本账号的签名凭据；只在进程内流转。 */
  readonly credential: QoderSigningCredential
}

/** Qoder 国际版驱动依赖；全部由调用方显式注入。 */
export interface QoderInternationalDriverDeps {
  /** 只解析 Qoder 国际版自己的账号；空值表示无可用账号。 */
  readonly resolveAccount: () => QoderInternationalAccount | null | undefined
    | Promise<QoderInternationalAccount | null | undefined>
  /** 端点偏好；每次搜索解析一次并作为本次调用快照。 */
  readonly resolveEndpointPreference: () => QoderEndpointPreference
    | Promise<QoderEndpointPreference>
  /**
   * 当前网络出口的稳定标识；用于隔离粘性。
   *
   * ⚠️ 必须由调用方显式提供，本驱动不探测 OS 网络，也不伪造「自动识别」。
   */
  readonly networkExitKey: () => string
  /** 测试注入；生产默认使用全局 fetch。 */
  readonly fetcher?: typeof fetch
  /** 脱敏观察钩子：实际域名、耗时与错误类别；不含 query 或凭据。 */
  readonly onObservation?: (observation: QoderEndpointObservation) => void
}

/**
 * 构造 Qoder 国际版搜索驱动。
 *
 * 粘性状态属于本驱动实例（= 当前进程）；重建实例即回到 center。
 */
export function createQoderInternationalDriver(deps: QoderInternationalDriverDeps): SearchDriver {
  const policy = new QoderEndpointPolicy({
    networkExitKey: deps.networkExitKey,
    ...deps.onObservation === undefined ? {} : { onObservation: deps.onObservation },
  })

  return {
    async searchOnce(query, maxResults, signal): Promise<SearchDriverResult> {
      // Qoder 端点不接受结果数；cap / 去重 / truncated 由 executor 统一处理。
      void maxResults

      // 顺序很重要：账号 → 端点偏好，全部先于任何 WASM/网络工作。
      const account = await requireAccount(deps)
      const preference = await requireEndpointPreference(deps)

      // 每次尝试独占一个签名器；operation 只拿到域名，凭据与 query 由闭包固定，
      // 因此自动切换结构上无法换账号或换 query。
      const operation = async ({ host }: QoderEndpointOperationContext) => {
        const signer = new QoderSigner()
        try {
          return await postQoderSearch({
            host,
            path: QODER_INTERNATIONAL_SEARCH_PATH,
            query,
            credential: account.credential,
            signer,
            signal,
            ...deps.fetcher === undefined ? {} : { fetcher: deps.fetcher },
          })
        } finally {
          // dispose 失败绝不能覆盖 try 块里的原始错误。
          try {
            signer.dispose()
          } catch {
            /* 静默：不覆盖原始错误 */
          }
        }
      }

      try {
        const sources = await policy.execute({
          preference,
          accountKey: account.accountId,
          operation,
          signal,
        })
        return { sources, truncated: false }
      } catch (error) {
        throw toQoderChannelError(error)
      }
    },
  }
}

/** 两域都失败的错误带结构化类别；其余错误沿用共享协议映射。 */
function toQoderChannelError(error: unknown): ChannelSearchError {
  if (error instanceof QoderEndpointUnavailableError) {
    return new ChannelSearchError(error.code, QODER_CHANNEL, error.message)
  }
  return toQoderChannelSearchError(error, QODER_CHANNEL)
}

/**
 * 账号必须可用：缺账号、缺 token/machineId、缺稳定账号键、拿到其他渠道快照
 * 都在任何 WASM/fetch 之前失败。
 *
 * 解析器异常保留安全结构化 code 并重绑本渠道；底层原文/cause 一律丢弃（R16）。
 */
async function requireAccount(deps: QoderInternationalDriverDeps): Promise<QoderInternationalAccount> {
  let account: QoderInternationalAccount | null | undefined
  try {
    account = await deps.resolveAccount()
  } catch (error) {
    throw toChannelAccountSearchError(
      error,
      QODER_CHANNEL,
      'Qoder international search could not read the account credential',
    )
  }
  if (account === null || account === undefined) throw noAccount()
  if (account.channelId !== QODER_CHANNEL) throw foreignAccount()

  const token = typeof account.credential?.securityOauthToken === 'string'
    ? account.credential.securityOauthToken.trim()
    : ''
  const machineId = typeof account.credential?.machineId === 'string'
    ? account.credential.machineId.trim()
    : ''
  if (token.length === 0 || machineId.length === 0) throw noAccount()

  const accountId = typeof account.accountId === 'string' ? account.accountId.trim() : ''
  if (accountId.length === 0) {
    throw new ChannelSearchError(
      'INVALID_ARGUMENTS',
      QODER_CHANNEL,
      'Qoder international search account is missing its stable account key',
    )
  }
  return account
}

/** 端点偏好解析异常绑定本渠道，保留安全 code，且不携带底层异常原文。 */
async function requireEndpointPreference(
  deps: QoderInternationalDriverDeps,
): Promise<QoderEndpointPreference> {
  try {
    return await deps.resolveEndpointPreference()
  } catch (error) {
    throw toChannelAccountSearchError(
      error,
      QODER_CHANNEL,
      'Qoder international search could not read the endpoint preference',
    )
  }
}

function noAccount(): ChannelSearchError {
  return new ChannelSearchError(
    'NO_ACCOUNT',
    QODER_CHANNEL,
    'Qoder international search has no usable account; sign in to a Qoder account first',
  )
}

function foreignAccount(): ChannelSearchError {
  return new ChannelSearchError(
    'SEARCH_FAILED',
    QODER_CHANNEL,
    'Qoder international search received an account from another channel',
  )
}
