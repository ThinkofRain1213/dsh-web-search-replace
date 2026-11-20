/**
 * Client 半体：把「网页搜索渠道」设置卡注册进 Plugins 页面的
 * `plugins.bundle.config` 槽位（key = 包名）。
 *
 * 本文件不导入任何 Harness Client 包的值（只允许 `import type`），
 * React 由页面模块表提供；设置值来自 `ctx.configForms`，写入走共享
 * `settings.update` RPC。
 */

import type { ManagementRpcConnection } from '../shared/rpc.ts'
import { SettingsCard } from './SettingsCard.tsx'
import { NS, PACKAGE_NAME } from './constants.ts'
import type { ConfigFormsLike } from './controllers/settings.ts'
import { en, zh } from './locales.ts'

export { NS, PACKAGE_NAME } from './constants.ts'

/** Client 模块运行时依赖的服务。 */
export const inject = ['slots', 'locale', 'configForms', 'connection'] as const

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

/** Client 插件上下文的最小面。 */
export interface ClientContext {
  /**
   * 注册随插件生命周期释放的资源。
   * @param callback - 返回 disposer 的回调。
   * @param label - 诊断标签。
   */
  effect(callback: () => unknown, label?: string): unknown
  /** 宿主 locale 服务。 */
  readonly locale: ClientLocaleService
  /** 宿主槽位服务。 */
  readonly slots: ClientSlotsService
  /** 宿主 configForms 服务；读取设置快照的唯一入口。 */
  readonly configForms?: ConfigFormsLike | undefined
  /** 宿主 Connection；写入共享 settings RPC。 */
  readonly connection?: ManagementRpcConnection | undefined
}

/**
 * 注册字典与设置卡。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-search-channels: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(
    () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: PACKAGE_NAME,
      locale: NS,
      inject: () => ({
        t,
        configForms: ctx.configForms,
        connection: ctx.connection,
      }),
    }, SettingsCard)),
    'dsh-web-search-channels: plugins-page card',
  )
}
