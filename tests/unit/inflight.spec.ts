import { describe, expect, it } from 'vitest'

import { InFlight } from '../../src/host/inflight.ts'
import { PluginLifecycle } from '../../src/host/lifecycle.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('InFlight', () => {
  it('成功/失败都 settle 移除，stopAccepting 后拒绝新 track', async () => {
    const inflight = new InFlight()
    const first = deferred<void>()
    const second = deferred<void>()
    const trackedFirst = inflight.track(first.promise)
    const trackedSecond = inflight.track(second.promise)
    expect(inflight.size).toBe(2)
    first.resolve()
    await trackedFirst
    expect(inflight.size).toBe(1)
    second.reject(new Error('expected'))
    await expect(trackedSecond).rejects.toThrow('expected')
    expect(inflight.size).toBe(0)

    inflight.stopAccepting()
    expect(() => inflight.track(Promise.resolve())).toThrow(/accepting|stopped|lifecycle/i)
  })
})

describe('PluginLifecycle', () => {
  it('begin 在创建 Promise 前给 lifecycle-owned 合成 signal；abortAll 同步 abort 并等待 settle', async () => {
    const lifecycle = new PluginLifecycle()
    const caller = new AbortController()
    const gate = deferred<void>()
    let settled = false
    const lease = lifecycle.begin(caller.signal)
    const operation = lease.track((async () => {
      await gate.promise
      settled = true
      return 'ok'
    })())
    let disposeResolved = false
    const disposing = lifecycle.abortAllAndSettle().then(() => { disposeResolved = true })
    expect(lease.signal.aborted).toBe(true)
    expect(caller.signal.aborted).toBe(false)
    expect(lifecycle.accepting).toBe(false)
    expect(() => lifecycle.begin()).toThrow(/accepting|stopped|lifecycle/i)
    await Promise.resolve()
    expect(disposeResolved).toBe(false)
    expect(settled).toBe(false)

    gate.resolve()
    await disposing
    await expect(operation).resolves.toBe('ok')
    expect(settled).toBe(true)
    expect(disposeResolved).toBe(true)
  })

  it('caller abort 只影响该 lease，不关闭整代；dispose 幂等', async () => {
    const lifecycle = new PluginLifecycle()
    const caller = new AbortController()
    const lease = lifecycle.begin(caller.signal)
    caller.abort()
    expect(lease.signal.aborted).toBe(true)
    expect(lifecycle.accepting).toBe(true)
    await Promise.all([lifecycle.dispose(), lifecycle.dispose()])
    expect(lifecycle.accepting).toBe(false)
  })
})
