/**
 * 四个固定顶层网页搜索渠道的共享元数据。
 *
 * 渠道 ID 同时决定运行时分派、状态显示和配置区归属；协议族只用于实现层
 * 代码复用，不能成为下拉项、执行资格或账号归属。本文件不保存任何秘密。
 */

/** 四个稳定顶层渠道 ID。 */
export type ChannelId = 'buddy' | 'workbuddy' | 'qoder' | 'qodercn'

/** 只有 Qoder 国际版拥有的端点偏好。 */
export type QoderEndpointPreference = 'auto' | 'center' | 'api2'

/** 协议族只允许在驱动/鉴权实现层复用代码。 */
export type ChannelProtocolFamily = 'tencent' | 'qoder'

/** 本版本四个渠道都使用账号授权型配置。 */
export type ChannelConfigKind = 'account'

/** 渠道能力矩阵；0.1.0 只交付 Search。 */
export interface ChannelCapabilities {
  readonly search: boolean
  readonly fetch: boolean
}

/** Qoder 国际版端点偏好定义：自动默认 center，api2 为同渠道备用。 */
export interface ChannelEndpointPreferenceDefinition {
  readonly field: 'endpointPreference'
  readonly defaultValue: QoderEndpointPreference
  readonly options: readonly QoderEndpointPreference[]
  /** 每个偏好实际使用的固定域名；auto 初始解析到 center。 */
  readonly hosts: Readonly<Record<QoderEndpointPreference, string>>
}

/** 单个渠道的共享描述；不包含任何账号、凭据或秘密。 */
export interface ChannelDefinition {
  readonly id: ChannelId
  readonly displayName: string
  readonly description: Readonly<{ readonly zh: string; readonly en: string }>
  /** 本渠道固定拥有的搜索域名。 */
  readonly hosts: readonly string[]
  readonly capabilities: ChannelCapabilities
  readonly configKind: ChannelConfigKind
  /** 仅用于代码复用；不得据此共享账号或配置。 */
  readonly protocolFamily: ChannelProtocolFamily
  /** 本渠道的账号边界说明。 */
  readonly accountBoundary: string
  /** 只有 Qoder 国际版存在端点偏好，其他渠道没有该字段。 */
  readonly endpointPreference?: ChannelEndpointPreferenceDefinition
}

/** 下拉项顺序，也是 `CHANNELS` 的键顺序。 */
export const CHANNEL_IDS = ['buddy', 'workbuddy', 'qoder', 'qodercn'] as const satisfies readonly ChannelId[]

/** Qoder 国际版端点偏好的精确取值。 */
export const QODER_ENDPOINT_PREFERENCES = ['auto', 'center', 'api2'] as const satisfies readonly QoderEndpointPreference[]

/** 四渠道元数据；深度冻结，避免运行时被意外改写。 */
export const CHANNELS: Readonly<Record<ChannelId, ChannelDefinition>> = Object.freeze({
  buddy: Object.freeze({
    id: 'buddy',
    displayName: 'CodeBuddy',
    description: Object.freeze({
      zh: '通过 CodeBuddy 账号执行网页搜索。',
      en: 'Run web search with a CodeBuddy account.',
    }),
    hosts: Object.freeze(['copilot.tencent.com']),
    capabilities: Object.freeze({ search: true, fetch: false }),
    configKind: 'account',
    protocolFamily: 'tencent',
    accountBoundary: '仅 CodeBuddy 账号',
  }),
  workbuddy: Object.freeze({
    id: 'workbuddy',
    displayName: 'WorkBuddy',
    description: Object.freeze({
      zh: '通过 WorkBuddy 账号执行网页搜索。',
      en: 'Run web search with a WorkBuddy account.',
    }),
    hosts: Object.freeze(['www.workbuddy.ai']),
    capabilities: Object.freeze({ search: true, fetch: false }),
    configKind: 'account',
    protocolFamily: 'tencent',
    accountBoundary: '仅 WorkBuddy 账号',
  }),
  qoder: Object.freeze({
    id: 'qoder',
    displayName: 'Qoder 国际版',
    description: Object.freeze({
      zh: '通过 Qoder 国际版账号执行网页搜索，仅支持搜索。',
      en: 'Run web search with a Qoder international account; search only.',
    }),
    hosts: Object.freeze(['center.qoder.sh', 'api2.qoder.sh']),
    capabilities: Object.freeze({ search: true, fetch: false }),
    configKind: 'account',
    protocolFamily: 'qoder',
    accountBoundary: '仅 Qoder 国际版账号，两域不得串用中国版配置',
    endpointPreference: Object.freeze({
      field: 'endpointPreference',
      defaultValue: 'auto',
      options: QODER_ENDPOINT_PREFERENCES,
      hosts: Object.freeze({
        auto: 'center.qoder.sh',
        center: 'center.qoder.sh',
        api2: 'api2.qoder.sh',
      }),
    }),
  }),
  qodercn: Object.freeze({
    id: 'qodercn',
    displayName: 'Qoder 中国版',
    description: Object.freeze({
      zh: '通过 Qoder 中国版账号执行网页搜索，仅支持搜索。',
      en: 'Run web search with a Qoder China account; search only.',
    }),
    hosts: Object.freeze(['gateway.qoder.com.cn']),
    capabilities: Object.freeze({ search: true, fetch: false }),
    configKind: 'account',
    protocolFamily: 'qoder',
    accountBoundary: '仅 Qoder 中国版账号',
  }),
})

/** 精确校验顶层渠道 ID。 */
export function isChannelId(value: unknown): value is ChannelId {
  return typeof value === 'string' && (CHANNEL_IDS as readonly string[]).includes(value)
}

/** 精确校验 Qoder 国际版端点偏好。 */
export function isQoderEndpointPreference(value: unknown): value is QoderEndpointPreference {
  return typeof value === 'string' && (QODER_ENDPOINT_PREFERENCES as readonly string[]).includes(value)
}
