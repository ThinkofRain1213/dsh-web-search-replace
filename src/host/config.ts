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
import { QODER_RUNTIME_HOSTS, type QoderRuntimeHost } from '../shared/runtime.ts'

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
    /** Host-only 全局路由状态；绝不进入 SearchSettingsSnapshot。 */
    readonly lastSuccessfulHost: VolatileConfigValue<QoderRuntimeHost | null>
  }
  readonly qodercn: { readonly currentAccountId: VolatileConfigValue<string | null> }
}

/**
 * 允许为 null 的字符串账号 ID。
 *
 * Schemastery 把 `null` 也视为可空，`.default(null)` 会被当作「没有默认值」
 * 而对缺失值返回 `undefined`。这里用一个非空哨兵默认值触发 transform，再
 * 把哨兵归一化为 `null`，保证快照中的 `currentAccountId` 精确为 `null`。
 */
const nullableAccountId = () => Schema.transform(
  Schema.union([Schema.string(), Schema.const(null)]),
  (value: string | null | undefined) => value === undefined || value === '' ? null : value,
).default('').volatile()

/** 最近成功域只接受两个国际版 host；空哨兵仅用于表达缺省 null。 */
const nullableLastSuccessfulHost = () => Schema.transform(
  Schema.union([
    ...QODER_RUNTIME_HOSTS.map(host => Schema.const(host)),
    Schema.const(null),
    Schema.const(''),
  ]),
  (value: QoderRuntimeHost | '' | null | undefined) => value === undefined || value === '' ? null : value,
).default('').volatile()

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
    lastSuccessfulHost: nullableLastSuccessfulHost(),
  }),
  qodercn: Schema.object({
    currentAccountId: nullableAccountId(),
  }),
})
