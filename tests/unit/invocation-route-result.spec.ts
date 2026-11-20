/** I1：真实 invocation adapter 必须透传 stale，activation 内存路由同样受代际门禁。 */
import { describe, expect, it } from 'vitest'

import { createInvocationDriverFactory, type InvocationSelection } from '../../src/host/accounts/invocation.ts'
import { BuddyAuthFlow } from '../../src/host/channels/buddy/auth.ts'
import { WorkbuddyAuthFlow } from '../../src/host/channels/workbuddy/auth.ts'
import { QoderInternationalAuthFlow } from '../../src/host/channels/qoder/auth.ts'
import { QoderCnAuthFlow } from '../../src/host/channels/qodercn/auth.ts'
import { QoderRouteStore, QODER_LAST_SUCCESSFUL_HOST_KEY } from '../../src/host/channels/qoder/route-store.ts'
import { createAccountFixture } from './support/account-fixture.ts'

const CENTER = 'center.qoder.sh'
const API2 = 'api2.qoder.sh'

function selection(accountId: string, generation: number): InvocationSelection {
  return { channel: 'qoder', accountId, endpointPreference: 'auto', selectionGeneration: generation }
}

function createFlows(fixture: ReturnType<typeof createAccountFixture>) {
  const options = {
    store: fixture.store,
    accounts: fixture.service,
    fetcher: async () => { throw new Error('unexpected auth network') },
    verifyCapability: async () => {},
  }
  return {
    buddy: new BuddyAuthFlow(options),
    workbuddy: new WorkbuddyAuthFlow(options),
    qoder: new QoderInternationalAuthFlow(options),
    qodercn: new QoderCnAuthFlow(options),
  }
}

async function createHarness() {
  const fixture = createAccountFixture()
  const account = await fixture.store.saveAccount({
    channel: 'qoder', vendorAccountId: 'adapter-account',
    secret: { securityOauthToken: 'Q', machineId: 'M', refreshToken: 'R' },
  })
  let current = selection(account.accountId, 1)
  const routeStore = new QoderRouteStore({ credentials: fixture.credentials, readSelection: () => current })
  let activeHosts: string[] = []
  let failCenter = true
  const factory = createInvocationDriverFactory({
    flows: createFlows(fixture),
    fetcher: async (input) => {
      const host = new URL(String(input)).hostname
      activeHosts.push(host)
      if (failCenter && host === CENTER) throw new TypeError('fetch failed')
      return new Response(JSON.stringify({ pageItems: [{ link: 'https://result.test/' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
    readLastSuccessfulHost: () => routeStore.read(),
    writeLastSuccessfulHost: async (host, signal, context) => await routeStore.write(host, context!, signal),
  })
  return {
    fixture,
    account,
    factory,
    routeStore,
    setCurrent: (next: InvocationSelection) => { current = next },
    setHosts: (next: string[], fail = true) => { activeHosts = next; failCenter = fail },
  }
}

describe('invocation adapter stale/written 透传', () => {
  it('stale 不写持久记录也不污染 activation 内存路由；A→B→A 后仍从 center 开始', async () => {
    const { fixture, account, factory, setCurrent, setHosts } = await createHarness()
    const firstHosts: string[] = []
    setHosts(firstHosts)
    const first = factory.bind(selection(account.accountId, 1))
    const firstSearch = first.searchOnce('stale query', 10, new AbortController().signal)
    setCurrent(selection('account-b', 2))
    setCurrent(selection(account.accountId, 3))
    await firstSearch
    expect(firstHosts).toEqual([CENTER, API2])
    expect(fixture.credentials.raw(QODER_LAST_SUCCESSFUL_HOST_KEY)).toBeUndefined()

    const secondHosts: string[] = []
    setHosts(secondHosts, false)
    await factory.bind(selection(account.accountId, 3)).searchOnce('next auto', 10, new AbortController().signal)
    expect(secondHosts).toEqual([CENTER])
  })

  it('written 仍同时更新持久记录与 activation 内存路由', async () => {
    const { fixture, account, factory, setHosts } = await createHarness()
    const firstHosts: string[] = []
    setHosts(firstHosts)
    await factory.bind(selection(account.accountId, 1)).searchOnce('written query', 10, new AbortController().signal)
    expect(firstHosts).toEqual([CENTER, API2])
    expect(fixture.credentials.raw(QODER_LAST_SUCCESSFUL_HOST_KEY)).toEqual({
      kind: 'grant', payload: { host: API2 },
    })
    const secondHosts: string[] = []
    setHosts(secondHosts)
    await factory.bind(selection(account.accountId, 1)).searchOnce('written next', 10, new AbortController().signal)
    expect(secondHosts).toEqual([API2])
  })
})
