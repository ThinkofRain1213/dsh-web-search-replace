/** 本代 Host actualHost 观测；与持久 lastSuccessfulHost 完全分离。 */
import type { SearchSettingsSnapshot } from '../shared/contracts.ts'
import type { HostRuntimeSnapshot, QoderRuntimeHost } from '../shared/runtime.ts'
import type { InvocationSelection } from './accounts/invocation.ts'
import type { QoderEndpointObservation } from './channels/qoder/endpoint-policy.ts'

export class RuntimeObservationStore {
  private generation = 0
  private selectionKey = ''
  private actualHost: QoderRuntimeHost | null = null
  private revision = 0

  constructor(readonly activationId: string) {}

  /** 每次有效选择变化都递增，A→B→A 也绝不复用旧代。 */
  captureSelection(snapshot: SearchSettingsSnapshot): number {
    const key = selectionKey(snapshot)
    if (key === this.selectionKey) return this.generation
    this.selectionKey = key
    this.generation += 1
    this.revision += 1
    this.actualHost = null
    return this.generation
  }

  /** 只接受真实用户 qoder auto observation；probe 不调用此入口。 */
  observe(
    selection: InvocationSelection,
    snapshot: SearchSettingsSnapshot,
    observation: QoderEndpointObservation,
  ): void {
    if (selection.channel !== 'qoder' || selection.endpointPreference !== 'auto') return
    if (observation.preference !== 'auto') return
    const currentGeneration = this.captureSelection(snapshot)
    if (currentGeneration !== selection.selectionGeneration) return
    if (this.selectionKey !== selectionKey(snapshot)) return
    this.actualHost = observation.outcome === 'succeeded'
      ? observation.host ?? null
      : null
    this.revision += 1
  }

  getSnapshot(): HostRuntimeSnapshot {
    return Object.freeze({
      activationId: this.activationId,
      revision: this.revision,
      qoder: Object.freeze({ autoActualHost: this.actualHost }),
    })
  }

  dispose(): void {
    this.actualHost = null
    this.selectionKey = ''
    this.generation += 1
    this.revision += 1
  }
}

export function createRuntimeObservationStore(activationId: string): RuntimeObservationStore {
  return new RuntimeObservationStore(activationId)
}

function selectionKey(snapshot: SearchSettingsSnapshot): string {
  const channel = snapshot.search.channel
  const accountId = snapshot[channel].currentAccountId ?? ''
  const preference = channel === 'qoder' ? snapshot.qoder.endpointPreference : ''
  return `${channel}\u0000${accountId}\u0000${preference}`
}
