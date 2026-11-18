/**
 * Host 半体：0.1.0 在骨架之上注册普通设置服务与管理 RPC。
 *
 * 本任务不接管 `web_search`、不实现 Fetch、不保存 token，也不开放 Agent tool；
 * 这些能力由后续任务在稳定骨架上扩展。
 */
import type { ManagementRpcConnection } from '../shared/rpc.ts'
import { Config, type SearchConfig } from './config.ts'
import { registerManagementRpc } from './rpc.ts'
import { SettingsService, type SettingsConfigEditor } from './settings/service.ts'

export { Config }

/** 本插件依赖的 Cordis 服务。 */
export const inject = ['connection', 'configEditor']

/** Host `apply` 使用的最小上下文结构。 */
export interface HostContext {
  readonly connection: ManagementRpcConnection
  readonly configEditor: SettingsConfigEditor
  readonly fiber: { readonly entry: unknown }
  effect(execute: () => (() => Promise<void>), label?: string): unknown
}

/**
 * 注册普通设置服务和管理 RPC。
 *
 * @param ctx - Cordis 插件上下文。
 * @param config - 插件行的有效配置（可热修改字段为稳定 volatile 引用）。
 */
export function apply(ctx: HostContext, config: SearchConfig): void {
  const settings = new SettingsService({
    configEditor: ctx.configEditor,
    entry: ctx.fiber.entry,
    config,
  })
  ctx.effect(
    () => registerManagementRpc(ctx.connection, settings),
    'web-search-channels: management RPC',
  )
}
