/** R44：独立 Host-only 全局最近成功域；不得进入 Config/configForms/账号 grant。 */
import {
  ACCOUNT_CREDENTIAL_SCOPE,
  buildCredentialKey,
  type AccountCredentialProvider,
} from '../../accounts/store.ts'
import { isQoderRuntimeHost, type QoderRuntimeHost } from '../../../shared/runtime.ts'
import type { InvocationSelection } from '../../accounts/invocation.ts'
import { SettingsWriteCancelledError } from '../../settings/service.ts'

export const QODER_LAST_SUCCESSFUL_HOST_KEY = buildCredentialKey(
  ACCOUNT_CREDENTIAL_SCOPE,
  'qoder-last-successful-host',
)

export type QoderRouteSelection = InvocationSelection

export interface QoderRouteStoreOptions {
  readonly credentials: AccountCredentialProvider
  /** callback 执行时读取最新选择，不能只捕获调用前的快照。 */
  readonly readSelection: () => QoderRouteSelection
}

export type QoderRouteWriteResult = 'written' | 'stale'

export class QoderRouteStore {
  constructor(private readonly options: QoderRouteStoreOptions) {}

  async read(): Promise<QoderRuntimeHost | null> {
    const record = await this.options.credentials.readRecord(QODER_LAST_SUCCESSFUL_HOST_KEY)
    if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
      return null
    }
    const payload = record.payload as Record<string, unknown>
    return Object.keys(payload).length === 1 && isQoderRuntimeHost(payload.host)
      ? payload.host
      : null
  }

  /** 在 modifyRecord 独占回调内重新验代际；stale/no-op 不是物理写失败。 */
  async write(
    host: QoderRuntimeHost,
    selection: QoderRouteSelection,
    signal?: AbortSignal,
  ): Promise<QoderRouteWriteResult> {
    if (signal?.aborted) throw new SettingsWriteCancelledError()
    let result: QoderRouteWriteResult = 'stale'
    await this.options.credentials.modifyRecord(
      QODER_LAST_SUCCESSFUL_HOST_KEY,
      async () => {
        if (signal?.aborted) throw new SettingsWriteCancelledError()
        const latest = this.options.readSelection()
        if (!sameSelection(selection, latest)) return undefined
        result = 'written'
        return { kind: 'grant', payload: { host } }
      },
    )
    // callback 返回后的物理提交只能 await；取消不得伪装成成功或回滚。
    if (signal?.aborted) throw new SettingsWriteCancelledError()
    return result
  }
}

function sameSelection(
  expected: QoderRouteSelection,
  latest: QoderRouteSelection,
): boolean {
  return latest.channel === 'qoder'
    && latest.endpointPreference === 'auto'
    && latest.accountId === expected.accountId
    && latest.endpointPreference === expected.endpointPreference
    && latest.selectionGeneration === expected.selectionGeneration
}
