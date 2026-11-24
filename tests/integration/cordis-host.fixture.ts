/**
 * 最小真实 Cordis 宿主 fixture。
 *
 * 使用运行时真实依赖 `@deepseek-ai/cordis` 4.1.0 的 Context/Fiber，并补上
 * Loader 在真实 entry 上提供的两样东西：
 *
 * 1. `Symbol.for('cordis.entry')` 上下文与 `fiber.entry`；
 * 2. 本插件声明的四个注入服务（connection/configEditor/credentials/tools）。
 *
 * 关键点：apply 运行在真实 plugin fiber 上下文中，因此读取未声明/未注入的
 * 属性会抛 `cannot get property "..." without inject`，而不是像 plain object
 * 测试替身那样静默得到 `undefined`。fixture 不启动 Loader、不读取 profile、
 * 不启动 Electron、不访问网络，也不接触任何真实 DSH 实例。
 */
import { Context } from '@deepseek-ai/cordis'

import type { SearchConfig } from '../../src/host/config.ts'
import {
  apply as productionApply,
  inject,
  type HostContext,
} from '../../src/host/index.ts'
import type { ManagementRpcRoute } from '../../src/shared/rpc.ts'
import { MemoryCredentials } from '../unit/support/memory-credentials.ts'
import { createSettingsDouble } from '../unit/support/settings-double.ts'

/** 真实 Loader 在 entry 上下文上使用的全局键（@deepseek-ai/cordis-plugin-loader）。 */
export const LOADER_ENTRY_KEY = Symbol.for('cordis.entry')

export const HOST_ENTRY_ID = 'dsh-web-search-replace'
export const MANAGEMENT_RPC_PATH = '/api/web-search-replace'

/** 替换插件 apply 的入口；用于构造失败回滚场景。 */
export type HostApply = (ctx: Context, config: SearchConfig) => void | Promise<void>

export interface CordisHostOptions {
  readonly apply?: HostApply
  /** 在 apply 前向内存 credentials 注入历史记录，用于迁移回归。 */
  readonly seedCredentials?: (credentials: MemoryCredentials) => void
}

export interface CordisHost {
  readonly root: Context
  readonly fiber: any
  readonly entry: any
  readonly routes: Map<string, ManagementRpcRoute>
  readonly credentials: MemoryCredentials
  /** 插件启动完成：apply 返回且 route 已注册（含 effect 后续同步注册）。 */
  readonly activation: Promise<void>
  readonly dispose: () => Promise<void>
  readonly runtimeGet: () => Promise<any>
}

/**
 * 创建一个真实 Cordis 的最小宿主并启动本插件 Host 半边。
 *
 * @param options 可替换 apply（默认使用生产 apply）。
 * @returns 宿主观察口；调用方必须 `dispose()` 释放真实 fiber。
 */
export function createCordisHost(options: CordisHostOptions = {}): CordisHost {
  const credentials = new MemoryCredentials()
  options.seedCredentials?.(credentials)
  const double = createSettingsDouble()
  const routes = new Map<string, ManagementRpcRoute>()
  let markRegistered!: () => void
  const registered = new Promise<void>((resolve) => {
    markRegistered = resolve
  })

  const root = new Context()
  root.provide('credentials', credentials)
  root.provide('configEditor', double.editor)
  root.provide('connection', {
    fetch: {
      register(route: ManagementRpcRoute) {
        routes.set(route.path, route)
        markRegistered()
        return async () => {
          routes.delete(route.path)
        }
      },
    },
    rpc: {
      call: async () => {
        throw new Error('fixture 不通过 connection.rpc.call 取数')
      },
    },
  })
  // 生产 apply 只在 inject 中声明依赖；tools 当前未被读取，但必须可解析 fiber 才会激活。
  root.provide('tools', {})

  // Loader entry 的真实形状：apply 的 isLoaderEntry 校验 options.id/name 与 fiber。
  const entry: any = {
    options: { id: HOST_ENTRY_ID, name: HOST_ENTRY_ID, config: {} },
  }

  // Loader 在 internal/plugin 中做的唯一必要动作：在依赖解析/激活前挂上 entry。
  root.on('internal/plugin', (fiber: any) => {
    if (fiber.entry !== undefined) return
    if (fiber.parent[LOADER_ENTRY_KEY] !== entry) return
    fiber.entry = entry
    entry.fiber = fiber
  })

  const entryContext = root.extend({ [LOADER_ENTRY_KEY]: entry })
  const hostApply = options.apply ?? ((ctx: Context, config: SearchConfig) => {
    return productionApply(ctx as unknown as HostContext, config)
  })
  // 始终用非构造的普通调用进入 apply：这样构造失败回滚返回的 rejected promise
  // 会作为启动失败被测试观察，而不是被 `new` 丢弃成异步未处理拒绝。
  const fiber = entryContext.plugin({
    inject,
    apply: (ctx: Context, config: SearchConfig) => hostApply(ctx, config),
  }, double.config)

  const activation = Promise.all([Promise.resolve(fiber), registered])
    .then(() => new Promise<void>((resolve) => { setTimeout(resolve, 0) }))

  const runtimeGet = async (): Promise<any> => {
    const route = routes.get(MANAGEMENT_RPC_PATH)
    if (route === undefined) throw new Error('fixture 管理路由未注册')
    const response = await route.fetch(new Request(`http://local${MANAGEMENT_RPC_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'runtime',
        method: 'web-search-replace',
        payload: { method: 'runtime.get', payload: {} },
      }),
    }))
    return await response.json()
  }

  return {
    root,
    fiber,
    entry,
    routes,
    credentials,
    activation,
    runtimeGet,
    dispose: async () => {
      await fiber.dispose()
    },
  }
}
