/** B7：重登与删除交错时，事务内目标检查不得复活已删除账号。 */
import { describe, expect, it } from 'vitest'

import { BuddyAuthFlow } from '../../src/host/channels/buddy/auth.ts'
import { QoderInternationalAuthFlow } from '../../src/host/channels/qoder/auth.ts'
import { createAccountFixture, type AccountFixture } from './support/account-fixture.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function terminal(flow: BuddyAuthFlow | QoderInternationalAuthFlow, flowId: string) {
  for (let index = 0; index < 100; index += 1) {
    const status = await flow.status(flowId)
    if (status.status !== 'pending') return status
    await new Promise<void>((resolve) => { setTimeout(resolve, 1) })
  }
  throw new Error('reauth did not settle')
}

function makeFlow(
  kind: 'buddy' | 'qoder',
  fixture: AccountFixture,
  probe: () => Promise<void>,
) {
  const options = {
    store: fixture.store,
    accounts: fixture.service,
    verifyCapability: probe,
    pollIntervalMs: 1,
    fetcher: (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (kind === 'buddy') {
        if (url.includes('/auth/state')) {
          return json({ code: 0, data: { state: 's', authUrl: 'https://www.codebuddy.cn/login/?state=s' } })
        }
        if (url.includes('/login/account')) {
          return json({ code: 0, data: { uid: 'vendor', nickname: 'Updated', enterpriseId: '', type: 'personal' } })
        }
        return json({ code: 0, data: { accessToken: 'NEW', refreshToken: 'R_NEW', expiresIn: 3600, tokenType: 'Bearer', domain: 'copilot.tencent.com' } })
      }
      return json({ token: 'NEW', refresh_token: 'R_NEW', user_id: 'vendor', user_name: 'Updated' })
    }) as typeof fetch,
  }
  return kind === 'buddy' ? new BuddyAuthFlow(options) : new QoderInternationalAuthFlow(options)
}

describe.each(['buddy', 'qoder'] as const)('B7 $kind reauth/delete', (kind) => {
  it('能力探测后删除目标时，保存事务 fail-closed 且不重建', async () => {
    const fixture = createAccountFixture()
    const account = await fixture.store.saveAccount({
      channel: kind,
      vendorAccountId: 'vendor',
      secret: kind === 'buddy'
        ? { accessToken: 'OLD', refreshToken: 'R_OLD' }
        : { securityOauthToken: 'OLD', machineId: 'M', refreshToken: 'R_OLD' },
    })
    const entered = deferred<void>()
    const release = deferred<void>()
    const flow = makeFlow(kind, fixture, async () => {
      entered.resolve()
      await release.promise
    })
    const started = await flow.reauthenticate(account.accountId)
    await entered.promise
    expect(await fixture.store.deleteAccount(kind, account.accountId)).toBe(true)
    const writesAfterDelete = fixture.credentials.writes.length
    release.resolve()
    const status = await terminal(flow, started.flowId)
    expect(status.status).toBe('failed')
    expect(await fixture.store.readEntry(kind, account.accountId)).toBeUndefined()
    expect(fixture.credentials.writes).toHaveLength(writesAfterDelete)
    await flow.dispose()
  })
})
