/**
 * Task 14 账号控制器：四渠道隔离、非秘密 DTO、当前账号、删除不自动递补、
 * 清除全部账号数据、授权轮询/generation/迟到回包与 dispose。
 *
 * 控制器只经共享 `callManagementRpc` 发请求，测试只替换 Connection 的 RPC 面。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AccountsController } from '../../src/client/controllers/accounts.ts'
import type { AccountSummary } from '../../src/shared/accounts.ts'
import type { RpcResult } from '../../src/shared/rpc.ts'
import {
  AUTH_URLS,
  accountCollection,
  accountSummary,
  authStatus,
  routeAccounts,
} from './support/accounts-harness.ts'
import {
  createConnectionDouble,
  deferred,
  type RpcResponder,
} from './support/settings-harness.ts'

const failure = {
  ok: false as const,
  error: { code: 'accounts/internal', message: 'accounts operation failed', details: {} },
}

afterEach(() => {
  vi.useRealTimers()
})

/**
 * 创建一个账号控制器与记录型 Connection。
 * @param responder - RPC 响应函数。
 * @param pollIntervalMs - 授权轮询间隔；测试默认 1000ms。
 * @param channel - 控制器渠道；默认 buddy。
 * @returns 控制器、调用记录与 Connection。
 */
function createController(
  responder: RpcResponder,
  pollIntervalMs = 1000,
  channel: 'buddy' | 'workbuddy' | 'qoder' | 'qodercn' = 'buddy',
) {
  const rpc = createConnectionDouble(responder)
  const controller = new AccountsController({
    channel,
    connection: rpc.connection,
    pollIntervalMs,
  })
  return { ...rpc, controller }
}

/** 只取指定方法的调用，便于断言 RPC payload。 */
function callsOf(
  calls: readonly { readonly method: string; readonly payload: unknown }[],
  method: string,
): unknown[] {
  return calls.filter(call => call.method === method).map(call => call.payload)
}

describe('AccountsController', () => {
  it('只按当前渠道读取合法的 accounts.list/current', async () => {
    const buddyAccount = accountSummary('buddy', 'buddy-account')
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [buddyAccount] }),
      'accounts.current': () => ({ ok: true, value: buddyAccount }),
    }))

    await controller.reload()

    expect(calls).toEqual([
      { method: 'accounts.list', payload: { channel: 'buddy' } },
      { method: 'accounts.current', payload: { channel: 'buddy' } },
    ])
    expect(controller.getSnapshot()).toMatchObject({
      channel: 'buddy',
      status: 'ready',
      accounts: [buddyAccount],
      current: buddyAccount,
      error: null,
    })
    controller.dispose()
  })

  it('跨渠道/畸形 list、畸形 current 或 current 不在列表时整次失败并保留旧快照', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const foreign = accountSummary('qoder', 'qoder-account')
    const poisoned = {
      ...a,
      accessToken: 'sentinel-access-token',
    } as unknown as AccountSummary
    let mode: 'valid' | 'mixed' | 'poisoned' | 'foreign-current' | 'current-not-in-list' = 'valid'
    const { controller } = createController(routeAccounts({
      'accounts.list': () => ({
        ok: true,
        value: mode === 'mixed'
          ? [a, foreign]
          : mode === 'poisoned'
            ? [a, poisoned]
            : [a],
      }),
      'accounts.current': () => ({
        ok: true,
        value: mode === 'foreign-current'
          ? foreign
          : mode === 'current-not-in-list'
            ? b
            : a,
      }),
    }))
    await controller.reload()
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', accounts: [a], current: a })

    for (const nextMode of ['mixed', 'poisoned', 'foreign-current', 'current-not-in-list'] as const) {
      mode = nextMode
      const refreshed = await controller.reload()
      expect(refreshed, nextMode).toBe(false)
      expect(controller.getSnapshot(), nextMode).toMatchObject({
        status: 'error',
        error: 'channel.accounts.loadFailed',
        accounts: [a],
        current: a,
      })
    }

    mode = 'valid'
    expect(await controller.reload()).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      accounts: [a],
      current: a,
      error: null,
    })
    controller.dispose()
  })

  it('setCurrent 回包必须是请求目标且在本渠道列表中，否则不发布成功', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const foreign = accountSummary('qoder', 'qoder-account')
    let next: AccountSummary | null = null
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.setCurrent': () => ({ ok: true, value: next }),
    }))
    await controller.reload()

    for (const invalid of [null, foreign, a]) {
      next = invalid
      await controller.setCurrent('account-b')
      expect(controller.getSnapshot()).toMatchObject({
        current: a,
        error: 'channel.accounts.setCurrentFailed',
        busyAccountId: null,
      })
    }

    next = b
    await controller.setCurrent('account-b')
    expect(controller.getSnapshot()).toMatchObject({
      current: b,
      error: null,
    })
    expect(callsOf(calls, 'accounts.setCurrent')).toHaveLength(4)
    controller.dispose()
  })

  it('delete 回包必须满足删除目标/replacement/当前账号关系，否则保留旧集合', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const foreign = accountSummary('qoder', 'qoder-account')
    const cases: ReadonlyArray<{
      readonly name: string
      readonly accountId: string
      readonly replacement: string | null
      readonly collection: ReturnType<typeof accountCollection>
    }> = [
      {
        name: 'deleted account still present',
        accountId: 'account-b',
        replacement: null,
        collection: accountCollection([a, b], a),
      },
      {
        name: 'current auto-selected',
        accountId: 'account-a',
        replacement: null,
        collection: accountCollection([b], b),
      },
      {
        name: 'replacement not applied',
        accountId: 'account-a',
        replacement: 'account-b',
        collection: accountCollection([b], null),
      },
      {
        name: 'non-current delete changed current',
        accountId: 'account-b',
        replacement: null,
        collection: accountCollection([a], b),
      },
      {
        name: 'foreign account in collection',
        accountId: 'account-b',
        replacement: null,
        collection: accountCollection([a, foreign], a),
      },
    ]

    for (const testCase of cases) {
      const { controller } = createController(routeAccounts({
        'accounts.list': () => ({ ok: true, value: [a, b] }),
        'accounts.current': () => ({ ok: true, value: a }),
        'accounts.delete': () => ({ ok: true, value: testCase.collection }),
      }))
      await controller.reload()
      await controller.deleteAccount(testCase.accountId, testCase.replacement)
      expect(controller.getSnapshot(), testCase.name).toMatchObject({
        accounts: [a, b],
        current: a,
        error: 'channel.accounts.deleteFailed',
        busyAccountId: null,
      })
      controller.dispose()
    }
  })

  it('completed 后的刷新在飞时拒绝相互覆盖的写操作；刷新完成后才允许新写入', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const listResponse = deferred<RpcResult<readonly AccountSummary[]>>()
    const currentResponse = deferred<RpcResult<AccountSummary | null>>()
    let reloadCount = 0
    let setCurrentTarget: AccountSummary | null = null
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => {
        reloadCount += 1
        return reloadCount === 1
          ? { ok: true, value: [a, b] }
          : listResponse.promise
      },
      'accounts.current': () => {
        if (reloadCount === 1) return { ok: true, value: a }
        return currentResponse.promise
      },
      'accounts.setCurrent': () => ({ ok: true, value: setCurrentTarget }),
      'auth.start': () => ({
        ok: true,
        value: authStatus('buddy', {
          status: 'completed',
          authUrl: null,
          account: a,
        }),
      }),
    }))
    await controller.reload()
    const pendingAuth = controller.startAuth()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(controller.getSnapshot()).toMatchObject({
      authBusy: false,
      refreshBusy: true,
      auth: { phase: 'completed' },
    })
    await controller.setCurrent('account-b')
    await controller.deleteAccount('account-a', null)
    expect(callsOf(calls, 'accounts.setCurrent')).toEqual([])
    expect(callsOf(calls, 'accounts.delete')).toEqual([])
    expect(controller.getSnapshot().queue).toEqual([])

    listResponse.resolve({ ok: true, value: [a, b] })
    currentResponse.resolve({ ok: true, value: a })
    await pendingAuth
    expect(controller.getSnapshot()).toMatchObject({
      refreshBusy: false,
      current: a,
      notice: 'channel.accounts.notice.added',
    })

    setCurrentTarget = b
    await controller.setCurrent('account-b')
    expect(callsOf(calls, 'accounts.setCurrent')).toEqual([
      { channel: 'buddy', accountId: 'account-b' },
    ])
    expect(controller.getSnapshot().current).toEqual(b)
    controller.dispose()
  })

  it('completed 后的刷新失败不显示成功 notice，并保留读取错误', async () => {
    const a = accountSummary('buddy', 'account-a')
    let listCalls = 0
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => {
        listCalls += 1
        return listCalls === 1
          ? { ok: true, value: [a] }
          : failure
      },
      'accounts.current': () => ({ ok: true, value: a }),
      'auth.start': () => ({
        ok: true,
        value: authStatus('buddy', {
          status: 'completed',
          authUrl: null,
          account: a,
        }),
      }),
    }))
    await controller.reload()
    await controller.startAuth()

    expect(controller.getSnapshot()).toMatchObject({
      authBusy: false,
      refreshBusy: false,
      notice: null,
      error: 'channel.accounts.loadFailed',
      status: 'error',
      auth: { phase: 'completed' },
    })
    expect(callsOf(calls, 'accounts.list')).toEqual([
      { channel: 'buddy' },
      { channel: 'buddy' },
    ])
    controller.dispose()
  })

  it('setCurrent/delete 迟到回包在 dispose 后不更新状态或通知订阅者', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const setCurrentResponse = deferred<RpcResult<AccountSummary | null>>()
    const deleteResponse = deferred<RpcResult<ReturnType<typeof accountCollection>>>()
    const { controller } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.setCurrent': () => setCurrentResponse.promise,
      'accounts.delete': () => deleteResponse.promise,
    }))
    await controller.reload()
    let notifications = 0
    controller.subscribe(() => { notifications += 1 })

    const setting = controller.setCurrent('account-b')
    expect(controller.getSnapshot()).toMatchObject({
      busyAccountId: 'account-b',
      busyAction: 'setCurrent',
    })
    controller.dispose()
    const before = notifications
    setCurrentResponse.resolve({ ok: true, value: b })
    await setting
    expect(notifications).toBe(before)
    expect(controller.getSnapshot().current).toEqual(a)

    const second = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.delete': () => deleteResponse.promise,
    }))
    await second.controller.reload()
    const deleting = second.controller.deleteAccount('account-a', null)
    expect(second.controller.getSnapshot()).toMatchObject({
      busyAccountId: 'account-a',
      busyAction: 'delete',
    })
    second.controller.dispose()
    deleteResponse.resolve({
      ok: true,
      value: accountCollection([b], null),
    })
    await deleting
    expect(second.controller.getSnapshot()).toMatchObject({
      accounts: [a, b],
      current: a,
    })
  })

  it('读取中保持 loading，不假装没有账号；失败可重试并显示本地化错误键', async () => {
    const list = deferred<RpcResult<readonly AccountSummary[]>>()
    const current = deferred<RpcResult<AccountSummary | null>>()
    let failed = true
    const { controller } = createController(call => {
      if (call.method === 'accounts.list') {
        return failed ? list.promise : { ok: true, value: [] }
      }
      return failed ? current.promise : { ok: true, value: null }
    })

    const pending = controller.reload()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'loading',
      accounts: [],
      current: null,
    })

    list.resolve(failure)
    await pending
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'channel.accounts.loadFailed',
    })

    failed = false
    await controller.reload()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      error: null,
    })
    controller.dispose()
  })

  it('设置当前账号只锁相关行；成功后以返回 DTO 更新 current，失败保持旧值', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const response = deferred<RpcResult<AccountSummary | null>>()
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.setCurrent': () => response.promise,
    }))
    await controller.reload()

    const pending = controller.setCurrent('account-b')
    expect(controller.getSnapshot()).toMatchObject({
      current: a,
      busyAccountId: 'account-b',
      busyAction: 'setCurrent',
    })
    expect(controller.getSnapshot().authBusy).toBe(false)
    expect(callsOf(calls, 'accounts.setCurrent')).toEqual([
      { channel: 'buddy', accountId: 'account-b' },
    ])

    response.resolve({ ok: true, value: b })
    await pending
    expect(controller.getSnapshot()).toMatchObject({
      current: b,
      busyAccountId: null,
      busyAction: null,
      error: null,
    })

    const failing = deferred<RpcResult<AccountSummary | null>>()
    const controller2 = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.setCurrent': () => failing.promise,
    })).controller
    await controller2.reload()
    const second = controller2.setCurrent('account-b')
    failing.resolve(failure)
    await second
    expect(controller2.getSnapshot()).toMatchObject({
      current: a,
      error: 'channel.accounts.setCurrentFailed',
      busyAccountId: null,
    })

    controller.dispose()
    controller2.dispose()
  })

  it('删除非当前账号不带 replacement；删除当前账号默认显式 null 且不自动递补', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')

    const nonCurrent = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.delete': () => ({
        ok: true,
        value: accountCollection([a], a),
      }),
    }))
    await nonCurrent.controller.reload()
    await nonCurrent.controller.deleteAccount('account-b', null)
    expect(callsOf(nonCurrent.calls, 'accounts.delete')).toEqual([
      { channel: 'buddy', accountId: 'account-b' },
    ])

    const currentNull = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.delete': () => ({
        ok: true,
        value: accountCollection([b], null),
      }),
    }))
    await currentNull.controller.reload()
    await currentNull.controller.deleteAccount('account-a', null)
    expect(callsOf(currentNull.calls, 'accounts.delete')).toEqual([
      { channel: 'buddy', accountId: 'account-a', replacementAccountId: null },
    ])
    expect(currentNull.controller.getSnapshot()).toMatchObject({
      accounts: [b],
      current: null,
      error: null,
    })
    expect(callsOf(currentNull.calls, 'accounts.setCurrent')).toEqual([])

    const currentReplaced = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.delete': () => ({
        ok: true,
        value: accountCollection([b], b),
      }),
    }))
    await currentReplaced.controller.reload()
    await currentReplaced.controller.deleteAccount('account-a', 'account-b')
    expect(callsOf(currentReplaced.calls, 'accounts.delete')).toEqual([
      { channel: 'buddy', accountId: 'account-a', replacementAccountId: 'account-b' },
    ])
    expect(currentReplaced.controller.getSnapshot().current).toEqual(b)

    nonCurrent.controller.dispose()
    currentNull.controller.dispose()
    currentReplaced.controller.dispose()
  })

  it('删除失败保持旧列表与当前账号，并显示本地化错误键', async () => {
    const a = accountSummary('buddy', 'account-a')
    const { controller } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.delete': () => failure,
    }))
    await controller.reload()
    await controller.deleteAccount('account-a', null)

    expect(controller.getSnapshot()).toMatchObject({
      accounts: [a],
      current: a,
      error: 'channel.accounts.deleteFailed',
      busyAccountId: null,
      busyAction: null,
    })
    controller.dispose()
  })

  it('清除全部只发 accounts.clearAll {}，成功后重新读取当前渠道并显示提示', async () => {
    const a = accountSummary('buddy', 'account-a')
    let cleared = false
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: cleared ? [] : [a] }),
      'accounts.current': () => ({ ok: true, value: cleared ? null : a }),
      'accounts.clearAll': () => {
        cleared = true
        return { ok: true, value: { cleared: 3 } }
      },
    }))
    await controller.reload()
    await controller.clearAll()

    expect(callsOf(calls, 'accounts.clearAll')).toEqual([{}])
    expect(callsOf(calls, 'accounts.list')).toEqual([
      { channel: 'buddy' },
      { channel: 'buddy' },
    ])
    expect(callsOf(calls, 'accounts.current')).toEqual([
      { channel: 'buddy' },
      { channel: 'buddy' },
    ])
    expect(controller.getSnapshot()).toMatchObject({
      accounts: [],
      current: null,
      clearBusy: false,
      notice: 'channel.accounts.notice.cleared',
      error: null,
    })
    controller.dispose()
  })

  it('清除全部失败保留原列表并显示错误；确认前不会自行调用', async () => {
    const a = accountSummary('buddy', 'account-a')
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.clearAll': () => failure,
    }))
    await controller.reload()
    expect(callsOf(calls, 'accounts.clearAll')).toEqual([])

    await controller.clearAll()
    expect(controller.getSnapshot()).toMatchObject({
      accounts: [a],
      current: a,
      error: 'channel.accounts.clearFailed',
      clearBusy: false,
      notice: null,
    })
    controller.dispose()
  })

  it('添加账号只发 auth.start {channel}，pending 轮询 auth.status，完成后刷新账号', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = accountSummary('buddy', 'account-a')
    let statusCalls = 0
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.status': () => {
        statusCalls += 1
        return statusCalls === 1
          ? { ok: true, value: authStatus('buddy') }
          : {
              ok: true,
              value: authStatus('buddy', {
                status: 'completed',
                authUrl: null,
                displayHint: 'done',
                account: a,
              }),
            }
      },
    }))
    await controller.reload()

    await controller.startAuth()
    expect(callsOf(calls, 'auth.start')).toEqual([{ channel: 'buddy' }])
    expect(controller.getSnapshot()).toMatchObject({
      authBusy: true,
      auth: {
        phase: 'pending',
        flowId: 'flow-1',
        authUrl: AUTH_URLS.buddy,
        targetAccountId: null,
      },
    })

    await vi.advanceTimersByTimeAsync(1000)
    expect(statusCalls).toBe(1)
    expect(controller.getSnapshot().auth.phase).toBe('pending')
    expect(callsOf(calls, 'auth.status')).toEqual([
      { channel: 'buddy', flowId: 'flow-1' },
    ])

    await vi.advanceTimersByTimeAsync(1000)
    expect(statusCalls).toBe(2)
    expect(controller.getSnapshot()).toMatchObject({
      authBusy: false,
      accounts: [a],
      current: a,
      notice: 'channel.accounts.notice.added',
      auth: { phase: 'completed', authUrl: null, errorCode: null },
    })
    expect(callsOf(calls, 'auth.refresh')).toEqual([])
    expect(callsOf(calls, 'accounts.list')).toEqual([
      { channel: 'buddy' },
      { channel: 'buddy' },
    ])
    controller.dispose()
  })

  it('重新登录使用 auth.start {channel,accountId}，完成后提示重登成功', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = accountSummary('buddy', 'account-a')
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'auth.start': () => ({
        ok: true,
        value: authStatus('buddy', {
          status: 'completed',
          authUrl: null,
          account: a,
        }),
      }),
    }))
    await controller.reload()
    await controller.startAuth('account-a')

    expect(callsOf(calls, 'auth.start')).toEqual([
      { channel: 'buddy', accountId: 'account-a' },
    ])
    expect(controller.getSnapshot()).toMatchObject({
      authBusy: false,
      notice: 'channel.accounts.notice.reauthSucceeded',
      auth: { phase: 'completed', targetAccountId: 'account-a' },
    })
    controller.dispose()
  })

  it('取消授权立即停止轮询并忽略迟到 status 回包', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = accountSummary('buddy', 'account-a')
    const lateStatus = deferred<RpcResult<ReturnType<typeof authStatus>>>()
    let statusCalls = 0
    const cancel = deferred<RpcResult<ReturnType<typeof authStatus>>>()
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.status': () => {
        statusCalls += 1
        return lateStatus.promise
      },
      'auth.cancel': () => cancel.promise,
    }))
    await controller.reload()
    await controller.startAuth()
    await vi.advanceTimersByTimeAsync(1000)
    expect(statusCalls).toBe(1)

    const cancelling = controller.cancelAuth()
    expect(controller.getSnapshot().auth.phase).toBe('cancelling')
    expect(callsOf(calls, 'auth.cancel')).toEqual([
      { channel: 'buddy', flowId: 'flow-1' },
    ])

    cancel.resolve({
      ok: true,
      value: authStatus('buddy', { status: 'cancelled', authUrl: null }),
    })
    await cancelling
    expect(controller.getSnapshot()).toMatchObject({
      authBusy: false,
      auth: { phase: 'cancelled', authUrl: null },
    })

    lateStatus.resolve({
      ok: true,
      value: authStatus('buddy', {
        status: 'completed',
        authUrl: null,
        account: a,
      }),
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getSnapshot().auth.phase).toBe('cancelled')
    expect(callsOf(calls, 'accounts.list')).toEqual([{ channel: 'buddy' }])

    await vi.advanceTimersByTimeAsync(5000)
    expect(statusCalls).toBe(1)
    controller.dispose()
  })

  it('授权失败保留固定 errorCode 并忽略 Host displayHint / 非法 http URL', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { controller } = createController(routeAccounts({
      'auth.start': () => ({
        ok: true,
        value: authStatus('buddy', {
          status: 'failed',
          authUrl: 'http://evil.example/auth',
          displayHint: '仅中文的后台提示',
          errorCode: 'auth/identity-mismatch',
        }),
      }),
    }))
    await controller.reload()
    await controller.startAuth()

    const snapshot = controller.getSnapshot()
    expect(snapshot).toMatchObject({
      authBusy: false,
      auth: {
        phase: 'failed',
        authUrl: null,
        errorCode: 'auth/identity-mismatch',
      },
    })
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('仅中文的后台提示')
    expect(serialized).not.toContain('displayHint')
    controller.dispose()
  })

  it('跨渠道授权状态不会被当成成功结果', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { controller } = createController(routeAccounts({
      'auth.start': () => ({
        ok: true,
        value: authStatus('qodercn', {
          status: 'pending',
          authUrl: 'https://auth.qoder.cn/device?machine_id=other',
        }),
      }),
    }))
    await controller.reload()
    await controller.startAuth()

    expect(controller.getSnapshot()).toMatchObject({
      authBusy: false,
      auth: { phase: 'failed', authUrl: null, flowId: null },
      error: 'channel.auth.startFailed',
    })
    controller.dispose()
  })

  it('auth.status 读取失败停止轮询；起始/取消失败都解锁并显示本地化错误键', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let statusCalls = 0
    const { controller } = createController(routeAccounts({
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.status': () => {
        statusCalls += 1
        return failure
      },
    }))
    await controller.reload()
    await controller.startAuth()
    await vi.advanceTimersByTimeAsync(1000)
    expect(controller.getSnapshot()).toMatchObject({
      authBusy: false,
      auth: { phase: 'failed' },
      error: 'channel.auth.statusFailed',
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect(statusCalls).toBe(1)
    controller.dispose()

    const startFailure = createController(routeAccounts({
      'auth.start': () => failure,
    }))
    await startFailure.controller.reload()
    await startFailure.controller.startAuth()
    expect(startFailure.controller.getSnapshot()).toMatchObject({
      authBusy: false,
      error: 'channel.auth.startFailed',
      auth: { phase: 'failed' },
    })
    startFailure.controller.dispose()

    const cancelFailure = createController(routeAccounts({
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.cancel': () => failure,
    }))
    await cancelFailure.controller.reload()
    await cancelFailure.controller.startAuth()
    await cancelFailure.controller.cancelAuth()
    expect(cancelFailure.controller.getSnapshot()).toMatchObject({
      authBusy: false,
      error: 'channel.auth.cancelFailed',
      auth: { phase: 'failed' },
    })
    cancelFailure.controller.dispose()
  })

  it('取消/失败/完成/卸载后不再保留轮询定时器', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = accountSummary('buddy', 'account-a')
    let statusCalls = 0
    const { controller } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.status': () => {
        statusCalls += 1
        return { ok: true, value: authStatus('buddy') }
      },
    }))
    await controller.reload()
    await controller.startAuth()
    await vi.advanceTimersByTimeAsync(1000)
    expect(statusCalls).toBe(1)

    controller.dispose()
    await vi.advanceTimersByTimeAsync(5000)
    expect(statusCalls).toBe(1)
  })

  it('授权在飞时拒绝并发账号操作与第二个授权流程', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = accountSummary('buddy', 'account-a')
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
    }))
    await controller.reload()
    await controller.startAuth()

    await controller.startAuth()
    await controller.setCurrent('account-a')
    await controller.deleteAccount('account-a', null)
    await controller.clearAll()

    expect(callsOf(calls, 'auth.start')).toHaveLength(1)
    expect(callsOf(calls, 'accounts.setCurrent')).toEqual([])
    expect(callsOf(calls, 'accounts.delete')).toEqual([])
    expect(callsOf(calls, 'accounts.clearAll')).toEqual([])
    controller.dispose()
  })

  it('dispose 后丢弃迟到的 list/current 与授权回包，不再通知订阅者', async () => {
    const list = deferred<RpcResult<readonly AccountSummary[]>>()
    const { controller } = createController(call => {
      if (call.method === 'accounts.list') return list.promise
      return { ok: true, value: null }
    })
    let notifications = 0
    controller.subscribe(() => { notifications += 1 })
    const pending = controller.reload()
    expect(notifications).toBeGreaterThan(0)
    const before = notifications

    controller.dispose()
    list.resolve({ ok: true, value: [accountSummary('buddy', 'account-a')] })
    await pending

    expect(notifications).toBe(before)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'loading',
      accounts: [],
    })
  })

  it('pending 带非法/错渠道 authUrl 时 fail closed：不保存链接、停止轮询并清理原 flow', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const invalidUrls = [
      'https://qoder.com/device/selectAccounts?machine_id=m',
      'https://evil.example/auth',
      'https://user:pass@www.codebuddy.cn/login',
      'https://www.codebuddy.cn:8443/login',
      'https://www.codebuddy.cn/login#fragment',
      'https://www.codebuddy.cn/login\ninjected',
      'https://',
      `https://www.codebuddy.cn/login?state=${'a'.repeat(2049)}`,
    ]
    for (const authUrl of invalidUrls) {
      let statusCalls = 0
      const { controller, calls } = createController(routeAccounts({
        'auth.start': () => ({
          ok: true,
          value: authStatus('buddy', { authUrl }),
        }),
        'auth.status': () => {
          statusCalls += 1
          return { ok: true, value: authStatus('buddy') }
        },
        'auth.cancel': () => ({
          ok: true,
          value: authStatus('buddy', { status: 'cancelled', authUrl: null }),
        }),
      }))
      await controller.reload()
      await controller.startAuth()

      expect(controller.getSnapshot(), authUrl).toMatchObject({
        authBusy: false,
        auth: {
          phase: 'failed',
          authUrl: null,
          errorCode: 'auth/invalid-response',
          flowId: null,
        },
      })
      expect(callsOf(calls, 'auth.cancel'), authUrl).toEqual([
        { channel: 'buddy', flowId: 'flow-1' },
      ])
      await vi.advanceTimersByTimeAsync(5000)
      expect(statusCalls, authUrl).toBe(0)
      controller.dispose()
    }
  })

  it('轮询返回同 flow 的非法 authUrl 时 fail closed 并停止后续轮询', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let statusCalls = 0
    const { controller, calls } = createController(routeAccounts({
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.status': () => {
        statusCalls += 1
        return {
          ok: true,
          value: authStatus('buddy', { authUrl: 'https://evil.example/device' }),
        }
      },
      'auth.cancel': () => ({
        ok: true,
        value: authStatus('buddy', { status: 'cancelled', authUrl: null }),
      }),
    }))
    await controller.reload()
    await controller.startAuth()
    await vi.advanceTimersByTimeAsync(1000)

    expect(statusCalls).toBe(1)
    expect(controller.getSnapshot()).toMatchObject({
      authBusy: false,
      auth: {
        phase: 'failed',
        authUrl: null,
        errorCode: 'auth/invalid-response',
        flowId: null,
      },
    })
    expect(callsOf(calls, 'auth.cancel')).toEqual([
      { channel: 'buddy', flowId: 'flow-1' },
    ])
    await vi.advanceTimersByTimeAsync(5000)
    expect(statusCalls).toBe(1)
    controller.dispose()
  })

  it('同渠道异 flowId 的 status 回包被拒绝，只清理原 flow 且不继续轮询', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let statusCalls = 0
    const { controller, calls } = createController(routeAccounts({
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.status': () => {
        statusCalls += 1
        return { ok: true, value: authStatus('buddy', { flowId: 'flow-b' }) }
      },
      'auth.cancel': () => ({
        ok: true,
        value: authStatus('buddy', { status: 'cancelled', authUrl: null }),
      }),
    }))
    await controller.reload()
    await controller.startAuth()
    await vi.advanceTimersByTimeAsync(1000)

    expect(statusCalls).toBe(1)
    expect(controller.getSnapshot()).toMatchObject({
      authBusy: false,
      auth: {
        phase: 'failed',
        authUrl: null,
        errorCode: 'auth/invalid-response',
        flowId: null,
      },
    })
    expect(callsOf(calls, 'auth.status')).toEqual([
      { channel: 'buddy', flowId: 'flow-1' },
    ])
    expect(callsOf(calls, 'auth.cancel')).toEqual([
      { channel: 'buddy', flowId: 'flow-1' },
    ])
    await vi.advanceTimersByTimeAsync(5000)
    expect(statusCalls).toBe(1)
    controller.dispose()
  })

  it('cancel 返回同渠道异 flowId 时不宣告取消成功、不刷新账号', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { controller, calls } = createController(routeAccounts({
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.cancel': () => ({
        ok: true,
        value: authStatus('buddy', { flowId: 'flow-b', status: 'cancelled', authUrl: null }),
      }),
    }))
    await controller.reload()
    await controller.startAuth()
    await controller.cancelAuth()

    expect(controller.getSnapshot()).toMatchObject({
      authBusy: false,
      auth: {
        phase: 'failed',
        authUrl: null,
        errorCode: 'auth/invalid-response',
      },
    })
    expect(callsOf(calls, 'auth.cancel')).toEqual([
      { channel: 'buddy', flowId: 'flow-1' },
    ])
    expect(callsOf(calls, 'accounts.list')).toEqual([{ channel: 'buddy' }])
    controller.dispose()
  })

  it('重登 completed 返回其他账号时拒绝成功、不刷新账号', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'auth.start': () => ({
        ok: true,
        value: authStatus('buddy', {
          status: 'completed',
          authUrl: null,
          account: b,
        }),
      }),
    }))
    await controller.reload()
    await controller.startAuth('account-a')

    expect(controller.getSnapshot()).toMatchObject({
      authBusy: false,
      current: a,
      notice: null,
      auth: {
        phase: 'failed',
        errorCode: 'auth/invalid-response',
        authUrl: null,
      },
    })
    expect(callsOf(calls, 'accounts.list')).toEqual([{ channel: 'buddy' }])
    controller.dispose()
  })

  it('status completed 缺少 account 或返回其他重登目标时不算成功', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.status': () => ({
        ok: true,
        value: authStatus('buddy', {
          status: 'completed',
          authUrl: null,
          account: b,
        }),
      }),
    }))
    await controller.reload()
    await controller.startAuth('account-a')
    await vi.advanceTimersByTimeAsync(1000)

    expect(controller.getSnapshot()).toMatchObject({
      authBusy: false,
      notice: null,
      auth: { phase: 'failed', errorCode: 'auth/invalid-response' },
    })
    expect(callsOf(calls, 'accounts.list')).toEqual([{ channel: 'buddy' }])
    controller.dispose()
  })

  it('completed 缺少 account 时不算成功', async () => {
    const a = accountSummary('buddy', 'account-a')
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'auth.start': () => ({
        ok: true,
        value: authStatus('buddy', {
          status: 'completed',
          authUrl: null,
          account: null,
        }),
      }),
    }))
    await controller.reload()
    await controller.startAuth()

    expect(controller.getSnapshot()).toMatchObject({
      authBusy: false,
      notice: null,
      auth: { phase: 'failed', errorCode: 'auth/invalid-response' },
    })
    expect(callsOf(calls, 'accounts.list')).toEqual([{ channel: 'buddy' }])
    controller.dispose()
  })

  it('错 URL + 错 flow 组合只清理 expectedFlowId，不采用返回链接或 flow', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { controller, calls } = createController(routeAccounts({
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.status': () => ({
        ok: true,
        value: authStatus('buddy', {
          flowId: 'flow-b',
          authUrl: 'https://qoder.com/device/selectAccounts?machine_id=m',
        }),
      }),
      'auth.cancel': () => ({
        ok: true,
        value: authStatus('buddy', { status: 'cancelled', authUrl: null }),
      }),
    }))
    await controller.reload()
    await controller.startAuth()
    await vi.advanceTimersByTimeAsync(1000)

    expect(controller.getSnapshot()).toMatchObject({
      auth: { phase: 'failed', authUrl: null, errorCode: 'auth/invalid-response' },
    })
    expect(callsOf(calls, 'auth.cancel')).toEqual([
      { channel: 'buddy', flowId: 'flow-1' },
    ])
    expect(callsOf(calls, 'auth.cancel')).not.toContainEqual({
      channel: 'buddy',
      flowId: 'flow-b',
    })
    controller.dispose()
  })

  it('dispose 对已知 pending flow 精确 best-effort cancel 一次，不通知、不继续轮询', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = accountSummary('buddy', 'account-a')
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.status': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.cancel': () => ({
        ok: true,
        value: authStatus('buddy', { status: 'cancelled', authUrl: null }),
      }),
    }))
    await controller.reload()
    let notifications = 0
    controller.subscribe(() => { notifications += 1 })
    await controller.startAuth()
    const before = notifications

    controller.dispose()
    controller.dispose()

    expect(callsOf(calls, 'auth.cancel')).toEqual([
      { channel: 'buddy', flowId: 'flow-1' },
    ])
    expect(notifications).toBe(before)
    await vi.advanceTimersByTimeAsync(5000)
    expect(callsOf(calls, 'auth.status')).toEqual([])
  })

  it('start 在飞时 dispose：迟到 pending 返回只补取消其 flow，不恢复 UI/轮询', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const start = deferred<RpcResult<ReturnType<typeof authStatus>>>()
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [] }),
      'accounts.current': () => ({ ok: true, value: null }),
      'auth.start': () => start.promise,
      'auth.status': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.cancel': () => ({
        ok: true,
        value: authStatus('buddy', { status: 'cancelled', authUrl: null }),
      }),
    }))
    await controller.reload()
    let notifications = 0
    controller.subscribe(() => { notifications += 1 })
    const pending = controller.startAuth()
    const before = notifications

    controller.dispose()
    start.resolve({ ok: true, value: authStatus('buddy') })
    await pending

    expect(notifications).toBe(before)
    expect(controller.getSnapshot().auth.phase).toBe('starting')
    expect(callsOf(calls, 'auth.cancel')).toEqual([
      { channel: 'buddy', flowId: 'flow-1' },
    ])
    await vi.advanceTimersByTimeAsync(5000)
    expect(callsOf(calls, 'auth.status')).toEqual([])
  })

  it('start 在飞时 dispose 的迟到结果若不是本渠道/合法状态，不取消未知流程', async () => {
    const start = deferred<RpcResult<ReturnType<typeof authStatus>>>()
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [] }),
      'accounts.current': () => ({ ok: true, value: null }),
      'auth.start': () => start.promise,
    }))
    await controller.reload()
    const pending = controller.startAuth()
    controller.dispose()
    start.resolve({
      ok: true,
      value: authStatus('qodercn', { flowId: 'flow-cn' }),
    })
    await pending

    expect(callsOf(calls, 'auth.cancel')).toEqual([])
  })

  it('待处理授权在正常渠道切换时由 dispose 清理旧 flow，且最多一次', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = accountSummary('buddy', 'account-a')
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.cancel': () => ({
        ok: true,
        value: authStatus('buddy', { status: 'cancelled', authUrl: null }),
      }),
    }))
    await controller.reload()
    await controller.startAuth()
    controller.dispose()
    await vi.advanceTimersByTimeAsync(5000)
    expect(callsOf(calls, 'auth.cancel')).toEqual([
      { channel: 'buddy', flowId: 'flow-1' },
    ])
    expect(callsOf(calls, 'auth.status')).toEqual([])
  })

  it('第二行操作在飞时第一行之后的操作可见排队，并按点击顺序执行', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const setCurrentResponse = deferred<RpcResult<AccountSummary | null>>()
    const deleteResponse = deferred<RpcResult<ReturnType<typeof accountCollection>>>()
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.setCurrent': () => setCurrentResponse.promise,
      'accounts.delete': () => deleteResponse.promise,
    }))
    await controller.reload()

    const setting = controller.setCurrent('account-b')
    const deleting = controller.deleteAccount('account-a', null)
    expect(controller.getSnapshot()).toMatchObject({
      busyAccountId: 'account-b',
      busyAction: 'setCurrent',
    })
    expect(controller.getSnapshot().queue.map(op => [op.kind, op.accountId])).toEqual([
      ['delete', 'account-a'],
    ])
    expect(callsOf(calls, 'accounts.setCurrent')).toHaveLength(1)
    expect(callsOf(calls, 'accounts.delete')).toEqual([])

    setCurrentResponse.resolve({ ok: true, value: b })
    await setting
    await Promise.resolve()
    expect(callsOf(calls, 'accounts.delete')).toEqual([
      { channel: 'buddy', accountId: 'account-a' },
    ])
    expect(controller.getSnapshot().queue).toEqual([])
    expect(controller.getSnapshot()).toMatchObject({
      current: b,
      busyAccountId: 'account-a',
      busyAction: 'delete',
    })

    deleteResponse.resolve({ ok: true, value: accountCollection([b], b) })
    await deleting
    expect(controller.getSnapshot()).toMatchObject({
      accounts: [b],
      current: b,
      busyAccountId: null,
      busyAction: null,
    })
    expect(controller.getSnapshot().queue).toEqual([])
    controller.dispose()
  })

  it('同一行同一操作在排队或执行期间不重复入队', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const response = deferred<RpcResult<AccountSummary | null>>()
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.setCurrent': () => response.promise,
    }))
    await controller.reload()

    const first = controller.setCurrent('account-b')
    await controller.setCurrent('account-b')
    expect(controller.getSnapshot().queue).toEqual([])
    expect(callsOf(calls, 'accounts.setCurrent')).toHaveLength(1)

    response.resolve({ ok: true, value: b })
    await first
    controller.dispose()
  })

  it('队列中未开始的重登在前项 settle 后执行；dispose 丢弃未开始项', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const setCurrentResponse = deferred<RpcResult<AccountSummary | null>>()
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.setCurrent': () => setCurrentResponse.promise,
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.cancel': () => ({
        ok: true,
        value: authStatus('buddy', { status: 'cancelled', authUrl: null }),
      }),
    }))
    await controller.reload()

    const setting = controller.setCurrent('account-b')
    const reauth = controller.startAuth('account-a')
    expect(controller.getSnapshot().queue.map(op => [op.kind, op.accountId])).toEqual([
      ['reauth', 'account-a'],
    ])

    setCurrentResponse.resolve({ ok: true, value: b })
    await setting
    await Promise.resolve()
    expect(callsOf(calls, 'auth.start')).toEqual([
      { channel: 'buddy', accountId: 'account-a' },
    ])
    expect(controller.getSnapshot().queue).toEqual([])

    controller.dispose()
    await reauth
  })

  it('dispose 丢弃未开始队列且不执行，已开始项回包不更新 UI', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const response = deferred<RpcResult<AccountSummary | null>>()
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.setCurrent': () => response.promise,
      'accounts.delete': () => ({ ok: true, value: accountCollection([b], null) }),
    }))
    await controller.reload()

    const setting = controller.setCurrent('account-b')
    const deleting = controller.deleteAccount('account-a', null)
    controller.dispose()
    await deleting
    expect(callsOf(calls, 'accounts.delete')).toEqual([])

    response.resolve({ ok: true, value: b })
    await setting
    expect(controller.getSnapshot()).toMatchObject({
      accounts: [a, b],
      current: a,
    })
  })

  it('队列前项失败仍推进后续项，失败错误保留到下一项成功', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const deleteResponse = deferred<RpcResult<ReturnType<typeof accountCollection>>>()
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.setCurrent': () => failure,
      'accounts.delete': () => deleteResponse.promise,
    }))
    await controller.reload()

    const setting = controller.setCurrent('account-b')
    const deleting = controller.deleteAccount('account-a', null)
    await setting
    await Promise.resolve()
    expect(callsOf(calls, 'accounts.delete')).toEqual([
      { channel: 'buddy', accountId: 'account-a', replacementAccountId: null },
    ])
    expect(controller.getSnapshot()).toMatchObject({
      busyAccountId: 'account-a',
      busyAction: 'delete',
      error: 'channel.accounts.setCurrentFailed',
    })

    deleteResponse.resolve({ ok: true, value: accountCollection([b], null) })
    await deleting
    expect(controller.getSnapshot()).toMatchObject({
      accounts: [b],
      current: null,
      error: null,
      queue: [],
    })
    controller.dispose()
  })

  it('dispose 的 best-effort 清理失败不向 UI/订阅者写回错误', async () => {
    const a = accountSummary('buddy', 'account-a')
    const { controller } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'auth.start': () => ({ ok: true, value: authStatus('buddy') }),
      'auth.cancel': () => failure,
    }))
    await controller.reload()
    let notifications = 0
    controller.subscribe(() => { notifications += 1 })
    await controller.startAuth()
    const before = notifications

    expect(() => controller.dispose()).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(notifications).toBe(before)
    expect(controller.getSnapshot()).toMatchObject({
      auth: { phase: 'pending', flowId: 'flow-1', authUrl: AUTH_URLS.buddy },
    })
  })

  it('所有状态只保留六字段账号投影：machine_id 只出现在 authUrl，其他字段不含秘密', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = accountSummary('qoder', 'account-a', { status: 'reauth_required' })
    const { controller } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'auth.start': () => ({ ok: true, value: authStatus('qoder') }),
    }), 1000, 'qoder')
    await controller.reload()
    await controller.startAuth()

    const snapshot = controller.getSnapshot()
    expect(snapshot.auth.authUrl).toBe(AUTH_URLS.qoder)
    const withoutAuthUrl = JSON.stringify({
      ...snapshot,
      auth: { ...snapshot.auth, authUrl: null },
    })
    expect(withoutAuthUrl).not.toContain('machine_id')
    expect(withoutAuthUrl).not.toContain('accessToken')
    expect(withoutAuthUrl).not.toContain('refreshToken')
    expect(withoutAuthUrl).not.toContain('uid')
    expect(intrinsicKeys(snapshot.accounts[0])).toEqual([
      'id',
      'displayName',
      'channelId',
      'endpointLabel',
      'status',
      'maskedIdentifier',
    ])
    controller.dispose()
  })
})

/**
 * 读取对象自有的可枚举键，用于秘密字段哨兵。
 * @param value - 任意对象。
 * @returns 键列表。
 */
function intrinsicKeys(value: object | undefined): string[] {
  return value === undefined ? [] : Object.keys(value)
}