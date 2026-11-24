/**
 * 真实启用崩溃回归：Host apply 在真实 Cordis fiber 上下文中必须自给自足。
 *
 * 崩溃日志 `cannot get property "activationId" without inject` 的边界只有真实
 * Cordis 上下文能复现：plain object 读缺失属性得到 undefined，而真实 plugin
 * fiber 会直接抛错。本文件用 `tests/integration/cordis-host.fixture.ts` 的最小
 * 宿主（真实 Context/Fiber + Loader entry 形状 + 注入服务），不启动真实 DSH。
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { __testing as signerTesting } from '../../src/host/channels/qoder/signer.ts'
import {
  ACCOUNT_CREDENTIAL_SCOPE,
  LEGACY_ACCOUNT_CREDENTIAL_SCOPE,
} from '../../src/host/accounts/store.ts'
import { createCordisHost, type HostApply } from './cordis-host.fixture.ts'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => {
  vi.doUnmock('../../src/host/channels/auth-rpc.ts')
  vi.resetModules()
})

describe('真实 Cordis 宿主上的 Host activation', () => {
  it('未注入的 activationId 在真实 Cordis fiber 上读取即抛 missing-inject', async () => {
    const root = new Context()
    let observed: unknown
    const fiber = root.plugin({
      inject: [],
      apply(ctx: Context) {
        try {
          // 真实 Cordis 代理在读取未声明属性时抛 missing-inject；类型层面故意绕过声明。
          void (ctx as unknown as Record<string, unknown>)['activationId']
        } catch (error) {
          observed = error
        }
      },
    })
    await fiber

    expect(observed).toBeInstanceOf(Error)
    expect((observed as Error).message).toBe('cannot get property "activationId" without inject')
    await fiber.dispose()
  })

  it('宿主未提供 activationId 服务时 apply 可启动，runtime.get 返回本代唯一 UUID', async () => {
    const host = createCordisHost()
    await host.activation

    const response = await host.runtimeGet()
    expect(response.result).toMatchObject({
      ok: true,
      value: { qoder: { autoActualHost: null } },
    })
    // 首次读取会捕获当前选择，因此本代第一个快照 revision 为 1。
    expect(response.result.value.revision).toBe(1)
    expect(response.result.value.activationId).toMatch(UUID_V4)

    await host.dispose()
    expect(host.routes.size).toBe(0)
    expect(host.fiber.getEffects()).toEqual([])
    expect(host.fiber.uid).toBeNull()
  })

  it('真实 activation 启动时迁移旧包名 scope，并在注册入口前清除旧记录', async () => {
    const legacyAccountKey = `${LEGACY_ACCOUNT_CREDENTIAL_SCOPE}/buddy-a1234567890ab`
    const legacyRouteKey = `${LEGACY_ACCOUNT_CREDENTIAL_SCOPE}/qoder-last-successful-host`
    const host = createCordisHost({
      seedCredentials(credentials) {
        credentials.seed(legacyAccountKey, {
          kind: 'grant',
          payload: {
            version: 1,
            channelId: 'buddy',
            accountId: 'a1234567890ab',
            vendorAccountId: 'legacy-activation@example.test',
            displayName: 'Legacy activation account',
            maskedIdentifier: 'l***t',
            endpointLabel: 'copilot.tencent.com',
            status: 'ready',
            secret: { accessToken: 'LEGACY_ACTIVATION_TOKEN', refreshToken: 'LEGACY_ACTIVATION_REFRESH' },
          },
        })
        credentials.seed(legacyRouteKey, { kind: 'grant', payload: { host: 'api2.qoder.sh' } })
      },
    })
    await host.activation

    expect([...host.credentials.keys()].sort()).toEqual([
      `${ACCOUNT_CREDENTIAL_SCOPE}/buddy-a1234567890ab`,
      `${ACCOUNT_CREDENTIAL_SCOPE}/qoder-last-successful-host`,
    ].sort())
    expect(host.credentials.keys().some(key => key.startsWith(`${LEGACY_ACCOUNT_CREDENTIAL_SCOPE}/`))).toBe(false)
    await host.dispose()
  })

  it('两次 apply 的 activationId 不同，且各自卸载后无 route/WASM/effect 残留', async () => {
    const first = createCordisHost()
    await first.activation
    const firstSnapshot = (await first.runtimeGet()).result.value
    await first.dispose()

    expect(firstSnapshot.revision).toBe(1)
    expect(firstSnapshot.qoder.autoActualHost).toBeNull()
    expect(first.routes.size).toBe(0)

    const second = createCordisHost()
    await second.activation
    const secondSnapshot = (await second.runtimeGet()).result.value
    expect(secondSnapshot.activationId).toMatch(UUID_V4)
    expect(secondSnapshot.activationId).not.toBe(firstSnapshot.activationId)
    // 新 apply 使用全新 observation store，绝不继承上一代 revision/host。
    expect(secondSnapshot.revision).toBe(1)
    expect(secondSnapshot.qoder.autoActualHost).toBeNull()
    await second.dispose()

    expect(second.routes.size).toBe(0)
    expect(second.fiber.getEffects()).toEqual([])
    expect(second.fiber.uid).toBeNull()
    const stats = (signerTesting as any).wasmOwnerStats()
    expect(stats.activationRefs).toBe(0)
    expect(stats.signerRefs).toBe(0)
    expect(stats.glueResident).toBe(false)
  })

  it('构造中途失败时回滚且无残留，之后同宿主约定下 apply 仍可启动', async () => {
    vi.resetModules()
    vi.doMock('../../src/host/channels/auth-rpc.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/host/channels/auth-rpc.ts')>()
      return {
        ...actual,
        createAuthFlowRegistry: () => {
          throw new Error('injected registry construction failure')
        },
      }
    })
    const [{ apply }, signer] = await Promise.all([
      import('../../src/host/index.ts'),
      import('../../src/host/channels/qoder/signer.ts'),
    ])

    const failed = createCordisHost({ apply: apply as unknown as HostApply })
    await expect(failed.activation).rejects.toThrow('injected registry construction failure')
    expect(failed.routes.size).toBe(0)
    expect(failed.fiber.getEffects()).toEqual([])
    const failedStats = (signer.__testing as any).wasmOwnerStats()
    expect(failedStats.activationRefs).toBe(0)
    expect(failedStats.signerRefs).toBe(0)
    await failed.dispose()

    vi.doUnmock('../../src/host/channels/auth-rpc.ts')
    vi.resetModules()
    const recoveredModule = await import('../../src/host/index.ts')
    const recovered = createCordisHost({ apply: recoveredModule.apply as unknown as HostApply })
    await recovered.activation
    const response = await recovered.runtimeGet()
    expect(response.result.value.activationId).toMatch(UUID_V4)
    await recovered.dispose()
    expect(recovered.routes.size).toBe(0)
  })
})