/**
 * Qoder 中国版搜索驱动。
 *
 * 固定端点：`gateway.qoder.com.cn` + `/api/v1/webSearch/oneSearch`（签名输入），
 * 实发 URL 由真实 WASM 生成为 `/algo/api/v1/webSearch/oneSearch?Encode=1`。
 *
 * 本驱动只做四件事：
 * 1. 读取**本渠道**凭据；缺 token / machineId 时在任何 fetch/WASM 之前
 *    `NO_ACCOUNT` 失败；
 * 2. 每次搜索新建一个 `QoderSigner`，成功/失败都在 `finally` 中 dispose；
 * 3. 调共享协议层签名并发送（真实 WASM，不 mock）；
 * 4. 把共享协议错误绑定到 `qodercn` 渠道。
 *
 * ⚠️ 账号由 Task 8 的 `createQoderCnSearchBinding` 以精确渠道快照注入；本驱动
 * 不包含国际版双域策略、账号池、授权或 UI。
 */
import type { ChannelId } from '../../../shared/channels.ts'
import type { SearchDriver, SearchDriverResult } from '../../drivers/mock-driver.ts'
import { ChannelSearchError } from '../../search/errors.ts'
import { toChannelAccountSearchError } from '../../accounts/resolver-errors.ts'
import {
  postQoderSearch,
  QODER_SEARCH_PATH,
  toQoderChannelSearchError,
  type QoderSigningCredential,
} from '../qoder/protocol.ts'
import { QoderSigner } from '../qoder/signer.ts'

/** 本驱动固定归属的渠道；账号与错误都只使用这个值。 */
export const QODERCN_CHANNEL = 'qodercn' as const satisfies ChannelId

/** 中国版唯一允许的搜索域。 */
export const QODERCN_SEARCH_HOST = 'gateway.qoder.com.cn'

/** 中国版签名输入路径（与共享协议一致）。 */
export const QODERCN_SEARCH_PATH = QODER_SEARCH_PATH

/** Qoder 中国版的账号快照：稳定账号 ID 与签名凭据绑定在一起。 */
export interface QoderCnAccountCredential {
  /** 编译期精确渠道；运行期仍会校验，防止解析器返回国际版/其他渠道快照。 */
  readonly channelId: 'qodercn'
  readonly accountId: string
  readonly credential: QoderSigningCredential
}

/** Qoder 中国版驱动只接受本渠道凭据解析与可选测试 fetcher。 */
export interface QoderCnDriverDeps {
  /** 只解析 Qoder 中国版自己的账号快照；空值表示无可用账号。 */
  readonly resolveCredential: () => QoderCnAccountCredential | null | undefined
    | Promise<QoderCnAccountCredential | null | undefined>
  /** 测试注入；生产默认使用全局 fetch。 */
  readonly fetcher?: typeof fetch
}

/** 构造无状态 Qoder 中国版搜索驱动；不读任何其他渠道的账号。 */
export function createQoderCnDriver(deps: QoderCnDriverDeps): SearchDriver {
  return {
    async searchOnce(query, maxResults, signal): Promise<SearchDriverResult> {
      // Qoder 端点不接受结果数；cap / 去重 / truncated 由 executor 统一处理。
      void maxResults
      const credential = await requireCredential(deps)

      // 每次搜索独占一个签名器：签名上下文在 prepare 内立即释放，句柄在
      // finally 释放；共享 WASM 不受影响（R3，Task 15 才做进程级释放）。
      const signer = new QoderSigner()
      try {
        const sources = await postQoderSearch({
          host: QODERCN_SEARCH_HOST,
          path: QODERCN_SEARCH_PATH,
          query,
          credential,
          signer,
          signal,
          ...deps.fetcher === undefined ? {} : { fetcher: deps.fetcher },
        })
        return { sources, truncated: false }
      } catch (error) {
        throw toQoderChannelSearchError(error, QODERCN_CHANNEL)
      } finally {
        // dispose 失败绝不能覆盖 try 块里的原始错误。
        try {
          signer.dispose()
        } catch {
          /* 静默：不覆盖原始错误 */
        }
      }
    },
  }
}

/**
 * 无 token / machineId 必须在任何 fetch/WASM 之前失败；其他渠道快照同样
 * fail-closed。解析器异常保留安全 code 并重绑本渠道，丢弃底层原文/cause。
 */
async function requireCredential(deps: QoderCnDriverDeps): Promise<QoderSigningCredential> {
  let account: QoderCnAccountCredential | null | undefined
  try {
    account = await deps.resolveCredential()
  } catch (error) {
    throw toChannelAccountSearchError(
      error,
      QODERCN_CHANNEL,
      'Qoder China search could not read the account credential',
    )
  }
  if (account === null || account === undefined) throw noAccount()
  if (account.channelId !== QODERCN_CHANNEL) throw foreignAccount()
  const credential = account.credential
  if (credential === null || credential === undefined) throw noAccount()
  const token = typeof credential.securityOauthToken === 'string'
    ? credential.securityOauthToken.trim()
    : ''
  const machineId = typeof credential.machineId === 'string' ? credential.machineId.trim() : ''
  if (token.length === 0 || machineId.length === 0) throw noAccount()
  return credential
}

function noAccount(): ChannelSearchError {
  return new ChannelSearchError(
    'NO_ACCOUNT',
    QODERCN_CHANNEL,
    'Qoder China search has no usable account; sign in to a Qoder China account first',
  )
}

function foreignAccount(): ChannelSearchError {
  return new ChannelSearchError(
    'SEARCH_FAILED',
    QODERCN_CHANNEL,
    'Qoder China search received an account from another channel',
  )
}
