/** R41：SettingsController page-active runtime.get 顺序轮询与取消。 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SettingsController } from '../../src/client/controllers/settings.ts'
import type { HostRuntimeSnapshot } from '../../src/shared/runtime.ts'
import {
  createConfigFormsDouble,
  createConnectionDouble,
  deferred,
  makeSnapshot,
} from './support/settings-harness.ts'

afterEach(() => { vi.useRealTimers() })

function runtimeValue(activationId: string, revision: number, host: 'center.qoder.sh' | 'api2.qoder.sh' | null): HostRuntimeSnapshot {
  return { activationId, revision, qoder: { autoActualHost: host } }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('runtime.get 激活期轮询', () => {
  it('立即一次、settle 后才等 2 秒，不重叠；fixed/summary 清 timer+abort+null', async () => {
    vi.useFakeTimers()
    const snapshot = makeSnapshot({ channel: 'qoder', endpointPreference: 'auto' })
    const { configForms, form } = createConfigFormsDouble(snapshot)
    const pending: Array<ReturnType<typeof deferred<{ ok: true; value: HostRuntimeSnapshot }>>> = []
    const rpc = createConnectionDouble((call) => {
      expect(call.method).toBe('runtime.get')
      const next = deferred<{ ok: true; value: HostRuntimeSnapshot }>()
      pending.push(next)
      return next.promise
    })
    const controller = new SettingsController({ configForms, connection: rpc.connection })
    expect(rpc.signalCalls).toHaveLength(0)

    controller.setView('page')
    expect(rpc.signalCalls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(rpc.signalCalls).toHaveLength(1)

    pending[0]!.resolve({ ok: true, value: runtimeValue('activation-a', 1, 'center.qoder.sh') })
    await flush()
    expect(controller.getSnapshot().actualEndpointHost).toBe('center.qoder.sh')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(rpc.signalCalls).toHaveLength(2)

    form.push({ value: makeSnapshot({ channel: 'qoder', endpointPreference: 'center' }) })
    expect(rpc.signalCalls[1]?.signal?.aborted).toBe(true)
    expect(controller.getSnapshot().actualEndpointHost).toBeNull()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(rpc.signalCalls).toHaveLength(2)

    controller.setView('summary')
    expect(controller.getSnapshot().actualEndpointHost).toBeNull()
    controller.dispose()
  })

  it('Host activation 变化先清旧值，旧 revision 丢弃；RPC 失败不保留旧 host', async () => {
    vi.useFakeTimers()
    const snapshot = makeSnapshot({ channel: 'qoder', endpointPreference: 'auto' })
    const { configForms } = createConfigFormsDouble(snapshot)
    const responses: Array<() => any> = [
      () => ({ ok: true, value: runtimeValue('activation-a', 1, 'center.qoder.sh') }),
      () => ({ ok: true, value: runtimeValue('activation-b', 0, 'api2.qoder.sh') }),
      () => ({ ok: true, value: runtimeValue('activation-b', 0, 'center.qoder.sh') }),
      () => ({ ok: false, error: { code: 'unavailable', message: 'down', details: {} } }),
    ]
    let index = 0
    const rpc = createConnectionDouble(() => responses[index++]!())
    const controller = new SettingsController({ configForms, connection: rpc.connection })
    controller.setView('page')

    await flush()
    expect(controller.getSnapshot().actualEndpointHost).toBe('center.qoder.sh')
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(controller.getSnapshot().actualEndpointHost).toBe('api2.qoder.sh')
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    // 同一 activation 的旧 revision 不得覆盖当前值。
    expect(controller.getSnapshot().actualEndpointHost).toBe('api2.qoder.sh')
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(controller.getSnapshot().actualEndpointHost).toBeNull()
    controller.dispose()
  })

  it('Connection generation 变化 abort 当前 RPC 并立即 baseline 重拉', async () => {
    vi.useFakeTimers()
    const snapshot = makeSnapshot({ channel: 'qoder', endpointPreference: 'auto' })
    const { configForms } = createConfigFormsDouble(snapshot)
    let notify!: () => void
    const generation = {
      getSnapshot: () => 1,
      subscribe: (listener: () => void) => { notify = listener; return () => {} },
    }
    const first = deferred<{ ok: true; value: HostRuntimeSnapshot }>()
    const rpc = createConnectionDouble((call) => {
      if (call.method === 'runtime.get' && rpc.signalCalls.length === 1) return first.promise
      return { ok: true, value: runtimeValue('activation-b', 1, 'api2.qoder.sh') }
    })
    Object.assign(rpc.connection, { generation })
    const controller = new SettingsController({ configForms, connection: rpc.connection })
    controller.setView('page')
    expect(rpc.signalCalls).toHaveLength(1)

    notify()
    expect(rpc.signalCalls[0]?.signal?.aborted).toBe(true)
    expect(rpc.signalCalls).toHaveLength(2)
    first.resolve({ ok: true, value: runtimeValue('activation-a', 9, 'center.qoder.sh') })
    await flush()
    expect(controller.getSnapshot().actualEndpointHost).toBe('api2.qoder.sh')
    controller.dispose()
  })
})
