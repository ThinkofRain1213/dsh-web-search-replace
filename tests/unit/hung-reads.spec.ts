/** I4：账号/授权/route 只读等待必须可由 owner/flow/caller 中止。 */
import { describe, expect, it } from 'vitest'

import { BuddyAuthFlow } from '../../src/host/channels/buddy/auth.ts'
import { QoderInternationalAuthFlow } from '../../src/host/channels/qoder/auth.ts'
import { QoderEndpointPolicy } from '../../src/host/channels/qoder/endpoint-policy.ts'
import { QoderRouteStore, QODER_LAST_SUCCESSFUL_HOST_KEY } from '../../src/host/channels/qoder/route-store.ts'
import { createAccountFixture, type AccountFixture } from './support/account-fixture.ts'
import { MemoryCredentials } from './support/memory-credentials.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function race50<T>(operation: Promise<T>): Promise<T | 'hung'> {
  return await Promise.race([
    operation,
    new Promise<'hung'>((resolve) => { setTimeout(() => resolve('hung'), 50) }),
  ])
}

describe('I4 credentials 只读挂起边界', () => {
  it('saveAccount 的 findByVendorAccountId/listRecords 预读可由 signal 放弃且不进入写事务', async () => {
    const fixture = createAccountFixture()
    const gate = deferred<readonly any[]>()
    fixture.credentials.listRecords = async () => await gate.promise
    const caller = new AbortController()
    const saving = fixture.store.saveAccount({
      channel: 'buddy', vendorAccountId: 'hung-save', secret: { accessToken: 'A' }, signal: caller.signal,
    }).catch((error: unknown) => error)
    const outcome = await (async () => {
      caller.abort()
      return await race50(saving)
    })()
    gate.resolve([])
    await saving
    expect(outcome).toMatchObject({ code: 'accounts/cancelled' })
    expect(fixture.credentials.writes).toHaveLength(0)
  })

  it('QoderRouteStore.read 的 readRecord 挂起可由 signal 放弃', async () => {
    const credentials = new MemoryCredentials()
    const gate = deferred<any>()
    credentials.readRecord = async () => await gate.promise
    const store = new QoderRouteStore({
      credentials,
      readSelection: () => ({ channel: 'qoder', accountId: null, endpointPreference: 'auto', selectionGeneration: 1 }),
    })
    const caller = new AbortController()
    const reading = store.read(caller.signal).catch((error: unknown) => error)
    caller.abort()
    const outcome = await race50(reading)
    gate.resolve(undefined)
    await reading
    expect(outcome).not.toBe('hung')
    expect(credentials.raw(QODER_LAST_SUCCESSFUL_HOST_KEY)).toBeUndefined()
  })

  it('auto route read 挂起时 caller abort 不进入 operation', async () => {
    const gate = deferred<null>()
    const policy = new QoderEndpointPolicy({ readLastSuccessfulHost: async () => await gate.promise })
    const caller = new AbortController()
    let operations = 0
    const running = policy.execute({
      preference: 'auto', accountKey: 'account-a', signal: caller.signal,
      operation: async () => { operations += 1; return 'unexpected' },
    }).catch((error: unknown) => error)
    caller.abort(new DOMException('stop', 'AbortError'))
    const outcome = await race50(running)
    gate.resolve(null)
    await running
    expect(outcome).not.toBe('hung')
    expect(operations).toBe(0)
  })
})

function makeFlow(kind: 'buddy' | 'qoder', fixture: AccountFixture, onListEntered: () => void) {
  const gate = deferred<readonly any[]>()
  fixture.store.listEntries = async () => {
    onListEntered()
    return await gate.promise
  }
  const options = {
    store: fixture.store,
    accounts: fixture.service,
    verifyCapability: async () => {},
    pollIntervalMs: 1,
    fetcher: (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (kind === 'buddy') {
        if (url.includes('/auth/state')) {
          return json({ code: 0, data: { state: 's', authUrl: 'https://www.codebuddy.cn/login/?state=s' } })
        }
        if (url.includes('/login/account')) {
          return json({ code: 0, data: { uid: 'u', nickname: 'U', enterpriseId: '', type: 'personal' } })
        }
        return json({ code: 0, data: { accessToken: 'A', refreshToken: 'R', expiresIn: 3600, tokenType: 'Bearer', domain: 'copilot.tencent.com' } })
      }
      return json({ token: 'A', refresh_token: 'R', user_id: 'u', user_name: 'U' })
    }) as typeof fetch,
  }
  const flow = kind === 'buddy' ? new BuddyAuthFlow(options) : new QoderInternationalAuthFlow(options)
  return { flow, gate }
}

describe.each(['buddy', 'qoder'] as const)('I4 $kind 登录 hasUsableAccounts 预读', (kind) => {
  it('cancel 有界 settle，不继续 saveAccount/setCurrent', async () => {
    const fixture = createAccountFixture()
    const entered = deferred<void>()
    const { flow, gate } = makeFlow(kind, fixture, () => entered.resolve())
    const started = await flow.start()
    await entered.promise
    const cancelling = flow.cancel(started.flowId)
    const outcome = await race50(cancelling)
    gate.resolve([])
    await cancelling
    expect(outcome).not.toBe('hung')
    expect((await flow.status(started.flowId)).status).toBe('cancelled')
    expect(fixture.settings.getSnapshot()[kind].currentAccountId).toBeNull()
    expect(fixture.credentials.writes).toHaveLength(0)
    await flow.dispose()
  })
})
