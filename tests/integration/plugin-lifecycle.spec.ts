/** Task 15：真实 Host 根组合与完整生命周期。 */
import { describe, expect, it } from 'vitest'

import { apply } from '../../src/host/index.ts'
import { AccountStore } from '../../src/host/accounts/store.ts'
import { __testing as signerTesting } from '../../src/host/channels/qoder/signer.ts'
import type { ManagementRpcRoute } from '../../src/shared/rpc.ts'
import { MemoryCredentials } from '../unit/support/memory-credentials.ts'
import { createSettingsDouble, type Ref } from '../unit/support/settings-double.ts'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

let lastSetup: {
  double: ReturnType<typeof createSettingsDouble>
  routes: Map<string, ManagementRpcRoute>
  listeners: Map<string, Set<(...args: any[]) => unknown>>
} | undefined

async function createFixture(options: {
  channel?: 'buddy' | 'qoder'
  enabled?: boolean
  fetcher?: typeof fetch
  failToolsRegistration?: boolean
} = {}) {
  const channel = options.channel ?? 'buddy'
  const enabled = options.enabled ?? false
  const credentials = new MemoryCredentials()
  const store = new AccountStore({ credentials })
  const account = await store.saveAccount(channel === 'buddy' ? {
    channel: 'buddy', vendorAccountId: 'root-buddy', secret: { accessToken: 'ROOT_A', refreshToken: 'ROOT_R' },
  } : {
    channel: 'qoder', vendorAccountId: 'root-qoder',
    secret: { securityOauthToken: 'ROOT_Q', machineId: 'ROOT_M', refreshToken: 'ROOT_R' },
  })
  const double = createSettingsDouble({
    search: { enabled, channel },
    ...channel === 'buddy' ? { buddy: { currentAccountId: account.accountId } } : {},
    ...channel === 'qoder' ? { qoder: { currentAccountId: account.accountId, endpointPreference: 'auto' } } : {},
  })
  const routes = new Map<string, ManagementRpcRoute>()
  const listeners = new Map<string, Set<(...args: any[]) => unknown>>()
  const disposers: Array<() => Promise<void>> = []
  const effectPromises: Promise<void>[] = []
  lastSetup = { double, routes, listeners }
  const ctx: any = {
    credentials,
    configEditor: double.editor,
    fiber: {
      entry: {
        id: 'dsh-web-search-channels',
        options: { id: 'dsh-web-search-channels', name: 'dsh-web-search-channels', config: {} },
        fiber: {},
      },
    },
    connection: {
      fetch: {
        register(route: ManagementRpcRoute) {
          routes.set(route.path, route)
          return async () => { routes.delete(route.path) }
        },
      },
      rpc: { call: async () => { throw new Error('not used') } },
    },
    on(name: string, listener: (...args: any[]) => unknown) {
      if (name === 'tools/execute' && options.failToolsRegistration === true) {
        throw new Error('intentional tools registration failure')
      }
      const group = listeners.get(name) ?? new Set()
      group.add(listener)
      listeners.set(name, group)
      return () => { group.delete(listener) }
    },
    effect(execute: () => Promise<() => Promise<void>> | (() => Promise<void>) | void) {
      const result = execute()
      if (result instanceof Promise) {
        effectPromises.push(result.then((dispose) => { disposers.push(dispose) }))
      } else if (result !== undefined) disposers.push(result)
    },
    fetcher: options.fetcher ?? (async () => json({ results: [{ url: 'https://root.test/buddy' }] })),
  }
  apply(ctx, double.config)
  await Promise.all(effectPromises)
  const executeTool = async (args: unknown, signal = new AbortController().signal) => {
    const listener = [...(listeners.get('tools/execute') ?? [])][0]
    expect(listener).toBeDefined()
    let nextCalls = 0
    const result = await listener!({
      name: 'web_search', arguments: args, signal,
    }, async () => {
      nextCalls += 1
      return { value: { official: true, sources: [], truncated: false } }
    }) as any
    return { result, nextCalls }
  }
  const volatile = () => {
    for (const listener of listeners.get('loader/volatile-update') ?? []) listener()
  }
  const dispose = async () => {
    for (const dispose of disposers.splice(0).reverse()) await dispose()
  }
  const runtimeGet = async () => {
    const route = routes.get('/api/web-search-channels')
    expect(route).toBeDefined()
    const response = await route!.fetch(new Request('http://local/api/web-search-channels', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'runtime', method: 'web-search-channels',
        payload: { method: 'runtime.get', payload: {} },
      }),
    }))
    return await response.json() as any
  }
  return { ctx, double, credentials, account, executeTool, volatile, dispose, runtimeGet, listeners, routes }
}

describe('真实 Host 根组合', () => {
  it('OFF 在账号/WASM/厂商工作前 next；volatile ON 后真实 buddy driver 接管', async () => {
    let fetchCalls = 0
    const fixture = await createFixture({
      enabled: false,
      fetcher: async () => { fetchCalls += 1; return json({ results: [{ url: 'https://root.test/buddy' }] }) },
    })
    const off = await fixture.executeTool({ queries: ['off'] })
    expect(off.nextCalls).toBe(1)
    expect(fetchCalls).toBe(0)
    expect(fixture.credentials.reads).toHaveLength(0)

    ;(fixture.double.config.search.enabled as Ref<boolean>).set(true)
    fixture.volatile()
    const on = await fixture.executeTool({ queries: ['on'] })
    expect(on.nextCalls).toBe(0)
    expect(on.result.value.sources).toEqual([{ url: 'https://root.test/buddy' }])
    expect(fetchCalls).toBe(1)
    await fixture.dispose()
  })

  it('OFF 不取消旧调用；卸载先拒新，再 abort+settle 旧调用', async () => {
    let fetchSignal: AbortSignal | null | undefined
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    let settled = false
    const fixture = await createFixture({
      enabled: true,
      fetcher: async (_input, init) => {
        fetchSignal = init?.signal
        entered()
        await new Promise<void>((resolve) => {
          if (init?.signal?.aborted) { settled = true; resolve(); return }
          init?.signal?.addEventListener('abort', () => { settled = true; resolve() }, { once: true })
        })
        return json({ results: [{ url: 'https://root.test/late' }] })
      },
    })
    const running = fixture.executeTool({ queries: ['inflight'] })
    await enteredPromise
    ;(fixture.double.config.search.enabled as Ref<boolean>).set(false)
    fixture.volatile()
    const off = await fixture.executeTool({ queries: ['new-off'] })
    expect(off.nextCalls).toBe(1)
    expect(fetchSignal?.aborted).toBe(false)

    let disposed = false
    const disposing = fixture.dispose().then(() => { disposed = true })
    expect(fetchSignal?.aborted).toBe(true)
    await expect(fixture.executeTool({ queries: ['after-dispose'] })).rejects.toThrow()
    await Promise.resolve()
    expect(disposed).toBe(false)
    const outcome = await running.catch((error: unknown) => error)
    expect(outcome).toMatchObject({ code: 'SEARCH_FAILED', channel: 'buddy' })
    await disposing
    expect(settled).toBe(true)
  })

  it('Qoder auto 经 configEditor 持久化全局域，runtime.get 只给观测，卸载释放 WASM', async () => {
    const fixture = await createFixture({
      channel: 'qoder', enabled: true,
      fetcher: async (input) => {
        const host = new URL(String(input)).hostname
        if (host === 'center.qoder.sh') throw new TypeError('fetch failed')
        return json({ pageItems: [{ link: 'https://root.test/qoder' }] })
      },
    })
    const result = await fixture.executeTool({ queries: ['qoder auto'] })
    expect(result.result.value.sources).toEqual([{ url: 'https://root.test/qoder' }])
    expect(fixture.credentials.raw('dsh-web-search-channels/qoder-last-successful-host')).toEqual({
      kind: 'grant', payload: { host: 'api2.qoder.sh' },
    })

    const runtime = await fixture.runtimeGet()
    expect(runtime.result.ok).toBe(true)
    expect(runtime.result.value.qoder.autoActualHost).toBe('api2.qoder.sh')
    expect(Object.keys(runtime.result.value).sort()).toEqual(['activationId', 'qoder', 'revision'])
    const settingsRoute = fixture.routes.get('/api/web-search-channels')!
    const settingsResponse = await settingsRoute.fetch(new Request('http://local/api/web-search-channels', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'settings', method: 'web-search-channels',
        payload: { method: 'settings.get', payload: {} },
      }),
    }))
    expect(JSON.stringify(await settingsResponse.json())).not.toContain('lastSuccessfulHost')

    await fixture.dispose()
    const stats = (signerTesting as any).wasmOwnerStats()
    expect(stats.glueResident).toBe(false)
    expect(stats.activationRefs).toBe(0)
    expect(stats.signerRefs).toBe(0)
  })

  it('auto→fixed 后迟到的 auto 成功不得写全局路由或复活 actualHost', async () => {
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<Response>((resolve) => { release = () => resolve(json({ pageItems: [{ link: 'https://root.test/late-auto' }] })) })
    const fixture = await createFixture({
      channel: 'qoder', enabled: true,
      fetcher: async () => {
        entered()
        return await gate
      },
    })
    const running = fixture.executeTool({ queries: ['late auto'] })
    await enteredPromise
    ;(fixture.double.config.qoder.endpointPreference as Ref<'auto' | 'center' | 'api2'>).set('center')
    fixture.volatile()
    release()
    await running
    expect(fixture.credentials.raw('dsh-web-search-channels/qoder-last-successful-host')).toBeUndefined()
    const runtime = await fixture.runtimeGet()
    expect(runtime.result.value.qoder.autoActualHost).toBeNull()
    await fixture.dispose()
  })

  it('注册中途失败按同一路径回滚 route、listener、flows 与 WASM lease', async () => {
    await expect(createFixture({ failToolsRegistration: true }))
      .rejects.toThrow('intentional tools registration failure')
    expect(lastSetup?.routes.size).toBe(0)
    expect(lastSetup?.listeners.get('tools/execute')?.size ?? 0).toBe(0)
    expect(lastSetup?.listeners.get('loader/volatile-update')?.size ?? 0).toBe(0)
    const stats = (signerTesting as any).wasmOwnerStats()
    expect(stats.activationRefs).toBe(0)
    expect(stats.signerRefs).toBe(0)
  })
})
