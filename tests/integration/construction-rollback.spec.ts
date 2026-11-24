/** R40：构造阶段的统一逆序回滚，覆盖 registry/factory/flow 注入失败。 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ManagementRpcRoute } from '../../src/shared/rpc.ts'
import { MemoryCredentials } from '../unit/support/memory-credentials.ts'
import { createSettingsDouble } from '../unit/support/settings-double.ts'

type FailureKind = 'registry' | 'factory' | 'flow'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

async function loadApply(kind: FailureKind) {
  vi.doMock('../../src/host/channels/auth-rpc.ts', async (importOriginal) => await importOriginal())
  vi.doMock('../../src/host/accounts/invocation.ts', async (importOriginal) => await importOriginal())
  vi.doMock('../../src/host/channels/buddy/auth.ts', async (importOriginal) => await importOriginal())
  vi.resetModules()
  if (kind === 'registry') {
    vi.doMock('../../src/host/channels/auth-rpc.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/host/channels/auth-rpc.ts')>()
      return {
        ...actual,
        createAuthFlowRegistry: () => { throw new Error('injected registry construction failure') },
      }
    })
  } else if (kind === 'factory') {
    vi.doMock('../../src/host/accounts/invocation.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/host/accounts/invocation.ts')>()
      return {
        ...actual,
        createInvocationDriverFactory: () => { throw new Error('injected invocation construction failure') },
      }
    })
  } else {
    vi.doMock('../../src/host/channels/buddy/auth.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/host/channels/buddy/auth.ts')>()
      return {
        ...actual,
        BuddyAuthFlow: class {
          constructor() { throw new Error('injected flow construction failure') }
        },
      }
    })
  }
  const [{ apply }, buddy, workbuddy, qoder, qodercn, signer] = await Promise.all([
    import('../../src/host/index.ts'),
    import('../../src/host/channels/buddy/auth.ts'),
    import('../../src/host/channels/workbuddy/auth.ts'),
    import('../../src/host/channels/qoder/auth.ts'),
    import('../../src/host/channels/qodercn/auth.ts'),
    import('../../src/host/channels/qoder/signer.ts'),
  ])
  const disposeSpies = kind === 'flow' ? [] : [
    vi.spyOn(buddy.BuddyAuthFlow.prototype, 'dispose'),
    vi.spyOn(workbuddy.WorkbuddyAuthFlow.prototype, 'dispose'),
    vi.spyOn(qoder.QoderInternationalAuthFlow.prototype, 'dispose'),
    vi.spyOn(qodercn.QoderCnAuthFlow.prototype, 'dispose'),
  ]
  return { apply, disposeSpies, signerTesting: signer.__testing }
}

function createContext() {
  const credentials = new MemoryCredentials()
  const double = createSettingsDouble()
  const routes = new Map<string, ManagementRpcRoute>()
  const listeners = new Map<string, Set<(...args: any[]) => unknown>>()
  const effectPromises: Promise<void>[] = []
  const ctx: any = {
    credentials,
    configEditor: double.editor,
    fiber: {
      entry: {
        id: 'dsh-web-search-replace',
        options: { id: 'dsh-web-search-replace', name: 'dsh-web-search-replace', config: {} },
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
      const group = listeners.get(name) ?? new Set()
      group.add(listener)
      listeners.set(name, group)
      return () => { group.delete(listener) }
    },
    effect(execute: () => Promise<() => Promise<void>> | (() => Promise<void>) | void) {
      const result = execute()
      if (result instanceof Promise) effectPromises.push(result.then(() => undefined))
      else effectPromises.push(Promise.resolve())
    },
  }
  return { ctx, double, routes, listeners, effectPromises }
}

describe.each([
  { kind: 'registry' as const, message: 'injected registry construction failure' },
  { kind: 'factory' as const, message: 'injected invocation construction failure' },
  { kind: 'flow' as const, message: 'injected flow construction failure' },
])('构造失败回滚：$kind', ({ kind, message }) => {
  it('释放 lease/flows/listener/route，后续代际不被 activationRefs 卡住', async () => {
    const { apply, disposeSpies, signerTesting } = await loadApply(kind)
    const { ctx, double, routes, listeners, effectPromises } = createContext()
    let failure: unknown
    try {
      await apply(ctx, double.config)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(message)
    await Promise.allSettled(effectPromises)

    const stats = (signerTesting as any).wasmOwnerStats()
    expect(stats.activationRefs).toBe(0)
    expect(stats.signerRefs).toBe(0)
    expect(routes.size).toBe(0)
    expect(listeners.size).toBe(0)
    if (kind !== 'flow') {
      for (const spy of disposeSpies) expect(spy).toHaveBeenCalledTimes(1)
    }
  })
})
