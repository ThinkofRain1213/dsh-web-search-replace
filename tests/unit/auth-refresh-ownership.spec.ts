/** R45：共享 refresh 所有权与 owner-only hung-read 的确定性交错。 */
import { describe, expect, it } from 'vitest'

import { BuddyAuthFlow } from '../../src/host/channels/buddy/auth.ts'
import { QoderInternationalAuthFlow } from '../../src/host/channels/qoder/auth.ts'
import { accountRecordKey } from '../../src/host/accounts/store.ts'
import { createAccountFixture, type AccountFixture } from './support/account-fixture.ts'

type Kind = 'buddy' | 'qoder'

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

async function seed(kind: Kind) {
  const fixture = createAccountFixture()
  const account = await fixture.store.saveAccount(kind === 'buddy' ? {
    channel: 'buddy', vendorAccountId: 'ownership', secret: { accessToken: 'A1', refreshToken: 'R1' },
  } : {
    channel: 'qoder', vendorAccountId: 'ownership',
    secret: { securityOauthToken: 'A1', machineId: 'M', refreshToken: 'R1' },
  })
  const flow = kind === 'buddy'
    ? new BuddyAuthFlow({
      store: fixture.store, accounts: fixture.service, verifyCapability: async () => {},
      fetcher: async () => json({ code: 0, data: {
        accessToken: 'A2', refreshToken: 'R2', expiresIn: 3600, tokenType: 'Bearer', domain: 'copilot.tencent.com',
      } }),
    })
    : new QoderInternationalAuthFlow({
      store: fixture.store, accounts: fixture.service, verifyCapability: async () => {},
      fetcher: async () => json({ device_token: 'A2', refresh_token: 'R2' }),
    })
  return { fixture, account, flow }
}

describe.each([{ kind: 'buddy' as const }, { kind: 'qoder' as const }])('R45 $kind 共享 refresh', ({ kind }) => {
  it('caller abort 不拥有共享 run；第二 caller 不重叠，dispose 等 post-callback commit settle', async () => {
    const { fixture, account, flow } = await seed(kind)
    let networkCalls = 0
    const originalFetch = (flow as any).client.fetcher
    ;(flow as any).client.fetcher = async (...args: unknown[]) => {
      networkCalls += 1
      return await originalFetch(...args)
    }

    const afterCallback = deferred<void>()
    const commitGate = deferred<void>()
    const originalModify = fixture.credentials.modifyRecord.bind(fixture.credentials)
    fixture.credentials.modifyRecord = async (key, mutate) => {
      const current = await fixture.credentials.readRecord(key)
      const next = await mutate(current)
      afterCallback.resolve()
      await commitGate.promise
      return await originalModify(key, async () => next)
    }

    const firstAbort = new AbortController()
    const first = flow.refresh(account.accountId, firstAbort.signal).catch((error: unknown) => error)
    await afterCallback.promise
    firstAbort.abort()
    expect(await first).toMatchObject({ code: 'auth/cancelled' })

    const second = flow.refresh(account.accountId).catch((error: unknown) => error)
    let disposing: Promise<void> | undefined
    try {
      await flush()
      expect(networkCalls).toBe(1)
      let disposed = false
      disposing = flow.dispose().then(() => { disposed = true })
      await flush()
      expect(disposed).toBe(false)
    } finally {
      commitGate.resolve()
      disposing ??= flow.dispose()
      await disposing
      await second
    }
    expect(networkCalls).toBe(1)
    const raw = fixture.credentials.raw(accountRecordKey(kind, account.accountId)) as any
    expect(raw.payload.secret).toMatchObject(kind === 'buddy'
      ? { accessToken: 'A2', refreshToken: 'R2' }
      : { securityOauthToken: 'A2', refreshToken: 'R2' })
  })
})

describe.each([
  { kind: 'buddy' as const, mode: 'retry' as const },
  { kind: 'buddy' as const, mode: 'refresh' as const },
  { kind: 'qoder' as const, mode: 'retry' as const },
  { kind: 'qoder' as const, mode: 'refresh' as const },
])('owner-only hung read：$kind/$mode', ({ kind, mode }) => {
  it('dispose 使用真实合成 signal 有界停止等待且不启动后续写', async () => {
    const { fixture, account, flow } = await seed(kind)
    const entered = deferred<void>()
    const gate = deferred<void>()
    const originalRead = fixture.store.readEntry.bind(fixture.store)
    let blocked = true
    fixture.store.readEntry = async (channel, accountId) => {
      if (blocked) {
        blocked = false
        entered.resolve()
        await gate.promise
      }
      return await originalRead(channel, accountId)
    }
    const writesBefore = fixture.credentials.writes.length
    let operations = 0
    const running = (mode === 'retry'
      ? flow.runWithAuthRetry(account.accountId, async () => { operations += 1 })
      : flow.refresh(account.accountId)
    ).catch((error: unknown) => error)
    await entered.promise
    const disposing = flow.dispose()
    try {
      const outcome = await Promise.race([
        disposing.then(() => 'disposed'),
        new Promise<string>((resolve) => { setTimeout(() => resolve('owner-hung-read'), 50) }),
      ])
      expect(outcome).toBe('disposed')
      expect(operations).toBe(0)
    } finally {
      gate.resolve()
      await running
      await disposing
    }
    expect(fixture.credentials.writes).toHaveLength(writesBefore)
  })
})
