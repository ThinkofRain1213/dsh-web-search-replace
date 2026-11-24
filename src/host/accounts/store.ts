/**
 * 四渠道独立凭据库。
 *
 * 本文件是账号记录的唯一持久化入口，使用 DSH credentials 的 record 半边：
 *
 * - 记录地址固定为 `<本插件 scope>/<channelId>-<accountId>`，两段都满足
 *   `^[a-z][a-z0-9-]*$`；
 * - 记录内容使用 `kind: 'grant'`，payload 同时保存 `channelId`、`accountId`
 *   与厂商原始身份（只在记录内用于同渠道去重）；
 * - 账号 ID 由 channel + 厂商身份哈希生成，稳定、小写、带安全首字母前缀，
 *   绝不直接拿邮箱/厂商原始 ID 拼 key；
 * - 写入只经 `modifyRecord`（独占读改写），所有读取/枚举/删除都先按本插件
 *   scope 过滤；
 * - 任何底层异常都不透传原文或 cause，只抛固定账号域错误。
 */
import { createHash } from 'node:crypto'
import type {
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
} from '@deepseek-ai/dsh-credentials'

import {
  isChannelId,
  CHANNELS,
  CHANNEL_IDS,
  type ChannelId,
} from '../../shared/channels.ts'
import {
  isPersistedAccountStatus,
  type AccountStatus,
  type PersistedAccountStatus,
} from '../../shared/accounts.ts'
import { isStableChannelAccountId } from '../../shared/contracts.ts'
import { waitWithAuthAbort } from '../channels/auth-abort.ts'
import {
  AccountError,
  accountCancelled,
  accountConflict,
  accountInvalid,
  accountStorageFailed,
} from './errors.ts'

/** 本插件在 DSH credentials 中的 scope（等于插件注册名）。 */
export const ACCOUNT_CREDENTIAL_SCOPE = 'dsh-web-search-replace'

/**
 * 改名前的 credentials scope。只允许一次性迁移代码引用；迁移成功后旧 scope
 * 下必须零记录，不得继续作为运行时读取入口。
 */
export const LEGACY_ACCOUNT_CREDENTIAL_SCOPE = 'dsh-web-search-channels'

/** 旧 scope 一次性迁移结果。 */
export interface CredentialScopeMigrationResult {
  /** 实际复制到新 scope 的记录数（新 scope 已存在同名记录时不计）。 */
  readonly migrated: number
  /** 已删除的旧 scope 记录数。 */
  readonly removed: number
}

/** R43/R44 的非账号路由记录 ID；clearAll 绝不能把它当成账号删除。 */
export const QODER_LAST_SUCCESSFUL_HOST_RECORD_ID = 'qoder-last-successful-host'

/** credentials key 的 scope/id 两段共用语法。 */
export const CREDENTIAL_KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/

/** credentials 列表项只含 branded key 与 kind，不含 payload。 */
export type AccountCredentialRecordEntry = CredentialRecordEntry

/** 本插件使用的真实 credentials record 半边签名；全部依赖均为 type-only。 */
export interface AccountCredentialProvider {
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>
  modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>
  deleteRecord(key: CredentialKey): Promise<void>
  listRecords(): Promise<readonly CredentialRecordEntry[]>
}

/** 一条有效账号记录（Host 内部；secret 不进入 Client DTO）。 */
export interface StoredAccountRecord {
  readonly channelId: ChannelId
  readonly accountId: string
  /** 厂商原始身份；只在同渠道记录内用于去重，不进入 RPC。 */
  readonly vendorAccountId: string
  readonly displayName: string
  readonly maskedIdentifier: string
  readonly endpointLabel: string
  readonly status: AccountStatus
  /** 渠道专属秘密材料；由 Task 9-12 的授权流程写入。 */
  readonly secret: Readonly<Record<string, unknown>>
}

/** 列表项：记录损坏时 `account` 为空，但仍可用于展示与清理。 */
export interface StoredAccountEntry {
  readonly channelId: ChannelId
  readonly accountId: string
  readonly displayName: string
  readonly maskedIdentifier: string
  readonly endpointLabel: string
  readonly status: AccountStatus
  readonly account?: StoredAccountRecord
}

/** 保存账号的输入；同一渠道同一厂商身份会复用既有账号 ID。 */
export interface SaveAccountInput {
  readonly channel: ChannelId
  readonly vendorAccountId: string
  readonly displayName?: string
  readonly endpointLabel?: string
  readonly status?: PersistedAccountStatus
  readonly secret: Readonly<Record<string, unknown>>
  /** reauth 乐观并发：目标必须在独占事务内仍存在且 ID 匹配。 */
  readonly expectedAccountId?: string
  /** reauth 乐观并发：当前 refresh 版本必须与启动快照匹配。 */
  readonly expectedRefreshToken?: string
  /**
   * 可选取消信号；在 modifyRecord 的提交回调内、实际写入前再次检查。
   * 取消早于提交时抛 `accounts/cancelled`，不写记录。
   */
  readonly signal?: AbortSignal
}

/**
 * 刷新轮换的原子更新输入。
 *
 * `expectedRefreshToken` 是本次网络刷新实际使用的 refresh token；只有当前记录
 * 的 `secret.refreshToken` 仍等于它时才写入。旧刷新迟到、重新登录已换新令牌
 * 或记录被删除时都不覆盖当前记录。
 */
export interface RotateAccountSecretInput {
  readonly channel: ChannelId
  readonly accountId: string
  readonly expectedRefreshToken: string
  /** 省略时保留当前秘密，只更新状态。 */
  readonly secret?: Readonly<Record<string, unknown>>
  /** 省略时保留当前状态。 */
  readonly status?: PersistedAccountStatus
  /**
   * 可选取消信号；在 `modifyRecord` 的独占回调内、生成/返回新 payload 前再次
   * 检查。取消早于实际提交时抛 `accounts/cancelled`，不写记录。
   */
  readonly signal?: AbortSignal
}

/** 账号库依赖。 */
export interface AccountStoreOptions {
  readonly credentials: AccountCredentialProvider
  /** 测试/未来迁移可注入的 ID 生成器；默认按 channel + 厂商身份哈希。 */
  readonly generateAccountId?: (channel: ChannelId, vendorAccountId: string) => string
}

/** 记录解析结果。 */
type ParsedRecord =
  | { readonly kind: 'missing' }
  | { readonly kind: 'foreign' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'valid'; readonly record: StoredAccountRecord }

/** 控制字符；显示名/厂商身份/端点标签都不允许。 */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

/** 端点标签只接受小写主机名形状，避免任意文本进入 Client DTO。 */
const ENDPOINT_LABEL = /^[a-z0-9](?:[a-z0-9.-]{0,252})$/

/** 稳定记录 ID 的最大厂商身份长度。 */
const MAX_VENDOR_ACCOUNT_ID_LENGTH = 256

/**
 * 构造 credentials key；两段都必须满足稳定小写语法。
 *
 * @throws {TypeError} 任一段非法时。
 */
export function buildCredentialKey(scope: string, id: string): CredentialKey {
  if (!CREDENTIAL_KEY_SEGMENT_PATTERN.test(scope) || !CREDENTIAL_KEY_SEGMENT_PATTERN.test(id)) {
    throw new TypeError('credential key segments must be lowercase hyphenated identifiers')
  }
  // 唯一受控 brand 边界；两段语法与真实 makeCredentialKey 完全一致。
  return `${scope}/${id}` as CredentialKey
}

/**
 * 某渠道某账号的 credentials key。
 *
 * @throws {AccountError} 渠道或账号 ID 非法时。
 */
export function accountRecordKey(channel: ChannelId, accountId: string): CredentialKey {
  const exactChannel = requireChannel(channel)
  const exactAccountId = requireAccountId(accountId)
  return buildCredentialKey(ACCOUNT_CREDENTIAL_SCOPE, `${exactChannel}-${exactAccountId}`)
}

/** 四渠道账号库。 */
export class AccountStore {
  constructor(private readonly options: AccountStoreOptions) {}

  /**
   * 保存/更新一个账号。
   *
   * 同渠道同厂商身份复用既有账号 ID；新账号 ID 由 channel + 厂商身份哈希生成。
   * 唯一写路径是 `modifyRecord`，因此并发保存同一账号不会丢记录。
   *
   * @throws {AccountError} 输入非法、记录地址冲突或存储失败时。
   */
  async saveAccount(input: SaveAccountInput): Promise<StoredAccountRecord> {
    if (input.signal?.aborted) throw accountCancelled()
    const channel = requireChannel(input.channel)
    const vendorAccountId = requireVendorAccountId(input.vendorAccountId)
    const secret = cloneSecret(input.secret)
    const providedDisplayName = input.displayName === undefined
      ? undefined
      : normalizeDisplayName(input.displayName, CHANNELS[channel].displayName)
    const providedEndpointLabel = input.endpointLabel === undefined
      ? undefined
      : normalizeEndpointLabel(input.endpointLabel, CHANNELS[channel].hosts[0]!)
    const status = input.status === undefined ? 'ready' : requirePersistedStatus(input.status)
    const existing = await this.findByVendorAccountId(channel, vendorAccountId, input.signal)
    const accountId = existing?.accountId
      ?? (this.options.generateAccountId ?? generateAccountId)(channel, vendorAccountId)
    const key = accountRecordKey(channel, accountId)
    const expectedAccountId = input.expectedAccountId === undefined
      ? undefined
      : requireAccountId(input.expectedAccountId)
    if (expectedAccountId !== undefined
      && (existing?.accountId !== expectedAccountId || existing.account === undefined)) {
      throw accountConflict()
    }

    let saved: StoredAccountRecord | undefined
    await this.modifyRaw(key, async (current) => {
      if (input.signal?.aborted) throw accountCancelled()
      const parsed = parseRecord(current, channel, accountId)
      // 伪造记录（payload 声称其他渠道）绝不覆盖；本渠道的损坏记录允许修复，
      // 否则用户重新登录会被一条旧 schema 的脏记录永久卡住。
      if (parsed.kind === 'foreign') throw accountConflict()
      if (expectedAccountId !== undefined
        && (parsed.kind !== 'valid' || parsed.record.accountId !== expectedAccountId)) {
        throw accountConflict()
      }
      if (input.expectedRefreshToken !== undefined
        && (parsed.kind !== 'valid'
          || (readSecretString(parsed.record.secret, 'refreshToken') ?? '') !== input.expectedRefreshToken)) {
        throw accountConflict()
      }
      if (parsed.kind === 'valid' && parsed.record.vendorAccountId !== vendorAccountId) {
        throw accountConflict()
      }
      // 更新既有账号时省略显示名/端点标签不覆盖原值；重新登录只换秘密材料。
      const displayName = providedDisplayName
        ?? (parsed.kind === 'valid' ? parsed.record.displayName : CHANNELS[channel].displayName)
      const endpointLabel = providedEndpointLabel
        ?? (parsed.kind === 'valid' ? parsed.record.endpointLabel : CHANNELS[channel].hosts[0]!)
      const record: StoredAccountRecord = Object.freeze({
        channelId: channel,
        accountId,
        vendorAccountId,
        displayName,
        maskedIdentifier: maskVendorAccountId(vendorAccountId),
        endpointLabel,
        status,
        secret,
      })
      saved = record
      return { kind: 'grant', payload: toPayload(record) }
    })

    if (saved === undefined) throw accountStorageFailed()
    return saved
  }

  /**
   * 原子刷新轮换：仅当当前记录的 refresh token 仍等于期望值时更新秘密/状态。
   *
   * 这是刷新迟到保护的唯一写入口：`modifyRecord` 的独占读改写保证比较与写入
   * 之间没有其他写入插入；不匹配时返回 undefined，绝不覆盖新记录。记录不存在、
   * 损坏或跨渠道时同样返回 undefined，不创建也不修复记录。
   *
   * @throws {AccountError} 输入非法或存储失败时。
   */
  async rotateSecret(input: RotateAccountSecretInput): Promise<StoredAccountRecord | undefined> {
    if (input.signal?.aborted) throw accountCancelled()
    const channel = requireChannel(input.channel)
    const accountId = requireAccountId(input.accountId)
    if (typeof input.expectedRefreshToken !== 'string') throw accountInvalid()
    const expectedRefreshToken = input.expectedRefreshToken
    const nextSecret = input.secret === undefined ? undefined : cloneSecret(input.secret)
    const nextStatus = input.status === undefined
      ? undefined
      : requirePersistedStatus(input.status)
    const key = accountRecordKey(channel, accountId)

    let saved: StoredAccountRecord | undefined
    await this.modifyRaw(key, async (current) => {
      // 取消必须在独占提交回调内、生成新 payload 前再次生效：Provider 可能在
      // 调用本回调前阻塞很久，调用方期间的 dispose/abort 不得变成迟到写入。
      if (input.signal?.aborted) throw accountCancelled()
      const parsed = parseRecord(current, channel, accountId)
      if (parsed.kind !== 'valid') return undefined
      const currentRefreshToken = readSecretString(parsed.record.secret, 'refreshToken') ?? ''
      if (currentRefreshToken !== expectedRefreshToken) return undefined
      if (input.signal?.aborted) throw accountCancelled()
      const record: StoredAccountRecord = Object.freeze({
        ...parsed.record,
        secret: nextSecret ?? parsed.record.secret,
        status: nextStatus ?? parsed.record.status,
      })
      saved = record
      return { kind: 'grant', payload: toPayload(record) }
    })
    return saved
  }

  /** 列出某渠道的全部账号（含损坏记录），按账号 ID 稳定排序。 */
  async listEntries(
    channel: ChannelId,
    signal?: AbortSignal,
  ): Promise<readonly StoredAccountEntry[]> {
    const exactChannel = requireChannel(channel)
    const entries = await this.waitRead(this.listRaw(), signal)
    const result: StoredAccountEntry[] = []
    for (const entry of entries) {
      const accountId = accountIdFromKey(entry.key, exactChannel)
      if (accountId === undefined) continue
      const raw = await this.waitRead(this.readRaw(entry.key), signal)
      const parsed = parseRecord(raw, exactChannel, accountId)
      if (parsed.kind === 'missing' || parsed.kind === 'foreign') continue
      result.push(parsed.kind === 'invalid'
        ? invalidEntry(exactChannel, accountId)
        : entryFromRecord(parsed.record))
    }
    result.sort((left, right) => left.accountId.localeCompare(right.accountId))
    return Object.freeze(result)
  }

  /**
   * 读取某渠道某账号。
   *
   * 记录不存在或 payload 声称属于其他渠道时返回 undefined；记录损坏时返回
   * 带 `credential_unavailable` 的列表项，让上层安全失败而不是使用脏数据。
   */
  async readEntry(
    channel: ChannelId,
    accountId: string,
  ): Promise<StoredAccountEntry | undefined> {
    const exactChannel = requireChannel(channel)
    const exactAccountId = requireAccountId(accountId)
    const raw = await this.readRaw(accountRecordKey(exactChannel, exactAccountId))
    const parsed = parseRecord(raw, exactChannel, exactAccountId)
    if (parsed.kind === 'missing' || parsed.kind === 'foreign') return undefined
    return parsed.kind === 'invalid'
      ? invalidEntry(exactChannel, exactAccountId)
      : entryFromRecord(parsed.record)
  }

  /**
   * 删除某渠道某账号；返回是否真的删除了记录。
   *
   * 只删除本插件 scope 下精确匹配 channel + accountId 的 key；payload 声称
   * 属于其他渠道的伪造记录不会被删除。
   */
  async deleteAccount(channel: ChannelId, accountId: string): Promise<boolean> {
    const exactChannel = requireChannel(channel)
    const exactAccountId = requireAccountId(accountId)
    const key = accountRecordKey(exactChannel, exactAccountId)
    const raw = await this.readRaw(key)
    const parsed = parseRecord(raw, exactChannel, exactAccountId)
    if (parsed.kind === 'missing' || parsed.kind === 'foreign') return false
    await this.deleteRaw(key)
    return true
  }

  /**
   * 一次性迁移旧包名 scope 下的全部记录到当前 scope，并在复制成功后删除旧记录。
   *
   * 迁移范围包括四渠道账号 grant 与 `qoder-last-successful-host` 路由记录；
   * `modifyRecord` 只在新 key 尚不存在时写入，避免覆盖更新代数据；旧 key 无论
   * 是否已经存在新副本都会删除，以保证旧 scope 零残留。重复调用是幂等的。
   *
   * @throws {AccountError} 底层凭据存储失败，或迁移后仍能枚举到旧 scope 记录时。
   */
  async migrateLegacyCredentialScope(): Promise<CredentialScopeMigrationResult> {
    const legacyPrefix = `${LEGACY_ACCOUNT_CREDENTIAL_SCOPE}/`
    const entries = await this.listRaw()
    const legacyKeys = entries
      .map(entry => entry.key)
      .filter(key => key.startsWith(legacyPrefix))
    let migrated = 0
    for (const legacyKey of legacyKeys) {
      const recordId = legacyKey.slice(legacyPrefix.length)
      if (recordId.length === 0) continue
      const key = buildCredentialKey(ACCOUNT_CREDENTIAL_SCOPE, recordId)
      const record = await this.readRaw(legacyKey)
      if (record !== undefined) {
        await this.modifyRaw(key, async (current) => {
          if (current !== undefined) return undefined
          migrated += 1
          return record
        })
      }
      await this.deleteRaw(legacyKey)
    }
    const remaining = (await this.listRaw())
      .filter(entry => entry.key.startsWith(legacyPrefix))
    if (remaining.length > 0) throw accountStorageFailed()
    return { migrated, removed: legacyKeys.length }
  }

  /** 删除本插件 scope 的全部账号记录，返回删除数量；不触碰其他插件 scope。 */
  async clearAll(): Promise<number> {
    const entries = await this.listRaw()
    const ownKeys = entries
      .map(entry => entry.key)
      .filter(key => key !== buildCredentialKey(
        ACCOUNT_CREDENTIAL_SCOPE,
        QODER_LAST_SUCCESSFUL_HOST_RECORD_ID,
      ))
      .filter(key => CHANNEL_IDS.some(channel => accountIdFromKey(key, channel) !== undefined))
    for (const key of ownKeys) await this.deleteRaw(key)
    return ownKeys.length
  }

  /** 同渠道按厂商身份查找既有账号；找不到返回 undefined。 */
  private async findByVendorAccountId(
    channel: ChannelId,
    vendorAccountId: string,
    signal?: AbortSignal,
  ): Promise<StoredAccountEntry | undefined> {
    const entries = await this.listEntries(channel, signal)
    return entries.find(entry => entry.account?.vendorAccountId === vendorAccountId)
  }

  /** 只读等待可放弃；原 Promise 的 rejection 始终保留处理器。 */
  private async waitRead<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    return signal === undefined
      ? await operation
      : await waitWithAuthAbort(operation, signal, accountCancelled)
  }

  /** 读取一条原始记录；底层异常转换为固定 storage-failed。 */
  private async readRaw(key: CredentialKey): Promise<CredentialRecord | undefined> {
    try {
      return await this.options.credentials.readRecord(key)
    } catch (error) {
      throw rethrowOrStorageFailure(error)
    }
  }

  /** 独占读改写；底层异常转换为固定 storage-failed，账号域错误原样保留。 */
  private async modifyRaw(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    try {
      return await this.options.credentials.modifyRecord(key, mutate)
    } catch (error) {
      throw rethrowOrStorageFailure(error)
    }
  }

  /** 删除一条记录；底层异常转换为固定 storage-failed。 */
  private async deleteRaw(key: CredentialKey): Promise<void> {
    try {
      await this.options.credentials.deleteRecord(key)
    } catch (error) {
      throw rethrowOrStorageFailure(error)
    }
  }

  /** 枚举所有记录；底层异常转换为固定 storage-failed。 */
  private async listRaw(): Promise<readonly AccountCredentialRecordEntry[]> {
    try {
      return await this.options.credentials.listRecords()
    } catch (error) {
      throw rethrowOrStorageFailure(error)
    }
  }
}

/** 把未知异常归一为固定 storage-failed；账号域错误原样抛出。 */
function rethrowOrStorageFailure(error: unknown): AccountError {
  if (error instanceof AccountError) return error
  return accountStorageFailed()
}

/** 解析 credentials record；任何 payload 内容都不进入错误。 */
function parseRecord(
  raw: unknown,
  channel: ChannelId,
  accountId: string,
): ParsedRecord {
  if (raw === undefined || raw === null) return { kind: 'missing' }
  if (!isRecord(raw) || raw.kind !== 'grant') return { kind: 'invalid' }
  const payload = isRecord(raw.payload) ? raw.payload : undefined
  if (payload === undefined) return { kind: 'invalid' }

  const payloadChannel = payload.channelId
  if (!isChannelId(payloadChannel)) return { kind: 'invalid' }
  if (payloadChannel !== channel) return { kind: 'foreign' }
  if (payload.accountId !== accountId) return { kind: 'invalid' }
  if (payload.version !== 1) return { kind: 'invalid' }

  const vendorAccountId = safeTrimmedString(
    payload.vendorAccountId,
    MAX_VENDOR_ACCOUNT_ID_LENGTH,
  )
  const displayName = safeTrimmedString(payload.displayName, 120)
  const maskedIdentifier = safeTrimmedString(payload.maskedIdentifier, 80)
  const endpointLabel = safeEndpointLabel(payload.endpointLabel)
  const secret = tryCloneSecret(payload.secret)
  const status = payload.status === undefined
    ? 'ready'
    : isPersistedAccountStatus(payload.status) ? payload.status : undefined

  if (
    vendorAccountId === undefined
    || displayName === undefined
    || maskedIdentifier === undefined
    || endpointLabel === undefined
    || secret === undefined
    || status === undefined
  ) {
    return { kind: 'invalid' }
  }

  return {
    kind: 'valid',
    record: Object.freeze({
      channelId: channel,
      accountId,
      vendorAccountId,
      displayName,
      maskedIdentifier,
      endpointLabel,
      status,
      secret,
    }),
  }
}

/** 把有效记录投影为列表项。 */
function entryFromRecord(record: StoredAccountRecord): StoredAccountEntry {
  return Object.freeze({
    channelId: record.channelId,
    accountId: record.accountId,
    displayName: record.displayName,
    maskedIdentifier: record.maskedIdentifier,
    endpointLabel: record.endpointLabel,
    status: record.status,
    account: record,
  })
}

/** 损坏记录的展示项；只保留从 key 推导出的安全 ID。 */
function invalidEntry(channel: ChannelId, accountId: string): StoredAccountEntry {
  return Object.freeze({
    channelId: channel,
    accountId,
    displayName: accountId,
    maskedIdentifier: '***',
    endpointLabel: CHANNELS[channel].hosts[0]!,
    status: 'credential_unavailable',
  })
}

/** 从 key 中取出某渠道的账号 ID；scope/渠道前缀/语法不符都返回 undefined。 */
function accountIdFromKey(key: string, channel: ChannelId): string | undefined {
  const prefix = `${ACCOUNT_CREDENTIAL_SCOPE}/${channel}-`
  if (!key.startsWith(prefix)) return undefined
  const accountId = key.slice(prefix.length)
  return isStableChannelAccountId(accountId) ? accountId : undefined
}

/** 把内部记录写成 grant payload。 */
function toPayload(record: StoredAccountRecord): Readonly<Record<string, unknown>> {
  return Object.freeze({
    version: 1,
    channelId: record.channelId,
    accountId: record.accountId,
    vendorAccountId: record.vendorAccountId,
    displayName: record.displayName,
    maskedIdentifier: record.maskedIdentifier,
    endpointLabel: record.endpointLabel,
    status: record.status,
    secret: record.secret,
  })
}

/** 默认账号 ID：channel + 厂商身份的 SHA-256 前缀，带字母前缀保证首字符合法。 */
function generateAccountId(channel: ChannelId, vendorAccountId: string): string {
  const digest = createHash('sha256')
    .update(`${ACCOUNT_CREDENTIAL_SCOPE}\u0000${channel}\u0000${vendorAccountId}`)
    .digest('hex')
  return `a${digest.slice(0, 12)}`
}

/** 脱敏标识：只保留首尾字符，绝不返回完整厂商身份。 */
function maskVendorAccountId(vendorAccountId: string): string {
  const characters = [...vendorAccountId]
  if (characters.length <= 2) return '***'
  return `${characters[0]}***${characters[characters.length - 1]}`
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

/** 校验厂商身份：非空、长度受限、无控制字符。 */
function requireVendorAccountId(value: unknown): string {
  const trimmed = safeTrimmedString(value, MAX_VENDOR_ACCOUNT_ID_LENGTH)
  if (trimmed === undefined) throw accountInvalid()
  return trimmed
}

/** 校验可持久化状态。 */
function requirePersistedStatus(value: unknown): PersistedAccountStatus {
  if (!isPersistedAccountStatus(value)) throw accountInvalid()
  return value
}

/** 校验显示名；缺省使用渠道显示名。 */
function normalizeDisplayName(value: unknown, fallback: string): string {
  if (value === undefined) return fallback
  const trimmed = safeTrimmedString(value, 120)
  if (trimmed === undefined) throw accountInvalid()
  return trimmed
}

/** 校验端点标签；缺省使用渠道固定域。 */
function normalizeEndpointLabel(value: unknown, fallback: string): string {
  if (value === undefined) return fallback
  const label = safeEndpointLabel(value)
  if (label === undefined) throw accountInvalid()
  return label
}

/** 安全字符串：trim 后非空、长度受限、无控制字符。 */
function safeTrimmedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) return undefined
  if (CONTROL_CHARACTER.test(trimmed)) return undefined
  return trimmed
}

/** 安全端点标签。 */
function safeEndpointLabel(value: unknown): string | undefined {
  const trimmed = safeTrimmedString(value, 253)
  return trimmed !== undefined && ENDPOINT_LABEL.test(trimmed) ? trimmed : undefined
}

/** 克隆并冻结 JSON 对象秘密；非法输入抛 accountInvalid。 */
function cloneSecret(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw accountInvalid()
  try {
    const text = JSON.stringify(value)
    if (text === undefined) throw new Error('not serializable')
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) throw new Error('not an object')
    return Object.freeze(parsed)
  } catch {
    throw accountInvalid()
  }
}

/** 解析记录时尝试克隆秘密；非法时返回 undefined，由调用方标记损坏。 */
function tryCloneSecret(value: unknown): Readonly<Record<string, unknown>> | undefined {
  try {
    return cloneSecret(value)
  } catch {
    return undefined
  }
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

/** 判断普通数据对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
