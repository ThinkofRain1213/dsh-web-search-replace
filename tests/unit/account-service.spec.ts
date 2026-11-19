/**
 * Task 8：账号服务（当前账号、删除、清理、解析）的行为守卫。
 *
 * 锁死的契约：
 * 1. DTO 只含 id/displayName/channelId/endpointLabel/status/maskedIdentifier；
 *    token、refresh、machine_id、签名材料与厂商原始身份不进入 RPC/错误/日志。
 * 2. 首个账号可设当前；删除当前不自动递补；只有显式且同渠道的 replacement
 *    才替换；clearAll 必须显式调用。
 * 3. R2：普通设置仍只校验 channel + slug；账号服务额外要求记录真实存在于
 *    精确渠道，跨渠道/同协议族一律失败。
 * 4. 写失败保持旧快照；损坏记录显示 credential_unavailable，解析时安全失败。
 *
 * 测试只使用内存 credentials 与设置替身，无真实凭据、网络或 profile。
 */
import { describe, expect, it } from 'vitest'

import { AccountError } from '../../src/host/accounts/errors.ts'
import { accountRecordKey } from '../../src/host/accounts/store.ts'
import { SettingsWriteCancelledError } from '../../src/host/settings/service.ts'
import type { ChannelId } from '../../src/shared/channels.ts'
import { ChannelSearchError } from '../../src/host/search/errors.ts'
import {
  createAccountFixture,
  type AccountFixture,
} from './support/account-fixture.ts'

const TOKEN_SENTINEL = 'SERVICE_TOKEN_SENTINEL_7a2d'
const REFRESH_SENTINEL = 'SERVICE_REFRESH_SENTINEL_7a2d'
const MACHINE_SENTINEL = 'SERVICE_MACHINE_SENTINEL_7a2d'
const UID_SENTINEL = 'SERVICE_UID_SENTINEL_7a2d'

const SUMMARY_KEYS = ['channelId', 'displayName', 'endpointLabel', 'id', 'maskedIdentifier', 'status']

/** 保存腾讯渠道账号。 */
async function saveTencent(
  fixture: AccountFixture,
  channel: 'buddy' | 'workbuddy',
  vendorAccountId: string,
  accessToken = TOKEN_SENTINEL,
) {
  return fixture.store.saveAccount({
    channel,
    vendorAccountId,
    displayName: `${channel} account`,
    secret: { accessToken, refreshToken: REFRESH_SENTINEL },
  })
}

/** 保存 Qoder 渠道账号。 */
async function saveQoder(
  fixture: AccountFixture,
  channel: 'qoder' | 'qodercn',
  vendorAccountId: string,
) {
  return fixture.store.saveAccount({
    channel,
    vendorAccountId,
    displayName: `${channel} account`,
    secret: {
      securityOauthToken: TOKEN_SENTINEL,
      machineId: MACHINE_SENTINEL,
      uid: UID_SENTINEL,
      organizationId: 'ORG_SENTINEL',
    },
  })
}

/** 断言对象/JSON 中不含任何秘密 sentinel。 */
function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value)
  for (const secret of [TOKEN_SENTINEL, REFRESH_SENTINEL, MACHINE_SENTINEL, UID_SENTINEL]) {
    expect(text).not.toContain(secret)
  }
}

describe('账号列表 DTO', () => {
  it('只返回六个非秘密字段，且脱敏标识不包含完整厂商身份', async () => {
    const fixture = createAccountFixture()
    await saveTencent(fixture, 'buddy', 'alice@example.test')

    const summaries = await fixture.service.list('buddy')
    expect(summaries).toHaveLength(1)
    const summary = summaries[0]!
    expect(Object.keys(summary).sort()).toEqual(SUMMARY_KEYS)
    expect(summary.channelId).toBe('buddy')
    expect(summary.endpointLabel).toBe('copilot.tencent.com')
    expect(summary.status).toBe('ready')
    expect(summary.maskedIdentifier).not.toContain('alice@example.test')
    expectNoSecrets(summary)
  })

  it('四个渠道各自只列出自己的账号，即使厂商身份相同', async () => {
    const fixture = createAccountFixture()
    const vendor = 'shared@example.test'
    const buddy = await saveTencent(fixture, 'buddy', vendor)
    const workbuddy = await saveTencent(fixture, 'workbuddy', vendor)
    const qoder = await saveQoder(fixture, 'qoder', vendor)
    const qodercn = await saveQoder(fixture, 'qodercn', vendor)

    const lists = await Promise.all(
      (['buddy', 'workbuddy', 'qoder', 'qodercn'] as ChannelId[])
        .map(channel => fixture.service.list(channel)),
    )
    expect(lists.map(list => list.length)).toEqual([1, 1, 1, 1])
    expect(lists[0]![0]!.id).toBe(buddy.accountId)
    expect(lists[1]![0]!.id).toBe(workbuddy.accountId)
    expect(lists[2]![0]!.id).toBe(qoder.accountId)
    expect(lists[3]![0]!.id).toBe(qodercn.accountId)
    expect(new Set(lists.map(list => list[0]!.id)).size).toBe(4)
  })

  it('端点标签来自渠道固定域，损坏记录显示 credential_unavailable', async () => {
    const fixture = createAccountFixture()
    const record = await saveTencent(fixture, 'buddy', 'broken@example.test')
    fixture.credentials.seed(accountRecordKey('buddy', record.accountId), {
      kind: 'grant',
      payload: {
        version: 1,
        channelId: 'buddy',
        accountId: record.accountId,
        secret: { accessToken: TOKEN_SENTINEL },
      },
    })

    const [summary] = await fixture.service.list('buddy')
    expect(summary).toMatchObject({
      id: record.accountId,
      channelId: 'buddy',
      endpointLabel: 'copilot.tencent.com',
      status: 'credential_unavailable',
    })
    expectNoSecrets(summary)
  })
})

describe('当前账号生命周期', () => {
  it('首个账号可设为当前，并可显式清除', async () => {
    const fixture = createAccountFixture()
    const first = await saveTencent(fixture, 'buddy', 'first@example.test')
    const second = await saveTencent(fixture, 'buddy', 'second@example.test')

    const current = await fixture.service.setCurrent('buddy', first.accountId)
    expect(current?.id).toBe(first.accountId)
    expect((await fixture.service.getCurrent('buddy'))?.id).toBe(first.accountId)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(first.accountId)

    const switched = await fixture.service.setCurrent('buddy', second.accountId)
    expect(switched?.id).toBe(second.accountId)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(second.accountId)

    expect(await fixture.service.setCurrent('buddy', null)).toBeNull()
    expect(await fixture.service.getCurrent('buddy')).toBeNull()
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
  })

  it('跨渠道与同协议族账号不能设为当前，且不写普通配置', async () => {
    const fixture = createAccountFixture()
    const buddy = await saveTencent(fixture, 'buddy', 'buddy@example.test')
    const workbuddy = await saveTencent(fixture, 'workbuddy', 'workbuddy@example.test')
    const qoder = await saveQoder(fixture, 'qoder', 'qoder@example.test')
    const editsBefore = fixture.settingsDouble.edits.length

    for (const [channel, accountId] of [
      ['workbuddy', buddy.accountId],
      ['buddy', workbuddy.accountId],
      ['qodercn', qoder.accountId],
      ['qoder', 'a0123456789ab'],
    ] as const) {
      const error = await fixture.service.setCurrent(channel, accountId).catch(caught => caught)
      expect(error).toBeInstanceOf(AccountError)
      expect(error).toMatchObject({ code: 'accounts/not-found' })
    }

    expect(fixture.settingsDouble.edits).toHaveLength(editsBefore)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
    expect(fixture.settingsDouble.getState().workbuddy.currentAccountId).toBeNull()
  })

  it('非法渠道/非法账号 slug 以 accounts/invalid 失败，且不泄露输入值', async () => {
    const fixture = createAccountFixture()
    const before = fixture.settings.getSnapshot()

    for (const operation of [
      () => fixture.service.list('deepseek' as never),
      () => fixture.service.getCurrent('deepseek' as never),
      () => fixture.service.setCurrent('buddy', 'Account_1'),
      () => fixture.service.setCurrent('buddy', `SENTINEL_${TOKEN_SENTINEL}`),
    ]) {
      const error = await operation().catch(caught => caught)
      expect(error).toBeInstanceOf(AccountError)
      expect(error).toMatchObject({ code: 'accounts/invalid' })
      expect(String((error as Error).message)).not.toContain(TOKEN_SENTINEL)
      expect((error as { cause?: unknown }).cause).toBeUndefined()
    }
    expect(fixture.settings.getSnapshot()).toBe(before)
  })

  it('R2：普通设置仍接受不存在的 slug，账号服务关闭记录存在性缺口', async () => {
    const fixture = createAccountFixture()

    await fixture.settings.setCurrentAccount('buddy', 'ghost-account')
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe('ghost-account')
    const editsBefore = fixture.settingsDouble.edits.length

    const error = await fixture.service.setCurrent('buddy', 'ghost-account').catch(caught => caught)
    expect(error).toBeInstanceOf(AccountError)
    expect(error).toMatchObject({ code: 'accounts/not-found' })
    expect(fixture.settingsDouble.edits).toHaveLength(editsBefore)
  })

  it('设置当前账号写失败时保留旧快照与旧当前账号', async () => {
    const fixture = createAccountFixture()
    const first = await saveTencent(fixture, 'buddy', 'first@example.test')
    const second = await saveTencent(fixture, 'buddy', 'second@example.test')
    await fixture.service.setCurrent('buddy', first.accountId)
    const before = fixture.settings.getSnapshot()
    fixture.settingsDouble.failNextWrite(`profile locked ${TOKEN_SENTINEL}`)

    const error = await fixture.service.setCurrent('buddy', second.accountId).catch(caught => caught)
    expect(error).toBeInstanceOf(AccountError)
    expect(error).toMatchObject({ code: 'accounts/storage-failed' })
    expect(String((error as Error).message)).not.toContain(TOKEN_SENTINEL)
    expect((error as { cause?: unknown }).cause).toBeUndefined()
    expect(fixture.settings.getSnapshot()).toBe(before)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(first.accountId)
  })

  it('取消信号在设置当前账号提交前生效，不写配置', async () => {
    const fixture = createAccountFixture()
    const account = await saveTencent(fixture, 'buddy', 'cancel-current@example.test')
    const controller = new AbortController()
    controller.abort()

    await expect(fixture.service.setCurrent('buddy', account.accountId, controller.signal))
      .rejects.toBeInstanceOf(SettingsWriteCancelledError)
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
    expect(fixture.settingsDouble.edits).toHaveLength(0)
  })
})

describe('删除账号', () => {
  it('删除当前账号不自动递补：没有 replacement 时当前变为 null', async () => {
    const fixture = createAccountFixture()
    const first = await saveTencent(fixture, 'buddy', 'first@example.test')
    const second = await saveTencent(fixture, 'buddy', 'second@example.test')
    await fixture.service.setCurrent('buddy', first.accountId)

    const result = await fixture.service.delete('buddy', first.accountId)

    expect(result.current).toBeNull()
    expect(result.accounts.map(summary => summary.id)).toEqual([second.accountId])
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBeNull()
  })

  it('显式 replacement 且属于同渠道时才替换当前账号', async () => {
    const fixture = createAccountFixture()
    const first = await saveTencent(fixture, 'buddy', 'first@example.test')
    const second = await saveTencent(fixture, 'buddy', 'second@example.test')
    await fixture.service.setCurrent('buddy', first.accountId)

    const result = await fixture.service.delete('buddy', first.accountId, second.accountId)

    expect(result.current?.id).toBe(second.accountId)
    expect(result.accounts.map(summary => summary.id)).toEqual([second.accountId])
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(second.accountId)
  })

  it('replacement 属于其他渠道（含同协议族）时删除失败且当前账号不变', async () => {
    const fixture = createAccountFixture()
    const buddy = await saveTencent(fixture, 'buddy', 'buddy@example.test')
    const workbuddy = await saveTencent(fixture, 'workbuddy', 'workbuddy@example.test')
    await fixture.service.setCurrent('buddy', buddy.accountId)

    const error = await fixture.service
      .delete('buddy', buddy.accountId, workbuddy.accountId)
      .catch(caught => caught)

    expect(error).toBeInstanceOf(AccountError)
    expect(error).toMatchObject({ code: 'accounts/not-found' })
    expect((await fixture.service.list('buddy')).map(summary => summary.id)).toEqual([buddy.accountId])
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(buddy.accountId)
  })

  it('replacement 与被删除账号相同属于非法请求', async () => {
    const fixture = createAccountFixture()
    const buddy = await saveTencent(fixture, 'buddy', 'buddy@example.test')

    const error = await fixture.service
      .delete('buddy', buddy.accountId, buddy.accountId)
      .catch(caught => caught)

    expect(error).toBeInstanceOf(AccountError)
    expect(error).toMatchObject({ code: 'accounts/invalid' })
    expect((await fixture.service.list('buddy')).map(summary => summary.id)).toEqual([buddy.accountId])
  })

  it('删除非当前账号不影响当前账号，即使显式给了 replacement', async () => {
    const fixture = createAccountFixture()
    const first = await saveTencent(fixture, 'buddy', 'first@example.test')
    const second = await saveTencent(fixture, 'buddy', 'second@example.test')
    await fixture.service.setCurrent('buddy', first.accountId)

    const result = await fixture.service.delete('buddy', second.accountId, first.accountId)

    expect(result.current?.id).toBe(first.accountId)
    expect(result.accounts.map(summary => summary.id)).toEqual([first.accountId])
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(first.accountId)
  })

  it('删除当前账号的配置写失败时保留旧快照与账号记录', async () => {
    const fixture = createAccountFixture()
    const first = await saveTencent(fixture, 'buddy', 'first@example.test')
    await fixture.service.setCurrent('buddy', first.accountId)
    const before = fixture.settings.getSnapshot()
    fixture.settingsDouble.failNextWrite(`delete locked ${TOKEN_SENTINEL}`)

    const error = await fixture.service.delete('buddy', first.accountId).catch(caught => caught)

    expect(error).toBeInstanceOf(AccountError)
    expect(error).toMatchObject({ code: 'accounts/storage-failed' })
    expect(String((error as Error).message)).not.toContain(TOKEN_SENTINEL)
    expect(fixture.settings.getSnapshot()).toBe(before)
    expect((await fixture.service.list('buddy')).map(summary => summary.id)).toEqual([first.accountId])
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(first.accountId)
  })

  it('删除当前账号的凭据删除失败时恢复删除前的当前账号，记录仍在', async () => {
    const fixture = createAccountFixture()
    const first = await saveTencent(fixture, 'buddy', 'first@example.test')
    await fixture.service.setCurrent('buddy', first.accountId)
    fixture.credentials.failNextDelete = new Error(`delete offline ${TOKEN_SENTINEL}`)

    const error = await fixture.service.delete('buddy', first.accountId).catch(caught => caught)

    expect(error).toBeInstanceOf(AccountError)
    expect(error).toMatchObject({ code: 'accounts/storage-failed' })
    expect(String((error as Error).message)).not.toContain(TOKEN_SENTINEL)
    expect((await fixture.service.list('buddy')).map(summary => summary.id)).toEqual([first.accountId])
    expect(fixture.settingsDouble.getState().buddy.currentAccountId).toBe(first.accountId)
  })

  it('跨渠道删除不存在账号失败且不触碰其他渠道记录', async () => {
    const fixture = createAccountFixture()
    const buddy = await saveTencent(fixture, 'buddy', 'buddy@example.test')

    const error = await fixture.service.delete('workbuddy', buddy.accountId).catch(caught => caught)
    expect(error).toBeInstanceOf(AccountError)
    expect(error).toMatchObject({ code: 'accounts/not-found' })
    expect((await fixture.service.list('buddy')).map(summary => summary.id)).toEqual([buddy.accountId])
  })
})

describe('清除全部账号数据', () => {
  it('显式 clearAll 清空四个渠道的当前账号与凭据，返回删除数量', async () => {
    const fixture = createAccountFixture()
    const buddyA = await saveTencent(fixture, 'buddy', 'a@example.test')
    const buddyB = await saveTencent(fixture, 'buddy', 'b@example.test')
    const qoder = await saveQoder(fixture, 'qoder', 'c@example.test')
    await fixture.service.setCurrent('buddy', buddyA.accountId)
    await fixture.service.setCurrent('qoder', qoder.accountId)
    fixture.credentials.seed('other-plugin/buddy-a0123456789ab', {
      kind: 'grant',
      payload: { anything: true },
    })

    const result = await fixture.service.clearAll()

    expect(result).toEqual({ cleared: 3 })
    for (const channel of ['buddy', 'workbuddy', 'qoder', 'qodercn'] as ChannelId[]) {
      expect(await fixture.service.list(channel)).toEqual([])
      expect(fixture.settingsDouble.getState()[channel].currentAccountId).toBeNull()
    }
    expect(fixture.credentials.keys()).toEqual(['other-plugin/buddy-a0123456789ab'])
    expect(buddyB.accountId).not.toBe(buddyA.accountId)
  })

  it('clearAll 的配置写失败发生在删除凭据之前，记录与旧快照都保留', async () => {
    const fixture = createAccountFixture()
    const buddy = await saveTencent(fixture, 'buddy', 'buddy@example.test')
    await fixture.service.setCurrent('buddy', buddy.accountId)
    const before = fixture.settings.getSnapshot()
    fixture.settingsDouble.failNextWrite(`clear locked ${TOKEN_SENTINEL}`)

    const error = await fixture.service.clearAll().catch(caught => caught)

    expect(error).toBeInstanceOf(AccountError)
    expect(error).toMatchObject({ code: 'accounts/storage-failed' })
    expect(String((error as Error).message)).not.toContain(TOKEN_SENTINEL)
    expect(fixture.settings.getSnapshot()).toBe(before)
    expect((await fixture.service.list('buddy')).map(summary => summary.id)).toEqual([buddy.accountId])
  })
})

describe('resolveCurrentCredential', () => {
  it('没有当前账号时返回 null', async () => {
    const fixture = createAccountFixture()
    expect(await fixture.service.resolveCurrentCredential('buddy')).toBeNull()
  })

  it('返回同渠道同账号的腾讯访问令牌快照', async () => {
    const fixture = createAccountFixture()
    const record = await saveTencent(fixture, 'buddy', 'resolve@example.test', `  ${TOKEN_SENTINEL}  `)
    await fixture.service.setCurrent('buddy', record.accountId)

    await expect(fixture.service.resolveCurrentCredential('buddy')).resolves.toEqual({
      kind: 'tencent-access-token',
      channelId: 'buddy',
      accountId: record.accountId,
      accessToken: TOKEN_SENTINEL,
    })
  })

  it('返回同渠道同账号的 Qoder 签名凭据快照', async () => {
    const fixture = createAccountFixture()
    const record = await saveQoder(fixture, 'qoder', 'resolve-qoder@example.test')
    await fixture.service.setCurrent('qoder', record.accountId)

    await expect(fixture.service.resolveCurrentCredential('qoder')).resolves.toEqual({
      kind: 'qoder-signing',
      channelId: 'qoder',
      accountId: record.accountId,
      credential: {
        uid: UID_SENTINEL,
        securityOauthToken: TOKEN_SENTINEL,
        machineId: MACHINE_SENTINEL,
        organizationId: 'ORG_SENTINEL',
      },
    })
  })

  it('普通配置指向其他渠道账号时返回 null，绝不跨渠道解析', async () => {
    const fixture = createAccountFixture()
    const buddy = await saveTencent(fixture, 'buddy', 'cross@example.test')
    await fixture.settings.setCurrentAccount('workbuddy', buddy.accountId)

    expect(await fixture.service.resolveCurrentCredential('workbuddy')).toBeNull()
    expect(await fixture.service.getCurrent('workbuddy')).toBeNull()
  })

  it('当前账号记录被删除后返回 null', async () => {
    const fixture = createAccountFixture()
    const record = await saveTencent(fixture, 'buddy', 'gone@example.test')
    await fixture.service.setCurrent('buddy', record.accountId)
    await fixture.credentials.deleteRecord(accountRecordKey('buddy', record.accountId))

    expect(await fixture.service.resolveCurrentCredential('buddy')).toBeNull()
  })

  it('损坏记录以安全结构化 SEARCH_FAILED 失败，绑定精确渠道且不含秘密/cause', async () => {
    const fixture = createAccountFixture()
    const record = await saveTencent(fixture, 'buddy', 'broken@example.test')
    await fixture.service.setCurrent('buddy', record.accountId)
    fixture.credentials.seed(accountRecordKey('buddy', record.accountId), {
      kind: 'grant',
      payload: { channelId: 'buddy', secret: { accessToken: TOKEN_SENTINEL } },
    })

    const error = await fixture.service.resolveCurrentCredential('buddy').catch(caught => caught)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'SEARCH_FAILED', channel: 'buddy' })
    expect(String((error as Error).message)).not.toContain(TOKEN_SENTINEL)
    expect((error as { cause?: unknown }).cause).toBeUndefined()
  })

  it('凭据存储读取失败以安全结构化 SEARCH_FAILED 失败', async () => {
    const fixture = createAccountFixture()
    const record = await saveTencent(fixture, 'buddy', 'offline@example.test')
    await fixture.service.setCurrent('buddy', record.accountId)
    fixture.credentials.failNextRead = new Error(`store offline ${TOKEN_SENTINEL}`)

    const error = await fixture.service.resolveCurrentCredential('buddy').catch(caught => caught)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'SEARCH_FAILED', channel: 'buddy' })
    expect(String((error as Error).message)).not.toContain(TOKEN_SENTINEL)
    expect((error as { cause?: unknown }).cause).toBeUndefined()
  })

  it('损坏记录不能设为当前，列表与 getCurrent 显示 credential_unavailable', async () => {
    const fixture = createAccountFixture()
    const record = await saveTencent(fixture, 'buddy', 'corrupt@example.test')
    fixture.credentials.seed(accountRecordKey('buddy', record.accountId), {
      kind: 'grant',
      payload: { channelId: 'buddy' },
    })

    const error = await fixture.service.setCurrent('buddy', record.accountId).catch(caught => caught)
    expect(error).toBeInstanceOf(AccountError)
    expect(error).toMatchObject({ code: 'accounts/unavailable' })

    await fixture.settings.setCurrentAccount('buddy', record.accountId)
    const current = await fixture.service.getCurrent('buddy')
    expect(current).toMatchObject({
      id: record.accountId,
      status: 'credential_unavailable',
    })
    expectNoSecrets(current)
  })
})
