/** I1/I2：四渠道临期刷新与单次 invocation grant 快照。 */
import { describe, expect, it } from 'vitest'

import { BuddyAuthFlow } from '../../src/host/channels/buddy/auth.ts'
import { WorkbuddyAuthFlow } from '../../src/host/channels/workbuddy/auth.ts'
import { QoderInternationalAuthFlow } from '../../src/host/channels/qoder/auth.ts'
import { QoderCnAuthFlow } from '../../src/host/channels/qodercn/auth.ts'
import { ChannelSearchError } from '../../src/host/search/errors.ts'
import type { ChannelId } from '../../src/shared/channels.ts'
import { createAccountFixture, type AccountFixture } from './support/account-fixture.ts'

const NOW = Date.parse('2026-11-20T00:00:00.000Z')
const kinds = ['buddy', 'workbuddy', 'qoder', 'qodercn'] as const
type Kind = typeof kinds[number]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function secretFor(kind: Kind, token: string, expiresAtMs?: number): Record<string, unknown> {
  const base = kind === 'buddy' || kind === 'workbuddy'
    ? { accessToken: token, refreshToken: `R_${token}` }
    : { securityOauthToken: token, machineId: `M_${token}`, refreshToken: `R_${token}` }
  return { ...base, ...expiresAtMs === undefined ? {} : { expiresAtMs } }
}

function tokenOf(kind: Kind, credential: any): string {
  return kind === 'buddy' || kind === 'workbuddy'
    ? credential.accessToken
    : credential.credential.securityOauthToken
}

async function seed(kind: Kind, secret: Record<string, unknown>) {
  const fixture = createAccountFixture()
  const account = await fixture.store.saveAccount({
    channel: kind,
    vendorAccountId: `vendor-${kind}`,
    secret,
  })
  const options = {
    store: fixture.store,
    accounts: fixture.service,
    clock: { now: () => NOW, sleep: async () => {} },
    fetcher: async () => { throw new Error('unexpected network') },
    verifyCapability: async () => {},
  }
  const flow = kind === 'buddy' ? new BuddyAuthFlow(options)
    : kind === 'workbuddy' ? new WorkbuddyAuthFlow(options)
      : kind === 'qoder' ? new QoderInternationalAuthFlow(options)
        : new QoderCnAuthFlow(options)
  return { fixture, account, flow }
}

function stubRefresh(
  fixture: AccountFixture,
  flow: any,
  kind: Kind,
  nextToken: string,
): string[] {
  const calls: string[] = []
  flow.refresh = async (accountId: string) => {
    calls.push(accountId)
    const entry = await fixture.store.readEntry(kind, accountId)
    if (entry?.account === undefined) throw new Error('missing fixture account')
    return await fixture.store.saveAccount({
      channel: kind,
      vendorAccountId: entry.account.vendorAccountId,
      secret: {
        ...entry.account.secret,
        ...secretFor(kind, nextToken, NOW + 3_600_000),
      },
    })
  }
  return calls
}

async function run(
  kind: Kind,
  flow: any,
  accountId: string,
  invocation: unknown,
  operation: (credential: any) => Promise<void> | void,
  signal?: AbortSignal,
): Promise<void> {
  await flow.runWithAuthRetry(accountId, operation, signal, invocation)
  // 保留 kind 参数，让矩阵类型错误不会静默换渠道。
  expect(flow.channel).toBe(kind)
}

describe.each(kinds)('I1 $kind 临期自动刷新', (kind) => {
  it.each([
    { label: 'far', expiresAtMs: NOW + 120_000 },
    { label: 'missing-expiry', expiresAtMs: undefined },
  ])('$label 不刷新，直接使用启动 grant', async ({ expiresAtMs }) => {
    const { fixture, account, flow } = await seed(kind, secretFor(kind, 'OLD', expiresAtMs))
    const refreshes = stubRefresh(fixture, flow, kind, 'NEW')
    const invocation = (flow as any).createInvocation(account.accountId)
    const tokens: string[] = []
    await run(kind, flow, account.accountId, invocation, credential => {
      tokens.push(tokenOf(kind, credential))
    })
    expect(tokens).toEqual(['OLD'])
    expect(refreshes).toEqual([])
  })

  it.each([
    { label: 'near', expiresAtMs: NOW + 30_000 },
    { label: 'expired', expiresAtMs: NOW - 1 },
  ])('$label 在首次 operation 前刷新并换用新 grant', async ({ expiresAtMs }) => {
    const { fixture, account, flow } = await seed(kind, secretFor(kind, 'OLD', expiresAtMs))
    const refreshes = stubRefresh(fixture, flow, kind, 'NEW')
    const invocation = (flow as any).createInvocation(account.accountId)
    const tokens: string[] = []
    await run(kind, flow, account.accountId, invocation, credential => {
      tokens.push(tokenOf(kind, credential))
    })
    expect(tokens).toEqual(['NEW'])
    expect(refreshes).toEqual([account.accountId])
  })

  it('同一 invocation 并发首次 operation 只做一次临期初始化刷新', async () => {
    const { fixture, account, flow } = await seed(kind, secretFor(kind, 'OLD', NOW + 30_000))
    const gate = deferred<void>()
    const originalRefresh = (flow as any).refresh
    const calls: string[] = []
    ;(flow as any).refresh = async (accountId: string) => {
      calls.push(accountId)
      await gate.promise
      const entry = await fixture.store.readEntry(kind, accountId)
      return await fixture.store.saveAccount({
        channel: kind,
        vendorAccountId: entry!.account!.vendorAccountId,
        secret: { ...entry!.account!.secret, ...secretFor(kind, 'NEW', NOW + 3_600_000) },
      })
    }
    expect(originalRefresh).toBeTypeOf('function')
    const invocation = (flow as any).createInvocation(account.accountId)
    const tokens: string[] = []
    const first = run(kind, flow, account.accountId, invocation, credential => {
      tokens.push(tokenOf(kind, credential))
    })
    const second = run(kind, flow, account.accountId, invocation, credential => {
      tokens.push(tokenOf(kind, credential))
    })
    await Promise.resolve()
    gate.resolve()
    await Promise.all([first, second])
    expect(calls).toEqual([account.accountId])
    expect(tokens).toEqual(['NEW', 'NEW'])
  })

  it('refresh grant 已过期时进入 reauth_required，不发 operation/刷新请求', async () => {
    const secret = { ...secretFor(kind, 'OLD', NOW + 30_000), refreshExpiresAtMs: NOW - 1 }
    const { fixture, account, flow } = await seed(kind, secret)
    const refreshes = stubRefresh(fixture, flow, kind, 'NEW')
    const invocation = (flow as any).createInvocation(account.accountId)
    let operations = 0
    const error = await run(kind, flow, account.accountId, invocation, () => {
      operations += 1
    }).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ code: 'auth/reauth-required' })
    expect(operations).toBe(0)
    expect(refreshes).toEqual([])
    expect((await fixture.store.readEntry(kind, account.accountId))?.status).toBe('reauth_required')
  })

  it('不同 invocation 的并发临期初始化仍按账号单飞', async () => {
    const { fixture, account, flow } = await seed(kind, secretFor(kind, 'OLD', NOW + 30_000))
    const gate = deferred<void>()
    const entered = deferred<void>()
    let networkCalls = 0
    ;(flow as any).client.refresh = async () => {
      networkCalls += 1
      entered.resolve()
      await gate.promise
      return kind === 'buddy' || kind === 'workbuddy'
        ? { accessToken: 'NEW', refreshToken: 'R_NEW', expiresAtMs: NOW + 3_600_000, tokenType: 'Bearer', scope: '', domain: 'fixed.test' }
        : { accessToken: 'NEW', refreshToken: 'R_NEW', expiresAt: NOW + 3_600_000 }
    }
    const firstInvocation = (flow as any).createInvocation(account.accountId)
    const secondInvocation = (flow as any).createInvocation(account.accountId)
    const tokens: string[] = []
    const first = run(kind, flow, account.accountId, firstInvocation, credential => {
      tokens.push(tokenOf(kind, credential))
    })
    const second = run(kind, flow, account.accountId, secondInvocation, credential => {
      tokens.push(tokenOf(kind, credential))
    })
    await entered.promise
    gate.resolve()
    await Promise.all([first, second])
    expect(networkCalls).toBe(1)
    expect(tokens).toEqual(['NEW', 'NEW'])
    expect((await fixture.store.readEntry(kind, account.accountId))?.account?.secret)
      .toMatchObject(kind === 'buddy' || kind === 'workbuddy'
        ? { accessToken: 'NEW', refreshToken: 'R_NEW' }
        : { securityOauthToken: 'NEW', refreshToken: 'R_NEW' })
  })

  it('临期刷新迟到时 CAS 不覆盖更新后的同账号 grant', async () => {
    const { fixture, account, flow } = await seed(kind, secretFor(kind, 'OLD', NOW + 30_000))
    const gate = deferred<void>()
    const entered = deferred<void>()
    ;(flow as any).client.refresh = async () => {
      entered.resolve()
      await gate.promise
      return kind === 'buddy' || kind === 'workbuddy'
        ? { accessToken: 'STALE', refreshToken: 'R_STALE', expiresAtMs: NOW + 3_600_000, tokenType: 'Bearer', scope: '', domain: 'fixed.test' }
        : { accessToken: 'STALE', refreshToken: 'R_STALE', expiresAt: NOW + 3_600_000 }
    }
    const invocation = (flow as any).createInvocation(account.accountId)
    const tokens: string[] = []
    const running = run(kind, flow, account.accountId, invocation, credential => {
      tokens.push(tokenOf(kind, credential))
    })
    await entered.promise
    await fixture.store.saveAccount({
      channel: kind,
      vendorAccountId: `vendor-${kind}`,
      secret: secretFor(kind, 'CURRENT', NOW + 3_600_000),
    })
    gate.resolve()
    await running
    expect(tokens).toEqual(['CURRENT'])
    expect((await fixture.store.readEntry(kind, account.accountId))?.account?.secret)
      .toMatchObject(kind === 'buddy' || kind === 'workbuddy'
        ? { accessToken: 'CURRENT', refreshToken: 'R_CURRENT' }
        : { securityOauthToken: 'CURRENT', refreshToken: 'R_CURRENT' })
  })

  it('临期刷新 caller cancel 只取消等待，不执行 operation，owner 仍 settle', async () => {
    const { fixture, account, flow } = await seed(kind, secretFor(kind, 'OLD', NOW + 30_000))
    const gate = deferred<void>()
    const entered = deferred<void>()
    ;(flow as any).client.refresh = async () => {
      entered.resolve()
      await gate.promise
      return kind === 'buddy' || kind === 'workbuddy'
        ? { accessToken: 'NEW', refreshToken: 'R_NEW', expiresAtMs: NOW + 3_600_000, tokenType: 'Bearer', scope: '', domain: 'fixed.test' }
        : { accessToken: 'NEW', refreshToken: 'R_NEW', expiresAt: NOW + 3_600_000 }
    }
    const invocation = (flow as any).createInvocation(account.accountId)
    const abort = new AbortController()
    let operations = 0
    const running = run(kind, flow, account.accountId, invocation, () => {
      operations += 1
    }, abort.signal).catch((error: unknown) => error)
    await entered.promise
    const owner = (flow as any).inFlightRefreshes.get(account.accountId) as Promise<unknown>
    abort.abort()
    expect(await running).toMatchObject({ code: 'auth/cancelled' })
    expect(operations).toBe(0)
    gate.resolve()
    await owner
    await (flow as any).dispose()
    expect((await fixture.store.readEntry(kind, account.accountId))?.account?.secret)
      .toMatchObject(kind === 'buddy' || kind === 'workbuddy'
        ? { accessToken: 'NEW', refreshToken: 'R_NEW' }
        : { securityOauthToken: 'NEW', refreshToken: 'R_NEW' })
  })

  it('刷新缺新 access expiry 会清除 stale 旧值，后续 invocation 不重复刷新', async () => {
    const { fixture, account, flow } = await seed(kind, secretFor(kind, 'OLD', NOW + 30_000))
    let networkCalls = 0
    ;(flow as any).client.refresh = async () => {
      networkCalls += 1
      return kind === 'buddy' || kind === 'workbuddy'
        ? { accessToken: 'NEW', refreshToken: 'R_NEW', tokenType: 'Bearer', scope: '', domain: 'fixed.test' }
        : { accessToken: 'NEW', refreshToken: 'R_NEW' }
    }
    const tokens: string[] = []
    await run(kind, flow, account.accountId, (flow as any).createInvocation(account.accountId), credential => {
      tokens.push(tokenOf(kind, credential))
    })
    expect((await fixture.store.readEntry(kind, account.accountId))?.account?.secret.expiresAtMs).toBeUndefined()
    await run(kind, flow, account.accountId, (flow as any).createInvocation(account.accountId), credential => {
      tokens.push(tokenOf(kind, credential))
    })
    expect(tokens).toEqual(['NEW', 'NEW'])
    expect(networkCalls).toBe(1)
  })
})

describe.each(kinds)('I2 $kind invocation 启动 grant 快照', (kind) => {
  it('query1 在飞时删除并重建同 ID，query2 仍使用启动 grant', async () => {
    const { fixture, account, flow } = await seed(kind, secretFor(kind, 'OLD', NOW + 120_000))
    const invocation = (flow as any).createInvocation(account.accountId)
    const entered = deferred<void>()
    const release = deferred<void>()
    const first = run(kind, flow, account.accountId, invocation, async credential => {
      expect(tokenOf(kind, credential)).toBe('OLD')
      entered.resolve()
      await release.promise
    })
    await entered.promise
    expect(await fixture.store.deleteAccount(kind, account.accountId)).toBe(true)
    const recreated = await fixture.store.saveAccount({
      channel: kind,
      vendorAccountId: `vendor-${kind}`,
      secret: secretFor(kind, 'NEW', NOW + 120_000),
    })
    expect(recreated.accountId).toBe(account.accountId)
    const tokens: string[] = []
    await run(kind, flow, account.accountId, invocation, credential => {
      tokens.push(tokenOf(kind, credential))
    })
    release.resolve()
    await first
    expect(tokens).toEqual(['OLD'])
  })

  it('本 invocation 的明确 401 刷新后，后续 operation 使用新 grant', async () => {
    const { fixture, account, flow } = await seed(kind, secretFor(kind, 'OLD', NOW + 120_000))
    const refreshes = stubRefresh(fixture, flow, kind, 'NEW')
    const invocation = (flow as any).createInvocation(account.accountId)
    let attempts = 0
    const tokens: string[] = []
    await run(kind, flow, account.accountId, invocation, credential => {
      tokens.push(tokenOf(kind, credential))
      if (++attempts === 1) {
        throw new ChannelSearchError('UNAUTHORIZED', kind, 'fixed 401', undefined, 401)
      }
    })
    await run(kind, flow, account.accountId, invocation, credential => {
      tokens.push(tokenOf(kind, credential))
    })
    expect(tokens).toEqual(['OLD', 'NEW', 'NEW'])
    expect(refreshes).toEqual([account.accountId])
  })
})
