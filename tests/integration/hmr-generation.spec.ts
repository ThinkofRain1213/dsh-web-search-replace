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
  const connection: ManagementRpcConnection = {
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return async () => { routes.delete(route.path) }
      },
    },
    rpc: { call: async () => { throw new Error('not used') } },
  }
  return { connection, routes }
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
    const route = routes.get('/api/web-search-channels')
    expect(route).toBeDefined()
    const response = await route!.fetch(new Request('http://local/api/web-search-channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'current', method: 'web-search-channels',
        payload: { method: 'settings.get', payload: {} },
      }),
    }))
    const body = await response.json() as any
    expect(body.result.value.search.channel).toBe('qoder')
    await current()
    expect(routes.has('/api/web-search-channels')).toBe(false)
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
