/**
 * 设置与管理 RPC 的共享 DTO 与默认值。
 *
 * 快照只包含非秘密用户意图：搜索开关、渠道、四个 currentAccountId 和
 * Qoder 国际版端点偏好。任何 token、刷新材料或签名秘密都不得进入这里。
 */
import {
  isChannelId,
  isQoderEndpointPreference,
  type ChannelId,
  type QoderEndpointPreference,
} from './channels.ts'

/** 搜索设置快照：普通配置的只读投影，也是管理 RPC 的成功结果。 */
export interface SearchSettingsSnapshot {
  readonly search: {
    readonly enabled: boolean
    readonly channel: ChannelId
  }
  readonly buddy: { readonly currentAccountId: string | null }
  readonly workbuddy: { readonly currentAccountId: string | null }
  readonly qoder: {
    readonly currentAccountId: string | null
    readonly endpointPreference: QoderEndpointPreference
  }
  readonly qodercn: { readonly currentAccountId: string | null }
}

/** 平铺的设置补丁；只有明确列出的字段可以被修改。 */
export interface SearchSettingsPatch {
  readonly enabled?: boolean
  readonly channel?: ChannelId
  readonly endpointPreference?: QoderEndpointPreference
}

/** 设置某渠道当前账号的请求；null 表示「暂不指定」。 */
export interface SetCurrentAccountRequest {
  readonly channel: ChannelId
  readonly accountId: string | null
}

/** 默认搜索开关：关闭。 */
export const DEFAULT_SEARCH_ENABLED = false
/** 默认渠道：CodeBuddy。 */
export const DEFAULT_SEARCH_CHANNEL: ChannelId = 'buddy'
/** Qoder 国际版默认端点偏好：自动（初始 center）。 */
export const DEFAULT_QODER_ENDPOINT_PREFERENCE: QoderEndpointPreference = 'auto'

/** 稳定账号 slug：小写字母开头，仅小写字母、数字和连字符。 */
export const STABLE_CHANNEL_ACCOUNT_ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** 默认设置快照；四个渠道各自拥有独立的 currentAccountId。 */
export const DEFAULT_SEARCH_SETTINGS: SearchSettingsSnapshot = Object.freeze({
  search: Object.freeze({
    enabled: DEFAULT_SEARCH_ENABLED,
    channel: DEFAULT_SEARCH_CHANNEL,
  }),
  buddy: Object.freeze({ currentAccountId: null }),
  workbuddy: Object.freeze({ currentAccountId: null }),
  qoder: Object.freeze({
    currentAccountId: null,
    endpointPreference: DEFAULT_QODER_ENDPOINT_PREFERENCE,
  }),
  qodercn: Object.freeze({ currentAccountId: null }),
})

/** 设置校验失败；RPC 层把它映射为 `settings/invalid`。 */
export class SearchSettingsValidationError extends Error {
  readonly code = 'settings/invalid'

  constructor(message: string) {
    super(message)
    this.name = 'SearchSettingsValidationError'
  }
}

/** 精确校验稳定账号 slug；null 由调用方单独处理。 */
export function isStableChannelAccountId(value: unknown): value is string {
  return typeof value === 'string' && STABLE_CHANNEL_ACCOUNT_ID_PATTERN.test(value)
}

/** 判断普通数据对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 拒绝未声明的补丁键。 */
function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new SearchSettingsValidationError(`${context} 不接受字段 ${key}`)
    }
  }
}

/** 严格校验设置补丁；未知键、错误类型和非法渠道/端点偏好都拒绝。 */
export function assertSearchSettingsPatch(patch: unknown): asserts patch is SearchSettingsPatch {
  if (!isRecord(patch)) {
    throw new SearchSettingsValidationError('设置补丁必须是普通对象')
  }
  rejectUnknownKeys(patch, ['enabled', 'channel', 'endpointPreference'], 'settings.update')
  if (Object.hasOwn(patch, 'enabled') && typeof patch.enabled !== 'boolean') {
    throw new SearchSettingsValidationError('search.enabled 必须是布尔值')
  }
  if (Object.hasOwn(patch, 'channel') && !isChannelId(patch.channel)) {
    throw new SearchSettingsValidationError(`非法搜索渠道：${String(patch.channel)}`)
  }
  if (Object.hasOwn(patch, 'endpointPreference')
    && !isQoderEndpointPreference(patch.endpointPreference)) {
    throw new SearchSettingsValidationError(`非法端点偏好：${String(patch.endpointPreference)}`)
  }
}

/** 严格校验设置当前账号请求。 */
export function assertSetCurrentAccountRequest(
  value: unknown,
): asserts value is SetCurrentAccountRequest {
  if (!isRecord(value)) {
    throw new SearchSettingsValidationError('setCurrentAccount payload 必须是普通对象')
  }
  rejectUnknownKeys(value, ['channel', 'accountId'], 'settings.setCurrentAccount')
  if (!Object.hasOwn(value, 'channel') || !isChannelId(value.channel)) {
    throw new SearchSettingsValidationError(`非法搜索渠道：${String(value.channel)}`)
  }
  if (!Object.hasOwn(value, 'accountId')) {
    throw new SearchSettingsValidationError('settings.setCurrentAccount 缺少 accountId')
  }
  if (value.accountId !== null && !isStableChannelAccountId(value.accountId)) {
    throw new SearchSettingsValidationError(`非法账号 slug：${String(value.accountId)}`)
  }
}
