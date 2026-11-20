/**
 * 插件普通配置的 Cordis/Schemastery 模式。
 *
 * 只有可热修改的叶子字段声明为 volatile；执行与快照都通过稳定的
 * `Volatile.get()` 引用读取，因此配置保存后下一次调用能看到新值，而
 * 不需要重载插件。秘密永远不进入这里。
 */
import Schema from '@deepseek-ai/schemastery'

import {
  CHANNEL_IDS,
  QODER_ENDPOINT_PREFERENCES,
  type ChannelId,
  type QoderEndpointPreference,
} from '../shared/channels.ts'
import {
  DEFAULT_QODER_ENDPOINT_PREFERENCE,
  DEFAULT_SEARCH_CHANNEL,
  DEFAULT_SEARCH_ENABLED,
} from '../shared/contracts.ts'

/** 稳定的不可变配置引用；结构上与 Cordis 的 `Volatile<T>` 一致。 */
export interface VolatileConfigValue<T> {
  get(): T
}

/** `apply` 收到的有效配置：每个可热修改字段都是稳定引用。 */
export interface SearchConfig {
  readonly search: {
    readonly enabled: VolatileConfigValue<boolean>
    readonly channel: VolatileConfigValue<ChannelId>
  }
  readonly buddy: { readonly currentAccountId: VolatileConfigValue<string | null> }
  readonly workbuddy: { readonly currentAccountId: VolatileConfigValue<string | null> }
  readonly qoder: {
    readonly currentAccountId: VolatileConfigValue<string | null>
    readonly endpointPreference: VolatileConfigValue<QoderEndpointPreference>
  }
  readonly qodercn: { readonly currentAccountId: VolatileConfigValue<string | null> }
}

/**
 * 允许为 null 的字符串账号 ID。
 *
 * 不要用 `Schema.transform` 归一化 `undefined`：Host `settings.describe` 会
 * 经过 `volatileForm` 的 `new Schema(schema.toJSON())` 重建后再次序列化，
 * callback 此时被 JSON 丢弃，客户端反序列化后 validate 会得到
 * “callback is not a function”，整张设置卡永远 loading。
 *
 * 这里只声明普通 string/null 联合：显式 null 保持 null；缺省值按 Schemastery
 * 语义得到 undefined，由 Host 快照读取用 `?? null` 归一化。
 */
const nullableAccountId = () =>
  Schema.union([Schema.string(), Schema.const(null)]).default(null).volatile()

/**
 * 插件行配置。
 *
 * `endpointPreference` 只存在于 `qoder`，另外三个渠道没有该字段。
 */
export const Config = Schema.object({
  search: Schema.object({
    enabled: Schema.boolean().default(DEFAULT_SEARCH_ENABLED).volatile(),
    channel: Schema.union([...CHANNEL_IDS]).default(DEFAULT_SEARCH_CHANNEL).volatile(),
  }),
  buddy: Schema.object({
    currentAccountId: nullableAccountId(),
  }),
  workbuddy: Schema.object({
    currentAccountId: nullableAccountId(),
  }),
  qoder: Schema.object({
    currentAccountId: nullableAccountId(),
    endpointPreference: Schema.union([...QODER_ENDPOINT_PREFERENCES])
      .default(DEFAULT_QODER_ENDPOINT_PREFERENCE)
      .volatile(),
  }),
  qodercn: Schema.object({
    currentAccountId: nullableAccountId(),
  }),
})
