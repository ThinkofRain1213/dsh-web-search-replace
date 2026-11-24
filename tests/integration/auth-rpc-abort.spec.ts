/** I3：真实 Request caller abort 贯通 Host auth.start，并清理迟到/在飞 flow。 */
import { describe, expect, it } from 'vitest'

import { BuddyAuthFlow } from '../../src/host/channels/buddy/auth.ts'
import { dispatchChannelAuthRpc } from '../../src/host/channels/auth-rpc.ts'
import { PluginLifecycle } from '../../src/host/lifecycle.ts'
import { handleManagementRpcRequest } from '../../src/host/rpc.ts'
import { AuthFlowError, type AuthFlowPort, type AuthFlowStatus } from '../../src/shared/auth.ts'
import { MANAGEMENT_RPC_ENDPOINT } from '../../src/shared/rpc.ts'
import { createAccountFixture, type AccountFixture } from '../unit/support/account-fixture.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail })
  return { promise, resolve, reject }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function authStateBody() {
  return { code: 0, data: { state: 'abort-state', authUrl: 'https://www.codebuddy.cn/login/?state=abort-state' } }
}

function request(controller: AbortController): Request {
  return new Request('https://host.test/api/web-search-replace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId: 'auth-abort', method: MANAGEMENT_RPC_ENDPOINT,
      payload: { method: 'auth.start', payload: { channel: 'buddy' } },
    }),
    signal: controller.signal,
  })
}

function makeFlow(fixture: AccountFixture, fetcher: typeof fetch): BuddyAuthFlow {
  let now = 1_000_000
  return new BuddyAuthFlow({
    store: fixture.store,
    accounts: fixture.service,
    fetcher,
    randomId: () => 'abort-flow',
    clock: { now: () => now, sleep: async (ms) => { now += Math.max(1, ms) } },
    timeoutSignal: () => new AbortController().signal,
    pollIntervalMs: 1,
    verifyCapability: async () => {},
  })
}

async function resultOf(response: Response): Promise<any> {
  const body = await response.json() as any
  return body.result
}

async function waitTerminal(flow: BuddyAuthFlow, flowId: string): Promise<AuthFlowStatus> {
  for (let index = 0; index < 100; index += 1) {
    const status = await flow.status(flowId)
    if (status.status !== 'pending') return status
    await new Promise<void>((resolve) => { setTimeout(resolve, 2) })
  }
  return await flow.status(flowId)
}

describe('I3 Host auth.start caller signal', () => {
  it('auth/state fetch 挂起时 abort 有界结束，不创建 flow/账号', async () => {
    const fixture = createAccountFixture()
    const lifecycle = new PluginLifecycle()
    const entered = deferred<void>()
    const never = new Promise<Response>(() => {})
    const flow = makeFlow(fixture, (async (_input: RequestInfo | URL) => {
      entered.resolve()
      return await never
    }) as typeof fetch)
    const caller = new AbortController()
    const running = handleManagementRpcRequest(
      fixture.settings, request(caller), fixture.service, { buddy: flow }, { lifecycle },
    )
    await entered.promise
    caller.abort(new DOMException('client gone', 'AbortError'))
    const result = await Promise.race([
      running.then(resultOf),
      new Promise<string>((resolve) => { setTimeout(() => resolve('start-hung'), 50) }),
    ])
    expect(result).toMatchObject({ ok: false, error: { code: 'auth/cancelled' } })
    expect(fixture.credentials.keys()).toHaveLength(0)
    expect(fixture.settings.getSnapshot().buddy.currentAccountId).toBeNull()
    await flow.dispose()
    await lifecycle.abortAllAndSettle()
  })

  it('auth/state 已返回、body pending 后 abort 仍拒绝迟到 start', async () => {
    const fixture = createAccountFixture()
    const lifecycle = new PluginLifecycle()
    const bodyEntered = deferred<void>()
    const bodyGate = deferred<unknown>()
    const flow = makeFlow(fixture, (async () => {
      const response = json(authStateBody())
      Object.defineProperty(response, 'json', {
        value: () => {
          bodyEntered.resolve()
          return bodyGate.promise
        },
      })
      return response
    }) as typeof fetch)
    const caller = new AbortController()
    const running = handleManagementRpcRequest(
      fixture.settings, request(caller), fixture.service, { buddy: flow }, { lifecycle },
    )
    await bodyEntered.promise
    caller.abort(new DOMException('client gone', 'AbortError'))
    bodyGate.resolve(authStateBody())
    expect(await running.then(resultOf)).toMatchObject({
      ok: false, error: { code: 'auth/cancelled' },
    })
    expect(fixture.credentials.keys()).toHaveLength(0)
    await flow.dispose()
    await lifecycle.abortAllAndSettle()
  })

  it('pending 已返回后 abort 会取消同一 flow、中止轮询且无迟到写入', async () => {
    const fixture = createAccountFixture()
    const lifecycle = new PluginLifecycle()
    const tokenEntered = deferred<void>()
    let tokenSignal: AbortSignal | undefined
    const flow = makeFlow(fixture, (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/auth/state')) return json(authStateBody())
      if (url.includes('/auth/token')) {
        tokenSignal = init?.signal ?? undefined
        tokenEntered.resolve()
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal?.aborted) { reject(signal.reason); return }
          signal?.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
        })
      }
      throw new Error('unexpected request')
    }) as typeof fetch)
    const caller = new AbortController()
    const result = await handleManagementRpcRequest(
      fixture.settings, request(caller), fixture.service, { buddy: flow }, { lifecycle },
    ).then(resultOf)
    expect(result).toMatchObject({ ok: true, value: { flowId: 'abort-flow', status: 'pending' } })
    await tokenEntered.promise
    caller.abort(new DOMException('client gone', 'AbortError'))
    const terminal = await waitTerminal(flow, 'abort-flow')
    expect(terminal.status).toBe('cancelled')
    expect(tokenSignal?.aborted).toBe(true)
    expect(fixture.credentials.keys()).toHaveLength(0)
    expect(fixture.settings.getSnapshot().buddy.currentAccountId).toBeNull()
    await flow.dispose()
    await lifecycle.abortAllAndSettle()
  })

  it('dispatcher 对 caller abort 后极晚返回的 pending 精确清理一次', async () => {
    const caller = new AbortController()
    const pending: AuthFlowStatus = {
      flowId: 'late-flow', channel: 'buddy', status: 'pending',
      authUrl: 'https://www.codebuddy.cn/login/?state=late', displayHint: '', account: null, errorCode: null,
    }
    const cancelled: AuthFlowStatus = {
      ...pending, status: 'cancelled', authUrl: null, errorCode: 'auth/cancelled',
    }
    const cancels: string[] = []
    const flow: AuthFlowPort = {
      channel: 'buddy',
      start: async () => {
        caller.abort(new DOMException('client gone', 'AbortError'))
        return pending
      },
      cancel: async (flowId) => { cancels.push(flowId); return cancelled },
      status: async () => pending,
      refresh: async () => { throw new Error('not used') },
    }
    const error = await dispatchChannelAuthRpc(
      flow, 'buddy', 'auth.start', { channel: 'buddy' },
      () => new AuthFlowError('auth/internal', 'fixed'), caller.signal,
    ).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ code: 'auth/cancelled' })
    expect(cancels).toEqual(['late-flow'])
  })
})
