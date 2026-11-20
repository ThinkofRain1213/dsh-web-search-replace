/** R39：dispose 必须在第一个 await 前 abort operation 内嵌 refresh。 */
import { describe, expect, it } from 'vitest'

import { BuddyAuthFlow } from '../../src/host/channels/buddy/auth.ts'
import { QoderInternationalAuthFlow } from '../../src/host/channels/qoder/auth.ts'
import { ChannelSearchError } from '../../src/host/search/errors.ts'
import { createAccountFixture } from './support/account-fixture.ts'

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function bounded(disposing: Promise<void>, release: () => void): Promise<void> {
  try {
    const outcome = await Promise.race([
      disposing.then(() => 'disposed'),
      new Promise<string>((resolve) => { setTimeout(() => resolve('nested-refresh-not-aborted'), 50) }),
    ])
    expect(outcome).toBe('disposed')
  } finally {
    release()
    await disposing
  }
}

describe('共享 auth dispose 顺序', () => {
  it('Tencent：operation 内嵌 refresh 时 dispose 先 abort refresh，再有界 settle', async () => {
    const fixture = createAccountFixture()
    const account = await fixture.store.saveAccount({
      channel: 'buddy', vendorAccountId: 'nested', secret: { accessToken: 'A', refreshToken: 'R' },
    })
    let release!: () => void
    const gate = new Promise<Response>((resolve) => { release = () => resolve(json({ code: 0, data: {
      accessToken: 'A2', refreshToken: 'R2', expiresIn: 3600, tokenType: 'Bearer', domain: 'copilot.tencent.com',
    } })) })
    let refreshEntered!: () => void
    const entered = new Promise<void>((resolve) => { refreshEntered = resolve })
    const flow = new BuddyAuthFlow({
      store: fixture.store,
      accounts: fixture.service,
      fetcher: async (_input, init) => {
        refreshEntered()
        if (init?.signal?.aborted) throw init.signal.reason
        init?.signal?.addEventListener('abort', () => {
          release()
        }, { once: true })
        return await gate
      },
      verifyCapability: async () => {},
    })
    const running = flow.runWithAuthRetry(account.accountId, async () => {
      throw new ChannelSearchError('UNAUTHORIZED', 'buddy', '401', undefined, 401)
    }).catch((error: unknown) => error)
    await entered
    await bounded(flow.dispose(), release)
    expect(await running).toMatchObject({ code: 'auth/disposed' })
  })

  it('Qoder：operation 内嵌 refresh 时 dispose 先 abort refresh，再有界 settle', async () => {
    const fixture = createAccountFixture()
    const account = await fixture.store.saveAccount({
      channel: 'qoder', vendorAccountId: 'nested',
      secret: { securityOauthToken: 'A', machineId: 'M', refreshToken: 'R' },
    })
    let release!: () => void
    const gate = new Promise<Response>((resolve) => { release = () => resolve(json({
      device_token: 'A2', refresh_token: 'R2',
    })) })
    let refreshEntered!: () => void
    const entered = new Promise<void>((resolve) => { refreshEntered = resolve })
    const flow = new QoderInternationalAuthFlow({
      store: fixture.store,
      accounts: fixture.service,
      fetcher: async (_input, init) => {
        refreshEntered()
        if (init?.signal?.aborted) throw init.signal.reason
        init?.signal?.addEventListener('abort', () => { release() }, { once: true })
        return await gate
      },
      verifyCapability: async () => {},
    })
    const running = flow.runWithAuthRetry(account.accountId, async () => {
      throw new ChannelSearchError('UNAUTHORIZED', 'qoder', '401', undefined, 401)
    }).catch((error: unknown) => error)
    await entered
    await bounded(flow.dispose(), release)
    expect(await running).toMatchObject({ code: 'auth/disposed' })
  })
})
