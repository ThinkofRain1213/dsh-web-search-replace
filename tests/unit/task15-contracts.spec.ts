/**
 * Task 15 切片 1：真实共享合同与 Host 边界。
 *
 * 每个用例都对应一个可观察的错误实现：把持久路由泄露到 Client、卸载后继续
 * configEditor 写入、错渠道 flow 在工作后才被发现、legacy RPC 绕过记录检查、
 * runtime DTO 不存在，以及 caller abort 覆盖不到首次凭据解析。
 */
import { describe, expect, it } from 'vitest'

import { BuddyAuthFlow } from '../../src/host/channels/buddy/auth.ts'
import * as authRpc from '../../src/host/channels/auth-rpc.ts'
import { QoderInternationalAuthFlow } from '../../src/host/channels/qoder/auth.ts'
import { handleManagementRpcRequest } from '../../src/host/rpc.ts'
import { SettingsService } from '../../src/host/settings/service.ts'
import type { AccountCredentialProvider } from '../../src/host/accounts/store.ts'
import type { SettingsConfigEditor } from '../../src/host/settings/service.ts'
import type { AuthChannel, AuthFlowPort, AuthFlowStatus } from '../../src/shared/auth.ts'
import { MANAGEMENT_RPC_ENDPOINT } from '../../src/shared/rpc.ts'
import { callManagementRpc } from '../../src/shared/rpc.ts'
import { Config } from '../../src/host/config.ts'
import { createAccountFixture } from './support/account-fixture.ts'
import { createSettingsDouble } from './support/settings-double.ts'

// 类型门禁由 `pnpm typecheck` 执行；运行测试仍验证下面的实际行为。
type IsAny<T> = 0 extends (1 & T) ? true : false
const credentialReadIsNotAny: IsAny<ReturnType<AccountCredentialProvider['readRecord']>> = false
const configEntryIsNotAny: IsAny<Parameters<SettingsConfigEditor['edit']>[0]> = false
void credentialReadIsNotAny
void configEntryIsNotAny

function createService() {
  const double = createSettingsDouble()
  const service = new SettingsService({
    configEditor: double.editor,
    entry: { id: 'dsh-web-search-replace' } as never,
    config: double.config,
  })
  return { service, double }
}

function flowStatus(channel: AuthChannel): AuthFlowStatus {
  return {
    flowId: 'flow-1',
    channel,
    status: 'pending',
    authUrl: null,
    displayHint: '',
    account: null,
    errorCode: null,
  }
}

function makeFlow(channel: AuthChannel, calls: string[]): AuthFlowPort {
  return {
    channel,
    async start() { calls.push(`${channel}:start`); return flowStatus(channel) },
    async cancel(flowId: string) { calls.push(`${channel}:cancel:${flowId}`); return flowStatus(channel) },
    async status(flowId: string) { calls.push(`${channel}:status:${flowId}`); return flowStatus(channel) },
    async refresh() { calls.push(`${channel}:refresh`); throw new Error('not used') },
  } as AuthFlowPort
}

describe('R44 Host 全局路由状态与普通设置快照隔离', () => {
  it('导出 Config 不含 lastSuccessfulHost，普通快照只含批准字段', () => {
    const config = Config({}) as any
    expect(config.qoder.lastSuccessfulHost).toBeUndefined()
    const { service } = createService()
    expect(service.getSnapshot().qoder).toEqual({
      currentAccountId: null,
      endpointPreference: 'auto',
    })
    expect(JSON.stringify(service.getSnapshot())).not.toContain('lastSuccessfulHost')
  })

  it('updateSearch 在 configEditor change callback 内响应 abort', async () => {
    const { service, double } = createService()
    const controller = new AbortController()
    const originalEdit = double.editor.edit.bind(double.editor)
    double.editor.edit = async (_entry, change) => {
      controller.abort()
      return await originalEdit(_entry, change)
    }
    await expect(service.updateSearch({ enabled: true }, controller.signal)).rejects.toMatchObject({
      code: 'settings/cancelled',
    })
    expect(double.edits).toHaveLength(0)
  })
})

describe('AuthFlowPort.channel 与 registry 在任何工作前 fail closed', () => {
  it('dispatcher 在 flow.start 前拒绝 buddy→workbuddy 错接', async () => {
    const calls: string[] = []
    const flow = makeFlow('workbuddy', calls)
    await expect(authRpc.dispatchChannelAuthRpc(
      flow,
      'buddy',
      'auth.start',
      { channel: 'buddy' },
      () => { throw new Error('must not reach internal error factory') },
    )).rejects.toMatchObject({ code: 'auth/invalid' })
    expect(calls).toEqual([])
  })

  it('根 registry 恰好四渠道，拒绝错 key、缺/多 key 与同实例双注册', () => {
    const createRegistry = (authRpc as any).createAuthFlowRegistry
    expect(typeof createRegistry).toBe('function')
    const calls: string[] = []
    const flows = {
      buddy: makeFlow('buddy', calls),
      workbuddy: makeFlow('workbuddy', calls),
      qoder: makeFlow('qoder', calls),
      qodercn: makeFlow('qodercn', calls),
    }
    expect(createRegistry(flows)).toEqual(flows)
    expect(() => createRegistry({ ...flows, buddy: flows.workbuddy })).toThrow(/channel|渠道/i)
    expect(() => createRegistry({ buddy: flows.buddy })).toThrow(/four|四|channel|渠道/i)
    expect(() => createRegistry({ ...flows, extra: makeFlow('buddy', calls) })).toThrow(/key|channel|渠道/i)
    expect(() => createRegistry({ ...flows, workbuddy: flows.buddy })).toThrow(/instance|实例|channel|渠道/i)
    expect(calls).toEqual([])
  })
})

describe('legacy settings.setCurrentAccount 与 runtime.get 共享合同', () => {
  it('账号服务缺失时 legacy RPC 返回 bad-request，不能写 raw intent', async () => {
    const { service, double } = createService()
    const request = new Request('http://127.0.0.1/api/web-search-replace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'legacy-1',
        method: MANAGEMENT_RPC_ENDPOINT,
        payload: {
          method: 'settings.setCurrentAccount',
          payload: { channel: 'buddy', accountId: 'missing-account' },
        },
      }),
    })
    const response = await handleManagementRpcRequest(service, request)
    const body = await response.json() as any
    expect(body.result.ok).toBe(false)
    expect(body.result.error.code).toBe('bad-request')
    expect(double.edits).toHaveLength(0)
  })

  it('runtime.get 只接受空对象并返回严格三字段 runtime DTO', async () => {
    const calls: unknown[] = []
    const connection = {
      fetch: { register: () => { throw new Error('not used') } },
      rpc: {
        call: async (...args: unknown[]) => {
          calls.push(args)
          return {
            ok: true,
            value: {
              activationId: 'activation-a',
              revision: 3,
              qoder: { autoActualHost: 'center.qoder.sh' },
            },
          }
        },
      },
    } as any
    const result = await callManagementRpc(connection, 'runtime.get', {})
    expect(result).toEqual({
      ok: true,
      value: {
        activationId: 'activation-a',
        revision: 3,
        qoder: { autoActualHost: 'center.qoder.sh' },
      },
    })
    expect(calls).toHaveLength(1)
    expect(() => callManagementRpc(connection, 'runtime.get', {
      accountId: 'must-not-be-accepted',
    } as never)).toThrow(/runtime\.get|payload/i)
  })
})

describe('runWithAuthRetry caller signal 覆盖首次 credential resolve', () => {
  it('CodeBuddy：挂起 resolve 时 caller abort 立即收口且不启动 operation', async () => {
    const fixture = createAccountFixture()
    const account = await fixture.store.saveAccount({
      channel: 'buddy', vendorAccountId: 'retry-caller', secret: { accessToken: 'A', refreshToken: 'R' },
    })
    const flow = new BuddyAuthFlow({
      store: fixture.store,
      accounts: fixture.service,
      fetcher: async () => { throw new Error('unexpected network') },
      verifyCapability: async () => {},
    })
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const read = fixture.store.readEntry.bind(fixture.store)
    let blocked = true
    fixture.store.readEntry = async (channel, accountId) => {
      if (blocked) {
        blocked = false
        entered()
        await gate
      }
      return await read(channel, accountId)
    }
    const controller = new AbortController()
    let operations = 0
    const running = (flow.runWithAuthRetry as any)(account.accountId, async () => {
      operations += 1
    }, controller.signal) as Promise<unknown>
    await enteredPromise
    controller.abort()
    try {
      const outcome = await Promise.race([
        running.then(() => 'resolved', (error: unknown) => error),
        new Promise<string>((resolve) => { setTimeout(() => resolve('still-pending'), 30) }),
      ])
      expect(outcome).not.toBe('still-pending')
      expect(operations).toBe(0)
    } finally {
      release()
      await running.catch(() => {})
    }
  })

  it('Qoder：挂起 resolve 时 caller abort 立即收口且不启动 operation', async () => {
    const fixture = createAccountFixture()
    const account = await fixture.store.saveAccount({
      channel: 'qoder',
      vendorAccountId: 'retry-caller',
      secret: { securityOauthToken: 'A', machineId: 'M', refreshToken: 'R' },
    })
    const flow = new QoderInternationalAuthFlow({
      store: fixture.store,
      accounts: fixture.service,
      fetcher: async () => { throw new Error('unexpected network') },
      verifyCapability: async () => {},
    })
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const read = fixture.store.readEntry.bind(fixture.store)
    let blocked = true
    fixture.store.readEntry = async (channel, accountId) => {
      if (blocked) {
        blocked = false
        entered()
        await gate
      }
      return await read(channel, accountId)
    }
    const controller = new AbortController()
    let operations = 0
    const running = (flow.runWithAuthRetry as any)(account.accountId, async () => {
      operations += 1
    }, controller.signal) as Promise<unknown>
    await enteredPromise
    controller.abort()
    try {
      const outcome = await Promise.race([
        running.then(() => 'resolved', (error: unknown) => error),
        new Promise<string>((resolve) => { setTimeout(() => resolve('still-pending'), 30) }),
      ])
      expect(outcome).not.toBe('still-pending')
      expect(operations).toBe(0)
    } finally {
      release()
      await running.catch(() => {})
    }
  })
})
