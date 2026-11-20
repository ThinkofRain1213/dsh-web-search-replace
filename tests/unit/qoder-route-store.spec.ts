/** R44：独立 Host-only 全局路由记录、callback 代际与取消分类。 */
import { describe, expect, it } from 'vitest'

import { Config } from '../../src/host/config.ts'
import {
  QoderRouteStore,
  QODER_LAST_SUCCESSFUL_HOST_KEY,
  type QoderRouteSelection,
} from '../../src/host/channels/qoder/route-store.ts'
import { SettingsWriteCancelledError } from '../../src/host/settings/service.ts'
import { MemoryCredentials } from './support/memory-credentials.ts'

const API2 = 'api2.qoder.sh'
const CENTER = 'center.qoder.sh'

function selection(accountId: string, generation: number, preference: 'auto' | 'center' | 'api2' = 'auto'): QoderRouteSelection {
  return {
    channel: 'qoder', accountId, endpointPreference: preference, selectionGeneration: generation,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('R44 独立 Host-only 全局路由记录', () => {
  it('Config 与 configForms value/base/user 原始投影都不含 lastSuccessfulHost', () => {
    const value = Config({}) as any
    expect(value.qoder.lastSuccessfulHost).toBeUndefined()
    // 与安装版 ConfigFormSnapshot 相同的原样 value/base/user 投影镜像；先把
    // Volatile 叶子解析为普通 raw config，不复制其函数对象。
    const raw = {
      search: { enabled: value.search.enabled.get(), channel: value.search.channel.get() },
      buddy: { currentAccountId: value.buddy.currentAccountId.get() },
      workbuddy: { currentAccountId: value.workbuddy.currentAccountId.get() },
      qoder: {
        currentAccountId: value.qoder.currentAccountId.get(),
        endpointPreference: value.qoder.endpointPreference.get(),
      },
      qodercn: { currentAccountId: value.qodercn.currentAccountId.get() },
    }
    const mirror = { value: raw, base: structuredClone(raw), user: structuredClone(raw) }
    expect(JSON.stringify(mirror)).not.toContain('lastSuccessfulHost')
  })

  it('唯一记录只含 host；重启仍读取，账号切换共用且 fixed 忽略', async () => {
    const credentials = new MemoryCredentials()
    let current = selection('account-a', 1)
    const store = new QoderRouteStore({ credentials, readSelection: () => current })
    expect(await store.read()).toBeNull()
    expect(await store.write(API2, selection('account-a', 1))).toBe('written')
    expect(credentials.raw(QODER_LAST_SUCCESSFUL_HOST_KEY)).toEqual({
      kind: 'grant', payload: { host: API2 },
    })

    current = selection('account-b', 2)
    const restarted = new QoderRouteStore({ credentials, readSelection: () => current })
    expect(await restarted.read()).toBe(API2)
    expect(current.accountId).toBe('account-b')
    expect(current.selectionGeneration).toBe(2)

    const fixed = new QoderRouteStore({ credentials, readSelection: () => selection('account-b', 2, 'center') })
    expect(await fixed.read()).toBe(API2)
  })

  it('blocked modifyRecord 中 A→B→A 改变代际时 callback 返回 stale/no-op，不写迟到值', async () => {
    const credentials = new MemoryCredentials()
    let current = selection('account-a', 1)
    const store = new QoderRouteStore({ credentials, readSelection: () => current })
    const entered = deferred<void>()
    const gate = deferred<void>()
    const original = credentials.modifyRecord.bind(credentials)
    credentials.modifyRecord = async (key, mutate) => {
      entered.resolve()
      await gate.promise
      return await original(key, mutate)
    }
    const writing = store.write(API2, selection('account-a', 1))
    await entered.promise
    current = selection('account-b', 2)
    current = selection('account-a', 3)
    gate.resolve()
    expect(await writing).toBe('stale')
    expect(credentials.raw(QODER_LAST_SUCCESSFUL_HOST_KEY)).toBeUndefined()
  })

  it('pre-callback abort 分类为取消且不写；post-callback commit 已发生也只能 await 后报取消', async () => {
    const credentials = new MemoryCredentials()
    const current = selection('account-a', 1)
    const store = new QoderRouteStore({ credentials, readSelection: () => current })
    const before = new AbortController()
    const original = credentials.modifyRecord.bind(credentials)
    credentials.modifyRecord = async (key, mutate) => {
      before.abort()
      return await original(key, mutate)
    }
    await expect(store.write(API2, selection('account-a', 1), before.signal))
      .rejects.toBeInstanceOf(SettingsWriteCancelledError)
    expect(credentials.raw(QODER_LAST_SUCCESSFUL_HOST_KEY)).toBeUndefined()

    const after = new AbortController()
    credentials.modifyRecord = async (key, mutate) => {
      const currentRecord = await credentials.readRecord(key)
      const next = await mutate(currentRecord)
      after.abort()
      return await original(key, async () => next)
    }
    await expect(store.write(API2, selection('account-a', 1), after.signal))
      .rejects.toBeInstanceOf(SettingsWriteCancelledError)
    expect(credentials.raw(QODER_LAST_SUCCESSFUL_HOST_KEY)).toEqual({
      kind: 'grant', payload: { host: API2 },
    })
  })
})
