/**
 * Host 本次激活的只读、非秘密运行时投影。
 *
 * `actualHost` 是真实用户搜索的本次运行观测，不是持久路由状态；本文件不允许
 * accountId、query、headers、耗时、原始错误或任何秘密进入 DTO。
 */
export const QODER_RUNTIME_HOSTS = ['center.qoder.sh', 'api2.qoder.sh'] as const

export type QoderRuntimeHost = (typeof QODER_RUNTIME_HOSTS)[number]

export interface HostRuntimeSnapshot {
  readonly activationId: string
  readonly revision: number
  readonly qoder: {
    readonly autoActualHost: QoderRuntimeHost | null
  }
}

export function isQoderRuntimeHost(value: unknown): value is QoderRuntimeHost {
  return typeof value === 'string' && (QODER_RUNTIME_HOSTS as readonly string[]).includes(value)
}

/** 严格校验 runtime.get 回包；额外字段使整包不可用。 */
export function isHostRuntimeSnapshot(value: unknown): value is HostRuntimeSnapshot {
  if (!isRecord(value) || !isRecord(value.qoder)) return false
  if (!hasExactKeys(value, ['activationId', 'revision', 'qoder'])) return false
  if (!hasExactKeys(value.qoder, ['autoActualHost'])) return false
  return typeof value.activationId === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(value.activationId)
    && typeof value.revision === 'number'
    && Number.isSafeInteger(value.revision)
    && value.revision >= 0
    && (value.qoder.autoActualHost === null || isQoderRuntimeHost(value.qoder.autoActualHost))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(record, key))
}
