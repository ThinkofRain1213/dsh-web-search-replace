/**
 * Client 半体：把「Web Search Replacement」设置卡注册进 Plugins 页面的
 * `plugins.bundle.config` 槽位（key = 包名）。
 *
 * 本文件不导入任何 Harness Client 包的值（只允许 `import type`），
 * React 由页面模块表提供；设置值来自服务作用域注入的 `configForms`，
 * 写入走共享 `settings.update` RPC。
 */

import type { ManagementRpcConnection } from '../shared/rpc.ts'
import { SettingsCard } from './SettingsCard.tsx'
import { NS, PACKAGE_NAME } from './constants.ts'
import type { ConfigFormsLike } from './controllers/settings.ts'
import { en, zh } from './locales.ts'

export { NS, PACKAGE_NAME } from './constants.ts'

/**
 * Client 模块运行时依赖的服务。
 *
 * 只声明 apply 自己直接使用的 `slots`/`locale`；设置卡的 `configForms` 与
 * `connection` 通过 `ctx.inject` 服务作用域注入——直接捕获插件上下文的
 * 属性既不保证就绪，也不会随服务替换重新求值。
 */
export const inject = ['slots', 'locale'] as const

/** Client 侧 locale 服务的最小面。 */
export interface ClientLocaleService {
  /**
   * 注册命名空间的中英文字典。
   * @param namespace - 命名空间 id。
   * @param dictionaries - 至少包含中英文的扁平字典。
   * @returns 幂等 disposer。
   */
  register(namespace: string, dictionaries: Record<'zh' | 'en', Record<string, string>>): () => void
  /**
   * 绑定命名空间的翻译函数。
   * @param namespace - 命名空间 id。
   * @returns 在调用时读取当前 locale 的翻译函数。
   */
  bind(namespace: string): (key: string) => string
}

/** Client 侧 slot 服务的最小面。 */
export interface ClientSlotsService {
  /**
   * 等待目标槽位可用后执行注册。
   * @param name - 槽位名。
   * @param callback - 返回 disposer 的注册回调。
   */
  inject(name: string, callback: () => unknown): unknown
  /**
   * 注册一个槽位条目。
   * @param options - 槽位条目选项（name、keyed 槽位的 key、locale 与注入面）。
   * @param component - 渲染该条目的组件。
   * @returns 幂等 disposer。
   */
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** 服务作用域：`inject` 保证的两项服务，以及继承自插件上下文的 slots/locale。 */
export interface ClientServiceScope {
  /**
   * 注册随服务作用域生命周期释放的资源。
   * @param callback - 返回 disposer 的回调。
   * @param label - 诊断标签。
   */
  effect(callback: () => unknown, label?: string): unknown
  /** 宿主 locale 服务（继承自插件上下文）。 */
  readonly locale: ClientLocaleService
  /** 宿主槽位服务（继承自插件上下文）。 */
  readonly slots: ClientSlotsService
  /** 已就绪的宿主 configForms 服务；读取设置快照的唯一入口。 */
  readonly configForms: ConfigFormsLike
  /** 已就绪的宿主 Connection；写入共享 settings RPC。 */
  readonly connection: ManagementRpcConnection
}

/** Client 插件上下文的最小面。 */
export interface ClientContext {
  /**
   * 注册随插件生命周期释放的资源。
   * @param callback - 返回 disposer 的回调。
   * @param label - 诊断标签。
   */
  effect(callback: () => unknown, label?: string): unknown
  /**
   * 等待依赖服务就绪后，在其子作用域中执行（Cordis `ctx.inject`）。
   *
   * 依赖缺失时不执行；服务提供者被替换或卸载时旧作用域释放、回调在新作用域
   * 重跑，因此回调内读到的服务在该作用域生命周期内始终可用。
   * @param deps - 依赖的服务名。
   * @param callback - 服务就绪后执行的回调，参数为服务作用域。
   */
  inject(deps: readonly string[], callback: (scope: ClientServiceScope) => void): unknown
  /** 宿主 locale 服务。 */
  readonly locale: ClientLocaleService
  /** 宿主槽位服务。 */
  readonly slots: ClientSlotsService
}

/**
 * 注册字典与设置卡。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-search-replace: dictionaries')
  const t = ctx.locale.bind(NS)
  // configForms/connection 只在服务作用域内读取并捕获：Cordis 保证两项服务
  // 在该作用域生命周期内就绪；任一提供者替换或卸载时整张卡片随之重建。
  ctx.inject(['configForms', 'connection'], (scope) => {
    const configForms = scope.configForms
    const connection = scope.connection
    scope.effect(
      () => scope.slots.inject('plugins.bundle.config', () => scope.slots.register({
        name: 'plugins.bundle.config',
        key: PACKAGE_NAME,
        locale: NS,
        inject: () => ({
          t,
          configForms,
          connection,
        }),
      }, SettingsCard)),
      'dsh-web-search-replace: plugins-page card',
    )
  })
}
