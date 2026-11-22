/**
 * 账号服务：当前账号、列表、删除、清除与执行期凭据解析。
 *
 * 与普通设置服务的分工：
 * - 普通配置只保存 `currentAccountId` 等非秘密用户意图；
 * - 本服务在写当前账号前额外要求记录真实存在于**精确渠道**（关闭 R2 缺口）；
 * - 执行期只通过 {@link AccountService.resolveCurrentCredential} 返回同渠道
 *   同账号的原子快照，供四个驱动各自的绑定适配器使用。
 *
 * 任何错误都不携带凭据 payload、厂商原始身份或底层异常原文/cause。
 */
import {
  isChannelId,
  CHANNEL_IDS,
  type ChannelId,
} from '../../shared/channels.ts'
import type {
  AccountCollection,
  AccountStatus,
  AccountSummary,
  ClearAccountsResult,
} from '../../shared/accounts.ts'
import { isStableChannelAccountId } from '../../shared/contracts.ts'
import type { QoderSigningCredential } from '../channels/qoder/protocol.ts'
import { ChannelSearchError } from '../search/errors.ts'
import type { SettingsService } from '../settings/service.ts'
import { SettingsWriteCancelledError } from '../settings/service.ts'
import {
  accountInvalid,
  accountCancelled,
  accountNotFound,
  accountStorageFailed,
  accountUnavailable,
} from './errors.ts'
import {
  AccountStore,
  type StoredAccountEntry,
  type StoredAccountRecord,
} from './store.ts'

/** 腾讯系渠道的执行期凭据快照。 */
export interface TencentResolvedChannelCredential {
  readonly kind: 'tencent-access-token'
  readonly channelId: 'buddy' | 'workbuddy'
  readonly accountId: string
  readonly accessToken: string
}

/** Qoder 系渠道的执行期凭据快照。 */
export interface QoderResolvedChannelCredential {
  readonly kind: 'qoder-signing'
  readonly channelId: 'qoder' | 'qodercn'
  readonly accountId: string
  readonly credential: QoderSigningCredential
}

/** 精确渠道的账号 + 凭据原子快照；账号 ID 与凭据来自同一条记录。 */
export type ResolvedChannelCredential =
  | TencentResolvedChannelCredential
  | QoderResolvedChannelCredential

/** 按账号读取的一次性 Host-only grant 快照；绝不进入 RPC DTO。 */
export interface AccountGrantSnapshot {
  readonly summary: AccountSummary
  readonly credential: ResolvedChannelCredential | null
  readonly vendorAccountId: string | null
  /** 用于状态 CAS；缺失刷新材料时使用既有空串语义。 */
  readonly expectedRefreshToken: string | null
}

/** 账号服务依赖。 */
export interface AccountServiceOptions {
  readonly store: AccountStore
  readonly settings: SettingsService
}

/** 四渠道账号服务。 */
export class AccountService {
  constructor(private readonly options: AccountServiceOptions) {}

  /** 列出精确渠道的账号；损坏记录以 credential_unavailable 出现。 */
  async list(channel: ChannelId): Promise<readonly AccountSummary[]> {
    const exactChannel = requireChannel(channel)
    const entries = await this.options.store.listEntries(exactChannel)
    return Object.freeze(entries.map(entry => toSummary(entry)))
  }

  /** 读取精确渠道的当前账号；没有当前账号/记录不存在时返回 null。 */
  async getCurrent(channel: ChannelId): Promise<AccountSummary | null> {
    const exactChannel = requireChannel(channel)
    const accountId = this.currentAccountId(exactChannel)
    if (accountId === null) return null
    const entry = await this.options.store.readEntry(exactChannel, accountId)
    return entry === undefined ? null : toSummary(entry)
  }

  /** 按精确 channel + accountId 读取一个脱敏账号，不读取 currentAccountId。 */
  async getAccount(channel: ChannelId, accountId: string): Promise<AccountSummary | null> {
    const exactChannel = requireChannel(channel)
    const exactAccountId = requireAccountId(accountId)
    const entry = await this.options.store.readEntry(exactChannel, exactAccountId)
    return entry === undefined ? null : toSummary(entry)
  }

  /**
   * 按精确账号读取执行期 grant；坏记录返回 credential=null 的安全摘要。
   * 该方法绝不借用 currentAccountId，也不枚举其他渠道。
   */
  async resolveAccountCredential(
    channel: ChannelId,
    accountId: string,
  ): Promise<AccountGrantSnapshot | null> {
    const exactChannel = requireChannel(channel)
    const exactAccountId = requireAccountId(accountId)
    const entry = await this.options.store.readEntry(exactChannel, exactAccountId)
    if (entry === undefined) return null
    const summary = toSummary(entry)
    if (entry.account === undefined) {
      return Object.freeze({
        summary,
        credential: null,
        vendorAccountId: null,
        expectedRefreshToken: null,
      })
    }
    const credential = projectSecret(entry.account)
    if (credential === undefined) {
      return Object.freeze({
        summary,
        credential: null,
        vendorAccountId: null,
        expectedRefreshToken: null,
      })
    }
    return Object.freeze({
      summary,
      credential,
      vendorAccountId: entry.account.vendorAccountId,
      expectedRefreshToken: readSecretString(entry.account.secret, 'refreshToken') ?? '',
    })
  }

  /**
   * 设置/清除精确渠道的当前账号。
   *
   * R2：写普通配置前先验证记录真实存在于该渠道；不存在/损坏/跨渠道都失败，
   * 且不写配置。配置写失败保留旧快照。
   */
  async setCurrent(
    channel: ChannelId,
    accountId: string | null,
    signal?: AbortSignal,
  ): Promise<AccountSummary | null> {
    const exactChannel = requireChannel(channel)
    if (accountId === null) {
      await this.writeCurrent(exactChannel, null, signal)
      return null
    }
    const exactAccountId = requireAccountId(accountId)
    const entry = await this.options.store.readEntry(exactChannel, exactAccountId)
    if (entry === undefined) throw accountNotFound()
    if (entry.account === undefined || projectSecret(entry.account) === undefined) {
      throw accountUnavailable()
    }
    await this.writeCurrent(exactChannel, exactAccountId, signal)
    return toSummary(entry)
  }

  /**
   * 删除精确渠道的账号。
   *
   * - 删除当前账号且无 replacement：当前账号变为 null，不自动递补；
   * - 显式 replacement 且属于同渠道：先切换到 replacement，再删除；
   * - replacement 属于其他渠道/不存在：整体失败，不删除、不改当前。
   */
  async delete(
    channel: ChannelId,
    accountId: string,
    replacementAccountId?: string | null,
    signal?: AbortSignal,
  ): Promise<AccountCollection> {
    if (signal?.aborted) throw accountCancelled()
    const exactChannel = requireChannel(channel)
    const exactAccountId = requireAccountId(accountId)
    const replacement = replacementAccountId === undefined || replacementAccountId === null
      ? null
      : requireAccountId(replacementAccountId)
    if (replacement === exactAccountId) throw accountInvalid()

    const entry = await this.options.store.readEntry(exactChannel, exactAccountId)
    if (entry === undefined) throw accountNotFound()

    if (replacement !== null) {
      const replacementEntry = await this.options.store.readEntry(exactChannel, replacement)
      if (replacementEntry === undefined) throw accountNotFound()
      if (replacementEntry.account === undefined
        || projectSecret(replacementEntry.account) === undefined) {
        throw accountUnavailable()
      }
    }

    const currentWasDeleted = this.currentAccountId(exactChannel) === exactAccountId
    if (signal?.aborted) throw accountCancelled()
    if (currentWasDeleted) {
      await this.writeCurrent(exactChannel, replacement, signal)
    }

    let deleted: boolean
    try {
      deleted = await this.options.store.deleteAccount(exactChannel, exactAccountId)
    } catch (error) {
      // 凭据删除失败时，账号记录仍在；尽力把当前账号恢复为删除前的值，
      // 避免普通配置指向一个已不可用的选择。恢复失败也不覆盖原始错误。
      if (currentWasDeleted && !signal?.aborted) {
        try {
          await this.writeCurrent(exactChannel, exactAccountId, signal)
        } catch {
          /* 静默：保留原始删除错误 */
        }
      }
      throw error
    }
    if (!deleted) throw accountNotFound()
    if (signal?.aborted) throw accountCancelled()

    const accounts = await this.list(exactChannel)
    const current = await this.getCurrent(exactChannel)
    return Object.freeze({ accounts, current })
  }

  /**
   * 清除全部账号数据：先清空四个渠道的当前账号，再删除本插件 scope 的记录。
   *
   * 配置写失败发生在删除凭据之前，因此旧快照与账号记录都保留，用户可重试。
   */
  async clearAll(signal?: AbortSignal): Promise<ClearAccountsResult> {
    for (const channel of CHANNEL_IDS) {
      if (signal?.aborted) throw accountCancelled()
      if (this.currentAccountId(channel) !== null) await this.writeCurrent(channel, null, signal)
    }
    const cleared = await this.options.store.clearAll()
    if (signal?.aborted) throw accountCancelled()
    return Object.freeze({ cleared })
  }

  /**
   * 解析精确渠道当前账号的执行期凭据。
   *
   * - 无当前账号或记录不存在：返回 null（驱动据此抛 NO_ACCOUNT）；
   * - 记录损坏/凭据不完整：抛固定、无 cause 的 SEARCH_FAILED，绑定精确渠道；
   * - 绝不读取其他渠道记录，也不按协议族回退。
   */
  async resolveCurrentCredential(
    channel: ChannelId,
  ): Promise<ResolvedChannelCredential | null> {
    const exactChannel = requireChannel(channel)
    const accountId = this.currentAccountId(exactChannel)
    if (accountId === null) return null

    let entry: StoredAccountEntry | undefined
    try {
      entry = await this.options.store.readEntry(exactChannel, accountId)
    } catch {
      throw new ChannelSearchError(
        'SEARCH_FAILED',
        exactChannel,
        'channel account credential store is unavailable',
      )
    }
    if (entry === undefined) return null
    if (entry.account === undefined) throw credentialUnavailable(exactChannel)

    const resolved = projectSecret(entry.account)
    if (resolved === undefined) throw credentialUnavailable(exactChannel)
    return resolved
  }

  /** 当前普通配置中的账号 ID；四渠道各有独立字段。 */
  private currentAccountId(channel: ChannelId): string | null {
    return this.options.settings.getSnapshot()[channel].currentAccountId
  }

  /** 写当前账号；取消错误原样抛出，其他失败转换为固定账号域错误。 */
  private async writeCurrent(
    channel: ChannelId,
    accountId: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.options.settings.setCurrentAccount(channel, accountId, signal)
    } catch (error) {
      if (error instanceof SettingsWriteCancelledError) throw error
      throw accountStorageFailed()
    }
  }
}

/** 把记录投影为 Client DTO；不可用记录统一显示 credential_unavailable。 */
function toSummary(entry: StoredAccountEntry): AccountSummary {
  const status: AccountStatus = entry.account !== undefined
    && projectSecret(entry.account) !== undefined
    ? entry.status
    : 'credential_unavailable'
  return Object.freeze({
    id: entry.accountId,
    displayName: entry.displayName,
    channelId: entry.channelId,
    endpointLabel: entry.endpointLabel,
    status,
    maskedIdentifier: entry.maskedIdentifier,
  })
}

/** 从记录投影执行期凭据；缺字段返回 undefined，由调用方安全失败。 */
function projectSecret(record: StoredAccountRecord): ResolvedChannelCredential | undefined {
  if (record.channelId === 'buddy' || record.channelId === 'workbuddy') {
    const accessToken = readSecretString(record.secret, 'accessToken')
    if (accessToken === undefined) return undefined
    return Object.freeze({
      kind: 'tencent-access-token',
      channelId: record.channelId,
      accountId: record.accountId,
      accessToken,
    })
  }

  const securityOauthToken = readSecretString(record.secret, 'securityOauthToken')
  const machineId = readSecretString(record.secret, 'machineId')
  if (securityOauthToken === undefined || machineId === undefined) return undefined
  const uid = readSecretString(record.secret, 'uid')
  const organizationId = readSecretString(record.secret, 'organizationId')
  const credential: QoderSigningCredential = {
    ...uid === undefined ? {} : { uid },
    securityOauthToken,
    machineId,
    ...organizationId === undefined ? {} : { organizationId },
  }
  return Object.freeze({
    kind: 'qoder-signing',
    channelId: record.channelId,
    accountId: record.accountId,
    credential: Object.freeze(credential),
  })
}

/** 读取非空秘密字符串并 trim；缺失/空串/非字符串返回 undefined。 */
function readSecretString(
  secret: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = secret[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** 记录存在但凭据不可用的固定搜索错误。 */
function credentialUnavailable(channel: ChannelId): ChannelSearchError {
  return new ChannelSearchError(
    'SEARCH_FAILED',
    channel,
    'channel account credential is unavailable; sign in again',
  )
}

/** 校验渠道。 */
function requireChannel(value: unknown): ChannelId {
  if (!isChannelId(value)) throw accountInvalid()
  return value
}

/** 校验稳定账号 ID。 */
function requireAccountId(value: unknown): string {
  if (!isStableChannelAccountId(value)) throw accountInvalid()
  return value
}
