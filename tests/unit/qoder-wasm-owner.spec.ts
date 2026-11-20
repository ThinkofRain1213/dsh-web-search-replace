/** R40：activation lease + signer refs 的 WASM 最终释放与不复活观察。 */
import { describe, expect, it, vi } from 'vitest'

import * as signerModule from '../../src/host/channels/qoder/signer.ts'
import { QoderSigner, __testing } from '../../src/host/channels/qoder/signer.ts'

const credential = { securityOauthToken: 'OWNER_TOKEN', machineId: 'OWNER_MACHINE' }

function acquire(): any {
  const factory = (signerModule as any).acquireQoderWasmOwnerLease
  expect(typeof factory).toBe('function')
  return factory()
}

describe('Qoder WASM owner', () => {
  it('在飞签名和全部 activation refs 归零后才 final release；观察口不复活，旧 disposer 不清新代', async () => {
    const firstLease = acquire()
    const secondLease = acquire()
    const signer = new QoderSigner()
    const originalCompile = WebAssembly.compile
    let compileEntered!: () => void
    const entered = new Promise<void>((resolve) => { compileEntered = resolve })
    let releaseCompile!: () => void
    const compileGate = new Promise<void>((resolve) => { releaseCompile = resolve })
    vi.spyOn(WebAssembly, 'compile').mockImplementation(async (bytes) => {
      compileEntered()
      await compileGate
      return await originalCompile(bytes)
    })

    try {
      const preparing = signer.prepare(
        'center.qoder.sh', '/api/v1/webSearch/oneSearch', '{}', credential,
        new AbortController().signal,
      )
      await entered
      const firstDisposal = firstLease.dispose()
      await Promise.resolve()
      expect(__testing.wasmStats().glueLoads).toBe(0)

      releaseCompile()
      await preparing
      signer.dispose()
      await firstDisposal
      const statsBeforeFinal = (signerModule as any).__testing.wasmOwnerStats()
      expect(statsBeforeFinal.finalReleases).toBe(0)
      expect(statsBeforeFinal.glueResident).toBe(true)

      await secondLease.dispose()
      const released = (signerModule as any).__testing.wasmOwnerStats()
      expect(released.finalReleases).toBe(1)
      expect(released.glueResident).toBe(false)
      const loads = __testing.wasmStats().glueLoads
      expect((signerModule as any).__testing.wasmOwnerStats().glueLoads).toBe(loads)

      const nextLease = acquire()
      const nextSigner = new QoderSigner()
      await nextSigner.prepare(
        'center.qoder.sh', '/api/v1/webSearch/oneSearch', '{}', credential,
        new AbortController().signal,
      )
      expect(__testing.wasmStats().glueLoads).toBe(loads + 1)
      // 旧代重复 disposer 不得清除新一代。
      await secondLease.dispose()
      expect((signerModule as any).__testing.wasmOwnerStats().glueResident).toBe(true)
      nextSigner.dispose()
      await nextLease.dispose()
      expect((signerModule as any).__testing.wasmOwnerStats().finalReleases).toBe(2)
    } finally {
      releaseCompile()
      signer.dispose()
      await firstLease.dispose()
      await secondLease.dispose()
      vi.restoreAllMocks()
    }
  })
})
