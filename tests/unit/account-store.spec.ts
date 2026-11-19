/**
 * Task 8：四渠道独立凭据库（store 层）的行为守卫。
 *
 * 锁死的契约：
 * 1. credentials key 的 scope/id 都满足 `^[a-z][a-z0-9-]*$`；账号使用生成的
 *    稳定小写 ID，记录 ID 与 payload 都编码 channelId，绝不用邮箱/厂商原始 ID
 *    拼 key。
 * 2. 所有 list/read/delete/clear 只碰本插件 scope；跨渠道（含同协议族）永远
 *    读不到、删不到另一渠道记录。
 * 3. 伪造/损坏的 grant payload 不得被当成可用账号，也不得让原始内容进入错误。
 * 4. `modifyRecord` 是唯一写路径：并发保存不丢记录；写失败不改旧记录。
 *
 * 测试只使用内存 credentials，无真实凭据、网络或 profile。
 */
import { describe, expect, it } from 'vitest'

import { AccountError } from '../../src/host/accounts/errors.ts'
import {
  ACCOUNT_CREDENTIAL_SCOPE,
  AccountStore,
  accountRecordKey,
  buildCredentialKey,
  CREDENTIAL_KEY_SEGMENT_PATTERN,
} from '../../src/host/accounts/store.ts'
import type { ChannelId } from '../../src/shared/channels.ts'
import { MemoryCredentials } from './support/memory-credentials.ts'

const SCOPE = ACCOUNT_CREDENTIAL_SCOPE
const TOKEN_SENTINEL = 'STORE_TOKEN_SENTINEL_5f1c'
const REFRESH_SENTINEL = 'STORE_REFRESH_SENTINEL_5f1c'

/** 创建只带内存 credentials 的 store。 */
function createStore(): { store: AccountStore; credentials: MemoryCredentials } {
  const credentials = new MemoryCredentials()
  return { store: new AccountStore({ credentials }), credentials }
}

/** 保存一个腾讯渠道账号。 */
async function saveTencent(
  store: AccountStore,
  channel: 'buddy' | 'workbuddy',
  vendorAccountId = 'vendor@example.test',
  accessToken = TOKEN_SENTINEL,
) {
  return store.saveAccount({
    channel,
    vendorAccountId,
    displayName: `${channel} account`,
    secret: { accessToken, refreshToken: REFRESH_SENTINEL },
  })
}

/** 保存一个 Qoder 渠道账号。 */
async function saveQoder(
  store: AccountStore,
  channel: 'qoder' | 'qodercn',
  vendorAccountId = 'qoder-vendor@example.test',
) {
  return store.saveAccount({
    channel,
    vendorAccountId,
    displayName: `${channel} account`,
    secret: {
      securityOauthToken: TOKEN_SENTINEL,
      machineId: 'MACHINE_SENTINEL_5f1c',
    },
  })
}

describe('凭据 key 语法与账号 ID 生成', () => {
  it('scope 与记录 ID 两段都满足稳定小写语法，记录 ID 含 channelId', async () => {
    const { store, credentials } = createStore()
    const record = await saveTencent(store, 'buddy')

    const key = accountRecordKey('buddy', record.accountId)
    expect(key.startsWith(`${SCOPE}/`)).toBe(true)
    const [scope, id] = key.split('/')
    expect(scope).toBe('dsh-web-search-channels')
    expect(scope).toMatch(CREDENTIAL_KEY_SEGMENT_PATTERN)
    expect(id).toMatch(CREDENTIAL_KEY_SEGMENT_PATTERN)
    expect(id).toContain('buddy')
    expect(id).toBe(`buddy-${record.accountId}`)
    expect(credentials.keys()).toEqual([key])
  })

  it('账号 ID 是生成的小写 slug，不包含邮箱或厂商原始 ID', async () => {
    const { store, credentials } = createStore()
    const vendor = 'Alice.Smith+Search@Example.TEST'
    const record = await saveTencent(store, 'buddy', vendor)

    expect(record.accountId).toMatch(CREDENTIAL_KEY_SEGMENT_PATTERN)
    expect(record.accountId.toLowerCase()).toBe(record.accountId)
    expect(record.accountId).not.toContain('alice')
    expect(record.accountId).not.toContain('example')
    expect(credentials.keys()[0]).not.toContain('alice')
    expect(credentials.keys()[0]).not.toContain('example')
  })

  it('同一渠道同一厂商身份得到稳定 ID，重复保存只保留一条记录', async () => {
    const { store, credentials } = createStore()
    const first = await saveTencent(store, 'buddy', 'stable-vendor@example.test')
    const second = await saveTencent(store, 'buddy', 'stable-vendor@example.test')

    expect(second.accountId).toBe(first.accountId)
    expect(credentials.keys()).toHaveLength(1)
    expect(await store.listEntries('buddy')).toHaveLength(1)
  })

  it('更新既有账号时省略显示名/端点标签不会丢失原值', async () => {
    const { store } = createStore()
    const first = await store.saveAccount({
      channel: 'qoder',
      vendorAccountId: 'preserve@example.test',
      displayName: 'Alice Qoder',
      endpointLabel: 'api2.qoder.sh',
      secret: { securityOauthToken: 'OLD', machineId: 'MACHINE' },
    })
    const updated = await store.saveAccount({
      channel: 'qoder',
      vendorAccountId: 'preserve@example.test',
      secret: { securityOauthToken: TOKEN_SENTINEL, machineId: 'MACHINE' },
    })

    expect(updated.accountId).toBe(first.accountId)
    expect(updated.displayName).toBe('Alice Qoder')
    expect(updated.endpointLabel).toBe('api2.qoder.sh')
    expect(updated.secret).toEqual({ securityOauthToken: TOKEN_SENTINEL, machineId: 'MACHINE' })
  })

  it('同一厂商身份在不同渠道得到不同 ID 与不同记录', async () => {
    const { store, credentials } = createStore()
    const buddy = await saveTencent(store, 'buddy', 'shared-vendor@example.test')
    const workbuddy = await saveTencent(store, 'workbuddy', 'shared-vendor@example.test')
    const qoder = await saveQoder(store, 'qoder', 'shared-vendor@example.test')
    const qodercn = await saveQoder(store, 'qodercn', 'shared-vendor@example.test')

    const ids = [buddy.accountId, workbuddy.accountId, qoder.accountId, qodercn.accountId]
    expect(new Set(ids).size).toBe(4)
    expect(credentials.keys()).toHaveLength(4)
    expect(await store.listEntries('buddy')).toHaveLength(1)
    expect(await store.listEntries('workbuddy')).toHaveLength(1)
    expect(await store.listEntries('qoder')).toHaveLength(1)
    expect(await store.listEntries('qodercn')).toHaveLength(1)
  })

  it('拒绝非法 scope/记录 ID 段，不允许构造越界 key', () => {
    for (const [scope, id] of [
      ['Upper', 'buddy-a1'],
      ['dsh_web', 'buddy-a1'],
      ['1plugin', 'buddy-a1'],
      ['dsh-web-search-channels', 'Buddy-a1'],
      ['dsh-web-search-channels', '../buddy'],
      ['dsh-web-search-channels', 'buddy/a1'],
      ['dsh-web-search-channels', '-buddy'],
      ['dsh-web-search-channels', ''],
    ] as const) {
      expect(() => buildCredentialKey(scope, id)).toThrow(TypeError)
    }
  })

  it('记录 payload 编码 channelId、accountId 与厂商身份（只在记录内）', async () => {
    const { store, credentials } = createStore()
    const vendor = 'payload-vendor@example.test'
    const record = await saveTencent(store, 'buddy', vendor)

    const raw = credentials.raw(accountRecordKey('buddy', record.accountId))
    expect(raw?.kind).toBe('grant')
    const payload = raw?.payload as Record<string, unknown>
    expect(payload.channelId).toBe('buddy')
    expect(payload.accountId).toBe(record.accountId)
    expect(payload.vendorAccountId).toBe(vendor)
    expect(payload.version).toBe(1)
  })
})

describe('渠道隔离：同协议族也不能串用', () => {
  it('buddy 记录对 workbuddy 的 list/read/delete 不可见', async () => {
    const { store, credentials } = createStore()
    const buddy = await saveTencent(store, 'buddy')

    expect(await store.listEntries('workbuddy')).toEqual([])
    expect(await store.readEntry('workbuddy', buddy.accountId)).toBeUndefined()
    expect(await store.deleteAccount('workbuddy', buddy.accountId)).toBe(false)
    expect(credentials.raw(accountRecordKey('buddy', buddy.accountId))).toBeDefined()
  })

  it('qoder 记录对 qodercn 的 list/read/delete 不可见', async () => {
    const { store, credentials } = createStore()
    const qoder = await saveQoder(store, 'qoder')

    expect(await store.listEntries('qodercn')).toEqual([])
    expect(await store.readEntry('qodercn', qoder.accountId)).toBeUndefined()
    expect(await store.deleteAccount('qodercn', qoder.accountId)).toBe(false)
    expect(credentials.raw(accountRecordKey('qoder', qoder.accountId))).toBeDefined()
  })

  it('伪造 payload：key 属于 buddy、payload 声称 workbuddy 时不得被任何渠道采用', async () => {
    const { store, credentials } = createStore()
    const forgedId = 'a0123456789ab'
    const key = accountRecordKey('buddy', forgedId)
    credentials.seed(key, {
      kind: 'grant',
      payload: {
        version: 1,
        channelId: 'workbuddy',
        accountId: forgedId,
        vendorAccountId: 'forged-vendor',
        displayName: 'Forged',
        maskedIdentifier: 'f***d',
        endpointLabel: 'www.workbuddy.ai',
        status: 'ready',
        secret: { accessToken: TOKEN_SENTINEL },
      },
    })

    expect(await store.listEntries('buddy')).toEqual([])
    expect(await store.listEntries('workbuddy')).toEqual([])
    expect(await store.readEntry('buddy', forgedId)).toBeUndefined()
    expect(await store.deleteAccount('buddy', forgedId)).toBe(false)
    expect(credentials.raw(key)).toBeDefined()
  })
})

describe('本插件 scope 边界', () => {
  it('list 只返回本插件 scope 的记录，且不会读取其他 scope 的 payload', async () => {
    const { store, credentials } = createStore()
    await saveTencent(store, 'buddy')
    credentials.seed('other-plugin/buddy-a0123456789ab', {
      kind: 'grant',
      payload: {
        version: 1,
        channelId: 'buddy',
        accountId: 'a0123456789ab',
        vendorAccountId: 'foreign-vendor',
        displayName: 'Foreign',
        maskedIdentifier: 'f***n',
        endpointLabel: 'copilot.tencent.com',
        status: 'ready',
        secret: { accessToken: 'FOREIGN_TOKEN' },
      },
    })

    const entries = await store.listEntries('buddy')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.accountId).not.toBe('a0123456789ab')
    expect(credentials.reads.every(key => key.startsWith(`${SCOPE}/`))).toBe(true)
  })

  it('clearAll 只删除本插件 scope，其他插件的记录原样保留', async () => {
    const { store, credentials } = createStore()
    await saveTencent(store, 'buddy')
    await saveQoder(store, 'qoder')
    credentials.seed('other-plugin/buddy-a0123456789ab', {
      kind: 'grant',
      payload: { anything: true },
    })

    expect(await store.clearAll()).toBe(2)
    expect(credentials.keys()).toEqual(['other-plugin/buddy-a0123456789ab'])
  })
})

describe('损坏记录：不可解析但可清理', () => {
  it('缺字段的 grant payload 被标记 credential_unavailable，且不暴露任何原始内容', async () => {
    const { store, credentials } = createStore()
    const accountId = 'a0123456789ab'
    const key = accountRecordKey('buddy', accountId)
    credentials.seed(key, {
      kind: 'grant',
      payload: {
        version: 1,
        channelId: 'buddy',
        secret: { accessToken: TOKEN_SENTINEL },
        brokenSentinel: 'BROKEN_PAYLOAD_SENTINEL',
      },
    })

    const entry = await store.readEntry('buddy', accountId)
    expect(entry).toMatchObject({
      channelId: 'buddy',
      accountId,
      status: 'credential_unavailable',
    })
    expect(entry?.account).toBeUndefined()
    expect(JSON.stringify(entry)).not.toContain(TOKEN_SENTINEL)
    expect(JSON.stringify(entry)).not.toContain('BROKEN_PAYLOAD_SENTINEL')
    expect(await store.listEntries('buddy')).toHaveLength(1)
  })

  it('非 grant kind 同样视为不可用，并允许删除清理', async () => {
    const { store, credentials } = createStore()
    const accountId = 'a0123456789ab'
    const key = accountRecordKey('buddy', accountId)
    credentials.seed(key, { kind: 'api-key', key: TOKEN_SENTINEL })

    const entry = await store.readEntry('buddy', accountId)
    expect(entry?.account).toBeUndefined()
    expect(entry?.status).toBe('credential_unavailable')
    expect(await store.deleteAccount('buddy', accountId)).toBe(true)
    expect(credentials.keys()).toEqual([])
  })

  it('本渠道损坏记录可被重新保存修复（同 key），不会产生孤儿记录', async () => {
    const credentials = new MemoryCredentials()
    const accountId = 'a0123456789ab'
    const store = new AccountStore({ credentials, generateAccountId: () => accountId })
    const key = accountRecordKey('buddy', accountId)
    credentials.seed(key, {
      kind: 'grant',
      payload: {
        version: 1,
        channelId: 'buddy',
        accountId,
        secret: { accessToken: 'OLD_TOKEN' },
      },
    })

    const saved = await store.saveAccount({
      channel: 'buddy',
      vendorAccountId: 'repair@example.test',
      secret: { accessToken: TOKEN_SENTINEL },
    })

    expect(saved.accountId).toBe(accountId)
    expect(credentials.keys()).toEqual([key])
    const entry = await store.readEntry('buddy', accountId)
    expect(entry?.status).toBe('ready')
    expect(entry?.account?.secret).toEqual({ accessToken: TOKEN_SENTINEL })
  })

  it('保存到损坏/伪造 key 时不覆盖未知数据，返回 conflict 且不泄露内容', async () => {
    const credentials = new MemoryCredentials()
    const accountId = 'a0123456789ab'
    const store = new AccountStore({ credentials, generateAccountId: () => accountId })
    const key = accountRecordKey('buddy', accountId)
    credentials.seed(key, {
      kind: 'grant',
      payload: { channelId: 'workbuddy', sentinel: 'CONFLICT_SENTINEL' },
    })

    const error = await store.saveAccount({
      channel: 'buddy',
      vendorAccountId: 'vendor@example.test',
      secret: { accessToken: TOKEN_SENTINEL },
    }).catch(caught => caught)

    expect(error).toBeInstanceOf(AccountError)
    expect(error).toMatchObject({ code: 'accounts/conflict' })
    expect(String((error as Error).message)).not.toContain('CONFLICT_SENTINEL')
    expect((error as { cause?: unknown }).cause).toBeUndefined()
    expect(credentials.raw(key)).toBeDefined()
  })
})

describe('并发写入与写失败', () => {
  it('并发保存同一厂商账号只产生一条记录，所有调用返回同一 ID', async () => {
    const { store, credentials } = createStore()
    const saves = await Promise.all(Array.from({ length: 12 }, (_, index) => (
      store.saveAccount({
        channel: 'buddy',
        vendorAccountId: 'concurrent-vendor@example.test',
        displayName: `Concurrent ${index}`,
        secret: { accessToken: `${TOKEN_SENTINEL}_${index}` },
      })
    )))

    expect(new Set(saves.map(record => record.accountId)).size).toBe(1)
    expect(credentials.keys()).toHaveLength(1)
    expect(await store.listEntries('buddy')).toHaveLength(1)
  })

  it('并发保存不同厂商账号不会丢记录', async () => {
    const { store, credentials } = createStore()
    await Promise.all(Array.from({ length: 8 }, (_, index) => (
      store.saveAccount({
        channel: 'qoder',
        vendorAccountId: `vendor-${index}@example.test`,
        secret: {
          securityOauthToken: `${TOKEN_SENTINEL}_${index}`,
          machineId: `MACHINE_${index}`,
        },
      })
    )))

    expect(credentials.keys()).toHaveLength(8)
    expect(await store.listEntries('qoder')).toHaveLength(8)
  })

  it('modifyRecord 失败时保存失败且旧记录原样保留', async () => {
    const { store, credentials } = createStore()
    const original = await saveTencent(store, 'buddy', 'write-failure@example.test', 'ORIGINAL_TOKEN')
    const before = credentials.raw(accountRecordKey('buddy', original.accountId))
    credentials.failNextModify = new Error(`store offline ${TOKEN_SENTINEL}`)

    const error = await store.saveAccount({
      channel: 'buddy',
      vendorAccountId: 'write-failure@example.test',
      secret: { accessToken: 'NEW_TOKEN' },
    }).catch(caught => caught)

    expect(error).toBeInstanceOf(AccountError)
    expect(error).toMatchObject({ code: 'accounts/storage-failed' })
    expect(String((error as Error).message)).not.toContain(TOKEN_SENTINEL)
    expect((error as { cause?: unknown }).cause).toBeUndefined()
    expect(credentials.raw(accountRecordKey('buddy', original.accountId))).toEqual(before)
  })

  it('readRecord 失败时 list/read 以固定 storage-failed 失败且不泄露底层异常', async () => {
    const { store, credentials } = createStore()
    const record = await saveTencent(store, 'buddy')

    for (const operation of [
      () => store.readEntry('buddy', record.accountId),
      () => store.listEntries('buddy'),
    ]) {
      credentials.failNextRead = new Error(`read offline ${TOKEN_SENTINEL}`)
      const error = await operation().catch(caught => caught)
      expect(error).toBeInstanceOf(AccountError)
      expect(error).toMatchObject({ code: 'accounts/storage-failed' })
      expect(String((error as Error).message)).not.toContain(TOKEN_SENTINEL)
      expect((error as { cause?: unknown }).cause).toBeUndefined()
    }
  })

  it('deleteRecord 失败时删除失败且记录仍在', async () => {
    const { store, credentials } = createStore()
    const record = await saveTencent(store, 'buddy')
    credentials.failNextDelete = new Error(`delete offline ${TOKEN_SENTINEL}`)

    const error = await store.deleteAccount('buddy', record.accountId).catch(caught => caught)
    expect(error).toBeInstanceOf(AccountError)
    expect(error).toMatchObject({ code: 'accounts/storage-failed' })
    expect(String((error as Error).message)).not.toContain(TOKEN_SENTINEL)
    expect(credentials.raw(accountRecordKey('buddy', record.accountId))).toBeDefined()
  })

  it('listRecords 失败时 clearAll/list 以固定 storage-failed 失败', async () => {
    const { store, credentials } = createStore()
    await saveTencent(store, 'buddy')

    for (const operation of [
      () => store.clearAll(),
      () => store.listEntries('buddy'),
    ]) {
      credentials.failNextList = new Error(`list offline ${TOKEN_SENTINEL}`)
      const error = await operation().catch(caught => caught)
      expect(error).toBeInstanceOf(AccountError)
      expect(error).toMatchObject({ code: 'accounts/storage-failed' })
      expect(String((error as Error).message)).not.toContain(TOKEN_SENTINEL)
    }
  })
})

describe('删除与清理', () => {
  it('删除只作用于精确渠道与账号，返回是否真的删除', async () => {
    const { store, credentials } = createStore()
    const first = await saveTencent(store, 'buddy', 'first@example.test')
    const second = await saveTencent(store, 'buddy', 'second@example.test')

    expect(await store.deleteAccount('buddy', first.accountId)).toBe(true)
    expect(credentials.keys()).toEqual([accountRecordKey('buddy', second.accountId)])
    expect(await store.deleteAccount('buddy', first.accountId)).toBe(false)
  })

  it('clearAll 返回删除数量，删除后 list 为空', async () => {
    const { store } = createStore()
    await saveTencent(store, 'buddy', 'a@example.test')
    await saveTencent(store, 'workbuddy', 'b@example.test')
    await saveQoder(store, 'qoder', 'c@example.test')
    await saveQoder(store, 'qodercn', 'd@example.test')

    expect(await store.clearAll()).toBe(4)
    for (const channel of ['buddy', 'workbuddy', 'qoder', 'qodercn'] as ChannelId[]) {
      expect(await store.listEntries(channel)).toEqual([])
    }
    expect(await store.clearAll()).toBe(0)
  })
})
