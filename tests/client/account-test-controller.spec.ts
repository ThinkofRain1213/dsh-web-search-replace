/** 每账号测试的控制器契约：同队列、行锁、generation、abort 与六字段 DTO。 */
import { describe, expect, it } from 'vitest'

import { AccountsController } from '../../src/client/controllers/accounts.ts'
import type { AccountStatus, AccountSummary } from '../../src/shared/accounts.ts'
import type { RpcResult } from '../../src/shared/rpc.ts'
import { accountSummary, routeAccounts } from './support/accounts-harness.ts'
import { createConnectionDouble, deferred } from './support/settings-harness.ts'

const failure = {
  ok: false as const,
  error: { code: 'accounts/internal', message: 'accounts operation failed', details: {} },
}

function createController(responder: Parameters<typeof createConnectionDouble>[0]) {
  const rpc = createConnectionDouble(responder)
  return {
    ...rpc,
    controller: new AccountsController({ channel: 'buddy', connection: rpc.connection }),
  }
}

function callsOf(calls: readonly { method: string; payload: unknown }[], method: string): unknown[] {
  return calls.filter(call => call.method === method).map(call => call.payload)
}

describe('AccountsController 每账号测试', () => {
  it('按 channel+accountId 发 accounts.test，busyAction=test 后只更新被测账号且不切当前账号', async () => {
    const current = accountSummary('buddy', 'account-a', { status: 'ready' })
    const alternative = accountSummary('buddy', 'account-b', { status: 'ready' })
    const pending = deferred<RpcResult<AccountSummary>>()
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [current, alternative] }),
      'accounts.current': () => ({ ok: true, value: current }),
      'accounts.test': () => pending.promise,
      'accounts.setCurrent': () => { throw new Error('test must not set current') },
    }))
    await controller.reload()

    const running = controller.testAccount('account-b')
    expect(controller.getSnapshot()).toMatchObject({
      busyAccountId: 'account-b', busyAction: 'test', current,
      accounts: [current, alternative],
    })
    expect(callsOf(calls, 'accounts.test')).toEqual([{ channel: 'buddy', accountId: 'account-b' }])
    expect(callsOf(calls, 'accounts.setCurrent')).toEqual([])

    pending.resolve({
      ok: true,
      value: accountSummary('buddy', 'account-b', { status: 'reauth_required' }),
    })
    await running
    expect(controller.getSnapshot()).toMatchObject({
      busyAccountId: null,
      busyAction: null,
      current,
      accounts: [current, accountSummary('buddy', 'account-b', { status: 'reauth_required' })],
      error: null,
    })
    expect(controller.getSnapshot().current?.id).toBe('account-a')
    controller.dispose()
  })

  it.each([
    ['ready'],
    ['reauth_required'],
    ['temporarily_unavailable'],
    ['credential_unavailable'],
  ] as const)('接受最终账号状态 %s，并同步 current 的摘要但不改选择', async (status) => {
    const current = accountSummary('buddy', 'account-a', { status: 'ready' })
    const { controller } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [current] }),
      'accounts.current': () => ({ ok: true, value: current }),
      'accounts.test': () => ({
        ok: true,
        value: accountSummary('buddy', 'account-a', { status: status as AccountStatus }),
      }),
    }))
    await controller.reload()
    await controller.testAccount('account-a')

    expect(controller.getSnapshot().current).toMatchObject({ id: 'account-a', status })
    expect(controller.getSnapshot().accounts[0]).toMatchObject({ id: 'account-a', status })
    expect(callsOf([], 'accounts.setCurrent')).toEqual([])
    controller.dispose()
  })

  it('测试复用既有 FIFO：前行 setCurrent settle 后才执行，重复测试不重复入队', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const setCurrent = deferred<RpcResult<AccountSummary | null>>()
    const test = deferred<RpcResult<AccountSummary>>()
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.setCurrent': () => setCurrent.promise,
      'accounts.test': () => test.promise,
    }))
    await controller.reload()

    const setting = controller.setCurrent('account-b')
    const testing = controller.testAccount('account-a')
    await controller.testAccount('account-a')
    expect(controller.getSnapshot().queue.map(operation => [operation.kind, operation.accountId])).toEqual([
      ['test', 'account-a'],
    ])
    expect(callsOf(calls, 'accounts.test')).toEqual([])

    setCurrent.resolve({ ok: true, value: b })
    await setting
    await Promise.resolve()
    expect(callsOf(calls, 'accounts.test')).toEqual([{ channel: 'buddy', accountId: 'account-a' }])
    expect(controller.getSnapshot()).toMatchObject({ busyAccountId: 'account-a', busyAction: 'test' })

    test.resolve({ ok: true, value: accountSummary('buddy', 'account-a', { status: 'temporarily_unavailable' }) })
    await testing
    expect(controller.getSnapshot()).toMatchObject({ current: b, busyAccountId: null, queue: [] })
    controller.dispose()
  })

  it('排队中的测试可取消且不执行；活动测试 abort 后忽略迟到回包并推进后续队列', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const firstSet = deferred<RpcResult<AccountSummary | null>>()
    const secondSet = deferred<RpcResult<AccountSummary | null>>()
    let testSignal: AbortSignal | undefined
    const { controller, calls } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a, b] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.setCurrent': call => (
        (call.payload as { accountId: string }).accountId === 'account-b'
          ? firstSet.promise
          : secondSet.promise
      ),
      'accounts.test': (_call, signal) => {
        testSignal = signal
        return new Promise<RpcResult<AccountSummary>>((_resolve, reject) => {
          signal?.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
        })
      },
    }))
    await controller.reload()

    const setting = controller.setCurrent('account-b')
    const queuedTest = controller.testAccount('account-a')
    controller.cancelTest('account-a')
    await queuedTest
    firstSet.resolve({ ok: true, value: b })
    await setting
    expect(callsOf(calls, 'accounts.test')).toEqual([])

    const activeTest = controller.testAccount('account-a')
    await Promise.resolve()
    expect(controller.getSnapshot()).toMatchObject({ busyAccountId: 'account-a', busyAction: 'test' })
    const restoring = controller.setCurrent('account-a')
    controller.cancelTest('account-a')
    expect(testSignal?.aborted).toBe(true)
    await activeTest
    await Promise.resolve()
    expect(callsOf(calls, 'accounts.setCurrent')).toEqual([
      { channel: 'buddy', accountId: 'account-b' },
      { channel: 'buddy', accountId: 'account-a' },
    ])
    secondSet.resolve({ ok: true, value: a })
    await restoring
    expect(controller.getSnapshot()).toMatchObject({ current: a, busyAccountId: null, queue: [] })
    controller.dispose()
  })

  it('dispose abort 活动测试，迟到结果不更新账号、不通知订阅者', async () => {
    const a = accountSummary('buddy', 'account-a')
    const result = deferred<RpcResult<AccountSummary>>()
    let signal: AbortSignal | undefined
    const { controller } = createController(routeAccounts({
      'accounts.list': () => ({ ok: true, value: [a] }),
      'accounts.current': () => ({ ok: true, value: a }),
      'accounts.test': (_call, rpcSignal) => { signal = rpcSignal; return result.promise },
    }))
    await controller.reload()
    let notifications = 0
    controller.subscribe(() => { notifications += 1 })
    const running = controller.testAccount('account-a')
    const before = notifications

    controller.dispose()
    expect(signal?.aborted).toBe(true)
    result.resolve({ ok: true, value: accountSummary('buddy', 'account-a', { status: 'reauth_required' }) })
    await running

    expect(notifications).toBe(before)
    expect(controller.getSnapshot().accounts).toEqual([a])
    expect(controller.getSnapshot().current).toEqual(a)
  })

  it('RPC 失败、错账号/错渠道/夹带秘密的回包均不发布状态，显示 testFailed', async () => {
    const a = accountSummary('buddy', 'account-a')
    const b = accountSummary('buddy', 'account-b')
    const invalidResults: unknown[] = [
      failure,
      { ok: true, value: b },
      { ok: true, value: accountSummary('qoder', 'account-a') },
      { ok: true, value: { ...a, accessToken: 'CLIENT_SECRET_SENTINEL' } },
    ]
    for (const value of invalidResults) {
      const { controller } = createController(routeAccounts({
        'accounts.list': () => ({ ok: true, value: [a, b] }),
        'accounts.current': () => ({ ok: true, value: a }),
        'accounts.test': () => value as RpcResult<AccountSummary>,
      }))
      await controller.reload()
      await controller.testAccount('account-a')
      expect(controller.getSnapshot()).toMatchObject({
        accounts: [a, b], current: a, busyAccountId: null,
        error: 'channel.accounts.testFailed',
      })
      expect(JSON.stringify(controller.getSnapshot())).not.toContain('CLIENT_SECRET_SENTINEL')
      controller.dispose()
    }
  })
})
