/** Host 根组合：一次 activation、一个 effect、一个生命周期协调器。 */
import type { ManagementRpcConnection } from '../shared/rpc.ts'
import { Config, type SearchConfig } from './config.ts'
import { registerManagementRpc } from './rpc.ts'
import {
  SettingsService,
  type SettingsConfigEditor,
  type SettingsServiceOptions,
} from './settings/service.ts'
import { AccountStore, type AccountCredentialProvider } from './accounts/store.ts'
import { AccountService } from './accounts/service.ts'
import { PluginLifecycle } from './lifecycle.ts'
import { RuntimeObservationStore } from './runtime.ts'
import { acquireQoderWasmOwnerLease } from './channels/qoder/signer.ts'
import { BuddyAuthFlow } from './channels/buddy/auth.ts'
import { WorkbuddyAuthFlow } from './channels/workbuddy/auth.ts'
import { QoderInternationalAuthFlow } from './channels/qoder/auth.ts'
import { QoderCnAuthFlow } from './channels/qodercn/auth.ts'
import { createChannelCapabilityVerifiers } from './channels/capability.ts'
import { createAuthFlowRegistry } from './channels/auth-rpc.ts'
import { createInvocationDriverFactory } from './accounts/invocation.ts'
import { installSearchOverride, type SearchOverrideExecution, type SearchOverrideToolResult } from './tools/execute-listener.ts'

export { Config }
export { createRuntimeObservationStore } from './runtime.ts'

/** 本插件依赖的 Cordis 服务。 */
export const inject = ['connection', 'configEditor', 'credentials', 'tools']

/** Host `apply` 使用的真实服务与最小 Cordis 事件面。 */
export interface HostContext {
  readonly connection: ManagementRpcConnection
  readonly configEditor: SettingsConfigEditor
  readonly credentials: AccountCredentialProvider
  readonly fiber: { readonly entry: unknown }
  /** 测试只通过注入 fetcher 替换厂商边界；生产不提供时使用全局 fetch。 */
  readonly fetcher?: typeof fetch
  readonly activationId?: string
  on(
    name: 'tools/execute',
    listener: (
      exec: SearchOverrideExecution,
      next: () => Promise<SearchOverrideToolResult>,
    ) => Promise<SearchOverrideToolResult>,
  ): unknown
  on(name: 'loader/volatile-update', listener: () => void): unknown
  effect(
    execute: () => Promise<() => Promise<void>> | (() => Promise<void>) | void,
    label?: string,
  ): unknown
}

export function apply(ctx: HostContext, config: SearchConfig): void {
  const entry = ctx.fiber.entry
  if (!isLoaderEntry(entry)) {
    throw new TypeError('web-search-channels requires the active Loader entry')
  }

  // 构造顺序严格保持：lifecycle → settings → accounts → runtime/WASM →
  // flows → activation drivers → invocation facade → subscriptions/RPC/override。
  const lifecycle = new PluginLifecycle()
  const settings = new SettingsService({
    configEditor: ctx.configEditor,
    entry: entry as SettingsServiceOptions['entry'],
    config,
  })
  const store = new AccountStore({ credentials: ctx.credentials })
  const accounts = new AccountService({ store, settings })
  const runtime = new RuntimeObservationStore(ctx.activationId ?? globalThis.crypto.randomUUID())
  const wasmLease = acquireQoderWasmOwnerLease()
  const verifiers = createChannelCapabilityVerifiers({
    ...ctx.fetcher === undefined ? {} : { fetcher: ctx.fetcher },
    getEndpointPreference: () => settings.getSnapshot().qoder.endpointPreference,
    readLastSuccessfulHost: () => settings.getLastSuccessfulHost(),
    writeLastSuccessfulHost: async (host, signal) => {
      await settings.updateLastSuccessfulHost(host, signal)
    },
  })
  const flows = {
    buddy: new BuddyAuthFlow({ store, accounts, ...fetcherOption(ctx), verifyCapability: verifiers.buddy }),
    workbuddy: new WorkbuddyAuthFlow({ store, accounts, ...fetcherOption(ctx), verifyCapability: verifiers.workbuddy }),
    qoder: new QoderInternationalAuthFlow({ store, accounts, ...fetcherOption(ctx), verifyCapability: verifiers.qoder }),
    qodercn: new QoderCnAuthFlow({ store, accounts, ...fetcherOption(ctx), verifyCapability: verifiers.qodercn }),
  }
  const authFlows = createAuthFlowRegistry(flows)
  const drivers = createInvocationDriverFactory({
    flows,
    ...fetcherOption(ctx),
    readLastSuccessfulHost: () => settings.getLastSuccessfulHost(),
    writeLastSuccessfulHost: async (host, signal, selection) => {
      if (selection !== undefined) {
        const snapshot = settings.getSnapshot()
        if (snapshot.qoder.endpointPreference !== 'auto') return
        if (runtime.captureSelection(snapshot) !== selection.selectionGeneration) return
      }
      await settings.updateLastSuccessfulHost(host, signal)
    },
    onObservation: (observation, selection) => {
      runtime.observe(selection, settings.getSnapshot(), observation)
    },
  })

  ctx.effect(async () => {
    let disposed = false
    let registration: ReturnType<typeof registerManagementRpc> | undefined
    let routeReady: Promise<void> | undefined
    let removeOverride = () => {}
    let unsubscribe = () => {}
    const cleanup = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      // 1) 同步停止接单；2) 同步撤销入口；3) 同步 abort 全部来源；
      // 4) await 全部 settle；5) 最后释放 WASM/状态。注册失败也走同一路径。
      lifecycle.stopAccepting()
      removeOverride()
      unsubscribe()
      const routeDisposal = registration?.()
      const lifecycleDisposal = lifecycle.abortAllAndSettle()
      const flowDisposals = Object.values(flows).map(flow => flow.dispose())
      await Promise.allSettled([
        ...routeReady === undefined ? [] : [routeReady],
        ...routeDisposal === undefined ? [] : [routeDisposal],
        lifecycleDisposal,
        ...flowDisposals,
      ])
      await wasmLease.dispose()
      runtime.dispose()
    }
    try {
      unsubscribe = asDisposer(ctx.on('loader/volatile-update', () => {
        const snapshot = settings.refreshFromVolatile()
        runtime.captureSelection(snapshot)
      }))
      registration = registerManagementRpc(
        ctx.connection,
        settings,
        accounts,
        authFlows,
        {
          lifecycle,
          runtime: {
            getSnapshot: () => {
              runtime.captureSelection(settings.getSnapshot())
              return runtime.getSnapshot()
            },
          },
        },
      )
      routeReady = lifecycle.track(registration.ready)
      await routeReady
      removeOverride = installSearchOverride(ctx, {
        settings,
        drivers,
        lifecycle,
        runtime,
      })
      return cleanup
    } catch (error) {
      await cleanup()
      throw error
    }
  }, 'web-search-channels: activation')
}

function fetcherOption(ctx: HostContext): { readonly fetcher?: typeof fetch } {
  return ctx.fetcher === undefined ? {} : { fetcher: ctx.fetcher }
}

function asDisposer(registration: unknown): () => void {
  return () => {
    if (typeof registration === 'function') (registration as () => void)()
  }
}

function isLoaderEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as { options?: unknown; fiber?: unknown }
  if (typeof entry.options !== 'object' || entry.options === null) return false
  if (typeof entry.fiber !== 'object' || entry.fiber === null) return false
  const options = entry.options as { id?: unknown; name?: unknown }
  return typeof options.id === 'string' && options.id.length > 0
    && typeof options.name === 'string' && options.name.length > 0
}
