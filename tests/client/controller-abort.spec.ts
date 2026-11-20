/** R41/R33：Client 每个 RPC 的取消与独立 best-effort cancel。 */
import { describe, expect, it } from 'vitest'

import { AccountsController } from '../../src/client/controllers/accounts.ts'
import { SettingsController } from '../../src/client/controllers/settings.ts'
import {
  createConfigFormsDouble,
  createConnectionDouble,
  deferred,
  makeSnapshot,
} from './support/settings-harness.ts'

describe('Client RPC abort/dispose', () => {
  it('Settings dispose abort 已开始 settings.update，迟到回包仍被丢弃', async () => {
    const before = makeSnapshot()
    const after = makeSnapshot({ enabled: true })
    const { configForms } = createConfigFormsDouble(before)
    const response = deferred<{ ok: true; value: typeof after }>()
    const rpc = createConnectionDouble(() => response.promise)
    const controller = new SettingsController({ configForms, connection: rpc.connection })
    const writing = controller.setEnabled(true)
    expect(rpc.signalCalls[0]?.method).toBe('settings.update')
    expect(rpc.signalCalls[0]?.signal?.aborted).toBe(false)

    controller.dispose()
    expect(rpc.signalCalls[0]?.signal?.aborted).toBe(true)
    response.resolve({ ok: true, value: after })
    await writing
    expect(controller.getSnapshot().enabled).toBe(false)
  })

  it('Accounts dispose abort 已开始 list/current RPC', async () => {
    const rpc = createConnectionDouble((_call, signal) => new Promise<never>((_resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return }
      signal?.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    }))
    const controller = new AccountsController({ channel: 'buddy', connection: rpc.connection })
    const loading = controller.reload()
    expect(rpc.signalCalls[0]?.method).toBe('accounts.list')

    controller.dispose()
    expect(rpc.signalCalls[0]?.signal?.aborted).toBe(true)
    expect(await loading).toBe(false)
  })

  it('dispose 的 best-effort auth.cancel 使用独立 signal，at-most-once 且不被抢先 abort', async () => {
    const account = {
      id: 'account-a', displayName: 'A', channelId: 'buddy', endpointLabel: 'copilot.tencent.com',
      status: 'ready', maskedIdentifier: 'a***a',
    } as const
    const rpc = createConnectionDouble((call) => {
      if (call.method === 'accounts.list') return { ok: true, value: [account] }
      if (call.method === 'accounts.current') return { ok: true, value: account }
      if (call.method === 'auth.start') {
        return {
          ok: true,
          value: {
            flowId: 'flow-dispose', channel: 'buddy', status: 'pending',
            authUrl: 'https://www.codebuddy.cn/login/?platform=ide&state=state',
            displayHint: '', account: null, errorCode: null,
          },
        }
      }
      if (call.method === 'auth.cancel') {
        return {
          ok: true,
          value: {
            flowId: 'flow-dispose', channel: 'buddy', status: 'cancelled',
            authUrl: null, displayHint: '', account: null, errorCode: 'auth/cancelled',
          },
        }
      }
      return new Promise(() => {})
    })
    const controller = new AccountsController({ channel: 'buddy', connection: rpc.connection })
    await controller.reload()
    await controller.startAuth()
    controller.dispose()
    controller.dispose()

    const cancels = rpc.signalCalls.filter(call => call.method === 'auth.cancel')
    expect(cancels).toHaveLength(1)
    expect(cancels[0]?.signal?.aborted).toBe(false)
  })
})
