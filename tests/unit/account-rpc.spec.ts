/**
 * Task 8：账号管理 RPC（`accounts.*`）的传输、校验与脱敏守卫。
 *
 * 锁死的契约：
 * 1. 五个方法 `accounts.list/current/setCurrent/delete/clearAll` 走同一条
 *    `/api/web-search-replace` 精确路由与统一 `{ok,value}|{ok,error}` 信封。
 * 2. 成功结果只含账号六字段；token/refresh/machine_id/签名材料/厂商身份不得
 *    出现在任何响应、错误、details 或 cause 中。
 * 3. 非法 payload、跨渠道操作与未知方法都以固定错误码失败，不回显输入值。
 * 4. `clearAll` 只能由显式 RPC 触发；未装配账号服务的 Host 必须拒绝该方法。
 *
 * 测试使用内存 credentials 与设置替身，无真实凭据、网络或 profile。
 */
import { describe, expect, it } from 'vitest'

import { registerManagementRpc } from '../../src/host/rpc.ts'
import type { ChannelId } from '../../src/shared/channels.ts'
import type { AccountSummary } from '../../src/shared/accounts.ts'
import {
  MANAGEMENT_RPC_ENDPOINT,
  MANAGEMENT_RPC_PATH,
  type ManagementRpcConnection,
  type ManagementRpcRoute,
  type RpcResult,
} from '../../src/shared/rpc.ts'
import { createAccountFixture, type AccountFixture } from './support/account-fixture.ts'

const TOKEN_SENTINEL = 'RPC_TOKEN_SENTINEL_91bc'
const REFRESH_SENTINEL = 'RPC_REFRESH_SENTINEL_91bc'
const MACHINE_SENTINEL = 'RPC_MACHINE_SENTINEL_91bc'
const UID_SENTINEL = 'RPC_UID_SENTINEL_91bc'

const SUMMARY_KEYS = ['channelId', 'displayName', 'endpointLabel', 'id', 'maskedIdentifier', 'status']

/** RPC 测试夹具：真实路由 + 真实账号服务 + 内存凭据。 */
interface RpcHarness extends AccountFixture {
  readonly routes: Map<string, ManagementRpcRoute>
  readonly dispose: () => Promise<void>
}

/** 创建已注册账号路由的 Host。 */
function createRpcHarness(options: { readonly withAccounts?: boolean } = {}): RpcHarness {
  const fixture = createAccountFixture()
  const routes = new Map<string, ManagementRpcRoute>()
  const connection: ManagementRpcConnection = {
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return async () => {
          routes.delete(route.path)
        }
      },
    },
    rpc: {
      async call() {
        throw new Error('account RPC tests call the registered route directly')
      },
    },
  }
  const dispose = options.withAccounts === false
    ? registerManagementRpc(connection, fixture.settings)
    : registerManagementRpc(connection, fixture.settings, fixture.service)
  return { ...fixture, routes, dispose }
}

/** 直接发送 client-request 信封，绕开任何不存在的 Client 校验。 */
async function call(
  harness: RpcHarness,
  method: string,
  payload: unknown,
): Promise<RpcResult<unknown>> {
  const route = harness.routes.get(MANAGEMENT_RPC_PATH)
  if (route === undefined) throw new Error('management route was not registered')
  const response = await route.fetch(new Request(`http://127.0.0.1${MANAGEMENT_RPC_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'account-rpc-test',
      method: MANAGEMENT_RPC_ENDPOINT,
      payload: { method, payload },
    }),
  }))
  const body = await response.json() as { result: RpcResult<unknown> }
  return body.result
}

/** 保存腾讯渠道账号。 */
async function saveTencent(
  harness: RpcHarness,
  channel: 'buddy' | 'workbuddy',
  vendorAccountId: string,
) {
  return harness.store.saveAccount({
    channel,
    vendorAccountId,
    displayName: `${channel} account`,
    secret: { accessToken: TOKEN_SENTINEL, refreshToken: REFRESH_SENTINEL },
  })
}

/** 保存 Qoder 渠道账号。 */
async function saveQoder(
  harness: RpcHarness,
  channel: 'qoder' | 'qodercn',
  vendorAccountId: string,
) {
  return harness.store.saveAccount({
    channel,
    vendorAccountId,
    displayName: `${channel} account`,
    secret: {
      securityOauthToken: TOKEN_SENTINEL,
      machineId: MACHINE_SENTINEL,
      uid: UID_SENTINEL,
    },
  })
}

/** 断言 JSON 中不含任何秘密 sentinel。 */
function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value)
  for (const secret of [TOKEN_SENTINEL, REFRESH_SENTINEL, MACHINE_SENTINEL, UID_SENTINEL]) {
    expect(text).not.toContain(secret)
  }
}

/** 断言账号 DTO 只含允许字段。 */
function expectSummaryShape(value: unknown): AccountSummary {
  const summary = value as AccountSummary
  expect(Object.keys(summary).sort()).toEqual(SUMMARY_KEYS)
  expectNoSecrets(summary)
  return summary
}

describe('账号 RPC 路由与列表', () => {
  it('注册同一条精确路由，list 默认返回空数组', async () => {
    const harness = createRpcHarness()
    expect(harness.routes.has(MANAGEMENT_RPC_PATH)).toBe(true)

    const result = await call(harness, 'accounts.list', { channel: 'buddy' })
    expect(result).toEqual({ ok: true, value: [] })
  })

  it('list 只返回六字段 DTO，不返回 token/refresh/machine_id/厂商身份', async () => {
    const harness = createRpcHarness()
    await saveTencent(harness, 'buddy', 'alice@example.test')
    await saveQoder(harness, 'qoder', 'qoder@example.test')

    const buddy = await call(harness, 'accounts.list', { channel: 'buddy' })
    expect(buddy.ok).toBe(true)
    if (buddy.ok) {
      const summaries = buddy.value as AccountSummary[]
      expect(summaries).toHaveLength(1)
      const summary = expectSummaryShape(summaries[0])
      expect(summary.channelId).toBe('buddy')
      expect(summary.endpointLabel).toBe('copilot.tencent.com')
      expect(JSON.stringify(buddy)).not.toContain('vendorAccountId')
      expect(JSON.stringify(buddy)).not.toContain('accessToken')
      expect(JSON.stringify(buddy)).not.toContain('securityOauthToken')
    }

    const qoder = await call(harness, 'accounts.list', { channel: 'qoder' })
    expect(qoder.ok).toBe(true)
    if (qoder.ok) expect((qoder.value as AccountSummary[])[0]!.endpointLabel).toBe('center.qoder.sh')
  })

  it('跨渠道与同协议族 list 互不可见', async () => {
    const harness = createRpcHarness()
    await saveTencent(harness, 'buddy', 'buddy@example.test')
    await saveQoder(harness, 'qoder', 'qoder@example.test')

    for (const channel of ['workbuddy', 'qodercn'] as ChannelId[]) {
      const result = await call(harness, 'accounts.list', { channel })
      expect(result).toEqual({ ok: true, value: [] })
    }
  })
})

describe('当前账号与删除 RPC', () => {
  it('setCurrent/current/delete 的完整生命周期：首账号可当前、删除当前不递补', async () => {
    const harness = createRpcHarness()
    const first = await saveTencent(harness, 'buddy', 'first@example.test')
    const second = await saveTencent(harness, 'buddy', 'second@example.test')

    const set = await call(harness, 'accounts.setCurrent', {
      channel: 'buddy',
      accountId: first.accountId,
    })
    expect(set.ok).toBe(true)
    if (set.ok) expect(expectSummaryShape(set.value).id).toBe(first.accountId)

    const current = await call(harness, 'accounts.current', { channel: 'buddy' })
    expect(current.ok).toBe(true)
    if (current.ok) expect(expectSummaryShape(current.value).id).toBe(first.accountId)

    const deleted = await call(harness, 'accounts.delete', {
      channel: 'buddy',
      accountId: first.accountId,
    })
    expect(deleted.ok).toBe(true)
    if (deleted.ok) {
      const collection = deleted.value as { accounts: AccountSummary[]; current: AccountSummary | null }
      expect(collection.current).toBeNull()
      expect(collection.accounts.map(summary => summary.id)).toEqual([second.accountId])
      collection.accounts.forEach(expectSummaryShape)
      expectNoSecrets(collection)
    }
    expect(harness.settingsDouble.getState().buddy.currentAccountId).toBeNull()
  })

  it('显式同渠道 replacement 才替换当前账号', async () => {
    const harness = createRpcHarness()
    const first = await saveTencent(harness, 'buddy', 'first@example.test')
    const second = await saveTencent(harness, 'buddy', 'second@example.test')
    await call(harness, 'accounts.setCurrent', { channel: 'buddy', accountId: first.accountId })

    const deleted = await call(harness, 'accounts.delete', {
      channel: 'buddy',
      accountId: first.accountId,
      replacementAccountId: second.accountId,
    })
    expect(deleted.ok).toBe(true)
    if (deleted.ok) {
      const collection = deleted.value as { current: AccountSummary | null }
      expect(collection.current?.id).toBe(second.accountId)
    }
    expect(harness.settingsDouble.getState().buddy.currentAccountId).toBe(second.accountId)
  })

  it('跨渠道 replacement 返回 accounts/not-found，且不删除/不改当前', async () => {
    const harness = createRpcHarness()
    const buddy = await saveTencent(harness, 'buddy', 'buddy@example.test')
    const workbuddy = await saveTencent(harness, 'workbuddy', 'workbuddy@example.test')
    await call(harness, 'accounts.setCurrent', { channel: 'buddy', accountId: buddy.accountId })

    const result = await call(harness, 'accounts.delete', {
      channel: 'buddy',
      accountId: buddy.accountId,
      replacementAccountId: workbuddy.accountId,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('accounts/not-found')
      expect(typeof result.error.details).toBe('object')
      expectNoSecrets(result)
    }
    expect((await harness.service.list('buddy')).map(summary => summary.id)).toEqual([buddy.accountId])
    expect(harness.settingsDouble.getState().buddy.currentAccountId).toBe(buddy.accountId)
  })

  it('current 对无账号渠道返回 null', async () => {
    const harness = createRpcHarness()
    const result = await call(harness, 'accounts.current', { channel: 'qodercn' })
    expect(result).toEqual({ ok: true, value: null })
  })
})

describe('clearAll RPC', () => {
  it('显式 clearAll 清空本插件账号与当前账号，返回数量', async () => {
    const harness = createRpcHarness()
    const buddy = await saveTencent(harness, 'buddy', 'buddy@example.test')
    await saveQoder(harness, 'qoder', 'qoder@example.test')
    await call(harness, 'accounts.setCurrent', { channel: 'buddy', accountId: buddy.accountId })
    harness.credentials.seed('other-plugin/buddy-a0123456789ab', {
      kind: 'grant',
      payload: { anything: true },
    })

    const result = await call(harness, 'accounts.clearAll', {})
    expect(result).toEqual({ ok: true, value: { cleared: 2 } })
    expect(await harness.service.list('buddy')).toEqual([])
    expect(await harness.service.list('qoder')).toEqual([])
    expect(harness.settingsDouble.getState().buddy.currentAccountId).toBeNull()
    expect(harness.credentials.keys()).toEqual(['other-plugin/buddy-a0123456789ab'])
  })

  it('clearAll 不接受任何字段，未装配账号服务时不可用', async () => {
    const harness = createRpcHarness()
    const invalid = await call(harness, 'accounts.clearAll', { channel: 'buddy' })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('accounts/invalid')

    const unwired = createRpcHarness({ withAccounts: false })
    const result = await call(unwired, 'accounts.clearAll', {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('bad-request')
      expect(result.error.message).toMatch(/unknown method/i)
    }
  })
})

describe('账号 RPC 严格校验与脱敏', () => {
  it.each([
    ['accounts.list', { channel: 'deepseek' }],
    ['accounts.list', { channel: 'buddy', extra: true }],
    ['accounts.current', {}],
    ['accounts.setCurrent', { channel: 'buddy' }],
    ['accounts.setCurrent', { channel: 'buddy', accountId: 'Account_1' }],
    ['accounts.setCurrent', { channel: 'buddy', accountId: null, extra: true }],
    ['accounts.delete', { channel: 'buddy', accountId: 'account-1', extra: true }],
    ['accounts.delete', { channel: 'buddy', accountId: 'account-1', replacementAccountId: 'Bad_ID' }],
  ])('%s 拒绝非法 payload %j，返回 accounts/invalid 且不回显输入', async (method, payload) => {
    const harness = createRpcHarness()
    const result = await call(harness, method, payload)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('accounts/invalid')
      expect(typeof result.error.details).toBe('object')
      expectNoSecrets(result)
      expect(result.error.message).not.toContain('deepseek')
      expect(result.error.message).not.toContain('Account_1')
    }
  })

  it('未知账号方法返回 bad-request，不执行任何写操作', async () => {
    const harness = createRpcHarness()
    const result = await call(harness, 'accounts.save', { channel: 'buddy' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('bad-request')
    expect(harness.settingsDouble.edits).toHaveLength(0)
  })

  it('跨渠道 setCurrent/delete 返回 accounts/not-found，且不写普通配置', async () => {
    const harness = createRpcHarness()
    const buddy = await saveTencent(harness, 'buddy', 'buddy@example.test')

    for (const [method, payload] of [
      ['accounts.setCurrent', { channel: 'workbuddy', accountId: buddy.accountId }],
      ['accounts.delete', { channel: 'workbuddy', accountId: buddy.accountId }],
    ] as const) {
      const result = await call(harness, method, payload)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('accounts/not-found')
    }
    expect(harness.settingsDouble.edits).toHaveLength(0)
    expect((await harness.service.list('buddy')).map(summary => summary.id)).toEqual([buddy.accountId])
  })

  it('settings.* 仍可用，账号 RPC 不会改变普通设置快照', async () => {
    const harness = createRpcHarness()
    await saveTencent(harness, 'buddy', 'buddy@example.test')

    const settings = await call(harness, 'settings.get', {})
    expect(settings.ok).toBe(true)
    if (settings.ok) {
      expect(Object.keys(settings.value as object).sort()).toEqual([
        'buddy', 'qoder', 'qodercn', 'search', 'workbuddy',
      ])
    }
  })

  it('错误结果不泄露依赖异常原文或 cause', async () => {
    const harness = createRpcHarness()
    const buddy = await saveTencent(harness, 'buddy', 'buddy@example.test')
    await call(harness, 'accounts.setCurrent', { channel: 'buddy', accountId: buddy.accountId })
    harness.settingsDouble.failNextWrite(`profile locked ${TOKEN_SENTINEL}`)

    const result = await call(harness, 'accounts.setCurrent', {
      channel: 'buddy',
      accountId: buddy.accountId,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('accounts/storage-failed')
      expect(result.error.message).not.toContain(TOKEN_SENTINEL)
      expect(typeof result.error.details).toBe('object')
    }
    expectNoSecrets(result)
  })
})
