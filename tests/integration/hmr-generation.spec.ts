/** R40/R41：route 代际与 actualHost selection generation。 */
import { describe, expect, it } from 'vitest'

import * as host from '../../src/host/index.ts'
import { registerManagementRpc } from '../../src/host/rpc.ts'
import { SettingsService } from '../../src/host/settings/service.ts'
import type { ManagementRpcConnection, ManagementRpcRoute } from '../../src/shared/rpc.ts'
import type { SearchSettingsSnapshot } from '../../src/shared/contracts.ts'
import { DEFAULT_SEARCH_SETTINGS } from '../../src/shared/contracts.ts'
import { createSettingsDouble } from '../unit/support/settings-double.ts'

function service(enabled = false, channel: 'buddy' | 'qoder' = 'buddy') {
  const double = createSettingsDouble({ search: { enabled, channel } })
  return new SettingsService({
    configEditor: double.editor,
    entry: { id: 'fixture' } as never,
    config: double.config,
  })
}

function connection() {
  const routes = new Map<string, ManagementRpcRoute>()
  let blockedDispose: { entered: () => void; promise: Promise<void> } | undefined
  let failNext = false
  let registrationSequence = 0
  const disposeGates = new Map<number, { entered: () => void; promise: Promise<void> }>()
  const connection: ManagementRpcConnection = {
    fetch: {
      register(route) {
        if (failNext) {
          failNext = false
          throw new Error('injected register failure')
        }
        registrationSequence += 1
        const registrationIndex = registrationSequence
        routes.set(route.path, route)
        return async () => {
          const indexedGate = disposeGates.get(registrationIndex)
          if (indexedGate !== undefined) {
            disposeGates.delete(registrationIndex)
            indexedGate.entered()
            await indexedGate.promise
          }
          if (blockedDispose !== undefined) {
            const gate = blockedDispose
            blockedDispose = undefined
            gate.entered()
            await gate.promise
          }
          routes.delete(route.path)
        }
      },
    },
    rpc: { call: async () => { throw new Error('not used') } },
  }
  return {
    connection,
    routes,
    blockNextDispose() {
      let release!: () => void
      let entered!: () => void
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
      const promise = new Promise<void>((resolve) => { release = resolve })
      blockedDispose = { entered, promise }
      return { entered: enteredPromise, release }
    },
    blockDispose(index: number) {
      let release!: () => void
      let entered!: () => void
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
      const promise = new Promise<void>((resolve) => { release = resolve })
      disposeGates.set(index, { entered, promise })
      return { entered: enteredPromise, release }
    },
    failNextRegister() { failNext = true },
  }
}

function qoderSnapshot(accountId: string, preference: 'auto' | 'center' | 'api2' = 'auto'): SearchSettingsSnapshot {
  return {
    ...DEFAULT_SEARCH_SETTINGS,
    search: { enabled: true, channel: 'qoder' },
    qoder: { currentAccountId: accountId, endpointPreference: preference },
  }
}

describe('generation-safe management route broker', () => {
  it('旧代 disposer 后于新代执行不删新 route；最后一代才移除底层 route', async () => {
    const { connection: conn, routes } = connection()
    const old = registerManagementRpc(conn, service(false, 'buddy'))
    const current = registerManagementRpc(conn, service(true, 'qoder'))
    await old()
    const route = routes.get('/api/web-search-replace')
    expect(route).toBeDefined()
    const response = await route!.fetch(new Request('http://local/api/web-search-replace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'current', method: 'web-search-replace',
        payload: { method: 'settings.get', payload: {} },
      }),
    }))
    const body = await response.json() as any
    expect(body.result.value.search.channel).toBe('qoder')
    await current()
    expect(routes.has('/api/web-search-replace')).toBe(false)
  })

  it('旧底层 disposer blocked→新 register→释放：新 ready 等待串行队列且新 route 存活', async () => {
    const { connection: conn, routes, blockNextDispose } = connection()
    const old = registerManagementRpc(conn, service(false, 'buddy'))
    await old.ready
    const gate = blockNextDispose()
    const disposing = old()
    await gate.entered

    const current = registerManagementRpc(conn, service(true, 'qoder'))
    let ready = false
    const currentReady = current.ready.then(() => { ready = true })
    gate.release()
    await currentReady
    await disposing
    expect(ready).toBe(true)
    const route = routes.get('/api/web-search-replace')
    expect(route).toBeDefined()
    const response = await route!.fetch(new Request('http://local/api/web-search-replace', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'current', method: 'web-search-replace',
        payload: { method: 'settings.get', payload: {} },
      }),
    }))
    expect((await response.json() as any).result.value.search.channel).toBe('qoder')
    await current()
    expect(routes.has('/api/web-search-replace')).toBe(false)
  })

  it('A/B/C/D：第二个 queued operation 正 await 时，后续 register 不得绕过完整 queue tail', async () => {
    const { connection: conn, routes, blockDispose } = connection()
    const a = registerManagementRpc(conn, service(false, 'buddy'))
    await a.ready

    const gateA = blockDispose(1)
    const b = registerManagementRpc(conn, service(false, 'buddy'))
    const c = registerManagementRpc(conn, service(true, 'qoder'))
    gateA.release()
    await b.ready

    const gateB = blockDispose(2)
    await gateB.entered
    const disposingC = c()

    const d = registerManagementRpc(conn, service(true, 'qoder'))
    let dReady = false
    const dReadyPromise = d.ready.then(() => { dReady = true })
    await Promise.resolve()
    expect(dReady).toBe(false)

    gateB.release()
    await dReadyPromise
    await disposingC
    const route = routes.get('/api/web-search-replace')
    expect(route).toBeDefined()
    const response = await route!.fetch(new Request('http://local/api/web-search-replace', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'd', method: 'web-search-replace',
        payload: { method: 'settings.get', payload: {} },
      }),
    }))
    expect((await response.json() as any).result.value.search.channel).toBe('qoder')
    await d()
    expect(routes.has('/api/web-search-replace')).toBe(false)
  })

  it('失败 settle 后仍 drain 后续 queued register/dispose，bucket 与底层 route 一致', async () => {
    const { connection: conn, routes, failNextRegister } = connection()
    const first = registerManagementRpc(conn, service(false, 'buddy'))
    await first.ready

    failNextRegister()
    const failed = registerManagementRpc(conn, service(true, 'qoder'))
    await expect(failed.ready).rejects.toThrow('injected register failure')
    const recovered = registerManagementRpc(conn, service(true, 'qoder'))
    await recovered.ready
    expect(routes.has('/api/web-search-replace')).toBe(true)
    await first()
    await recovered()
    expect(routes.has('/api/web-search-replace')).toBe(false)
  })

  it('注册失败保留一致 bucket 状态，后续注册可恢复并最终清理', async () => {
    const { connection: conn, routes, failNextRegister } = connection()
    const old = registerManagementRpc(conn, service(false, 'buddy'))
    await old.ready
    await old()

    failNextRegister()
    const failed = registerManagementRpc(conn, service(true, 'qoder'))
    await expect(failed.ready).rejects.toThrow('injected register failure')
    expect(routes.has('/api/web-search-replace')).toBe(false)

    const recovered = registerManagementRpc(conn, service(true, 'qoder'))
    await recovered.ready
    expect(routes.has('/api/web-search-replace')).toBe(true)
    await recovered()
    expect(routes.has('/api/web-search-replace')).toBe(false)
  })
})

describe('actualHost observation selection generation', () => {
  it('A 的迟到请求不写到 B，A→B→A 不复活旧 A，DTO 不含内部键', () => {
    const create = (host as any).createRuntimeObservationStore
    expect(typeof create).toBe('function')
    const store = create('activation-test')
    const a1 = qoderSnapshot('account-a')
    const generationA1 = store.captureSelection(a1)
    store.observe({
      channel: 'qoder', accountId: 'account-a', endpointPreference: 'auto', selectionGeneration: generationA1,
    }, a1, { preference: 'auto', outcome: 'succeeded', host: 'center.qoder.sh', attempts: [] })
    expect(store.getSnapshot().qoder.autoActualHost).toBe('center.qoder.sh')

    const b = qoderSnapshot('account-b')
    store.captureSelection(b)
    store.observe({
      channel: 'qoder', accountId: 'account-a', endpointPreference: 'auto', selectionGeneration: generationA1,
    }, b, { preference: 'auto', outcome: 'succeeded', host: 'api2.qoder.sh', attempts: [] })
    expect(store.getSnapshot().qoder.autoActualHost).toBeNull()

    const a2 = qoderSnapshot('account-a')
    store.captureSelection(a2)
    store.observe({
      channel: 'qoder', accountId: 'account-a', endpointPreference: 'auto', selectionGeneration: generationA1,
    }, a2, { preference: 'auto', outcome: 'succeeded', host: 'center.qoder.sh', attempts: [] })
    const dto = store.getSnapshot()
    expect(dto.qoder.autoActualHost).toBeNull()
    expect(Object.keys(dto).sort()).toEqual(['activationId', 'qoder', 'revision'])
    expect(JSON.stringify(dto)).not.toContain('account-a')
    expect(JSON.stringify(dto)).not.toContain('selectionGeneration')
  })

  it('auto 失败置 null，fixed 不提供 auto 观测', () => {
    const create = (host as any).createRuntimeObservationStore
    const store = create('activation-test')
    const auto = qoderSnapshot('account-a')
    const generation = store.captureSelection(auto)
    const selection = {
      channel: 'qoder', accountId: 'account-a', endpointPreference: 'auto', selectionGeneration: generation,
    }
    store.observe(selection, auto, { preference: 'auto', outcome: 'succeeded', host: 'api2.qoder.sh', attempts: [] })
    store.observe(selection, auto, { preference: 'auto', outcome: 'failed', attempts: [] })
    expect(store.getSnapshot().qoder.autoActualHost).toBeNull()
    store.observe(selection, qoderSnapshot('account-a', 'center'), {
      preference: 'center', outcome: 'succeeded', host: 'center.qoder.sh', attempts: [],
    })
    expect(store.getSnapshot().qoder.autoActualHost).toBeNull()
  })
})
