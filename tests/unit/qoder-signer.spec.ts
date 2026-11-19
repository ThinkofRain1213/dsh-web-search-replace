/**
 * Qoder 签名器的行为守卫：真实 WASM 签名、固定路径变换、凭据边界与 R3 生命周期。
 *
 * ## 被锁死的契约
 *
 * 1. **真实签名**：签名输入 `path` 为 `/api/v1/webSearch/oneSearch`，实发 URL 由
 *    真实 `qoder-auth-wasm.wasm` 生成为 `/algo/api/v1/webSearch/oneSearch?Encode=1`；
 *    请求头含 `Authorization: Bearer COSY.<…>` 与 `Cosy-*` 系列。测试不 mock WASM，
 *    也不快照任何签名头/秘密值。
 * 2. **凭据边界**：缺 token / machineId 时在加载 WASM 之前以 `NO_ACCOUNT` 失败。
 * 3. **R3 生命周期**：每次签名创建的 wasm 上下文与返回值字符串在成功/失败后立即释放；
 *    `dispose()` 只释放本 signer 的引用，不销毁其他 signer 仍在使用的共享 WASM
 *    （进程级最终释放属于 Task 15）。
 * 4. **秘密卫生**：token / machineId / uid / 签名头不得进入日志或错误消息。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  QODER_SEARCH_PATH,
  QoderSearchProtocolError,
  type QoderSigningCredential,
} from '../../src/host/channels/qoder/protocol.ts'
import { QoderSigner, __testing } from '../../src/host/channels/qoder/signer.ts'

const HOST = 'gateway.qoder.com.cn'
const SIGNED_URL = 'https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=1'
const BODY = JSON.stringify({ payload: JSON.stringify({ query: '天气' }), encodeVersion: '1' })

const CREDENTIAL: QoderSigningCredential = {
  uid: 'TEST_UID_4d2e',
  securityOauthToken: 'TEST_SECURITY_TOKEN_9f3a',
  machineId: 'TEST_MACHINE_ID_7c1b',
}

/** 测试只保留「秘密存在性」所需的最小值，不把真实值写进任何快照。 */
const SECRET_VALUES = [CREDENTIAL.uid, CREDENTIAL.securityOauthToken, CREDENTIAL.machineId]

function freshSignal(): AbortSignal {
  return new AbortController().signal
}

/** 把任意日志参数转成可搜索文本（不写入报告，只在断言内使用）。 */
function logText(spies: readonly { mock: { calls: readonly unknown[][] } }[]): string {
  return spies
    .flatMap(spy => spy.mock.calls.flat())
    .map(value => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join(' ')
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('QoderSigner：无凭据边界（先于任何 WASM 工作）', () => {
  it.each([
    ['空 token', { ...CREDENTIAL, securityOauthToken: '' }],
    ['空白 token', { ...CREDENTIAL, securityOauthToken: '   ' }],
    ['非字符串 token', { ...CREDENTIAL, securityOauthToken: 42 as unknown as string }],
    ['空 machineId', { ...CREDENTIAL, machineId: '' }],
    ['空白 machineId', { ...CREDENTIAL, machineId: '   ' }],
    ['缺 machineId', { ...CREDENTIAL, machineId: undefined as unknown as string }],
  ])('%s → NO_ACCOUNT 且不加载 WASM', async (_label, credential) => {
    const before = __testing.wasmStats()
    const signer = new QoderSigner()
    try {
      const error = await signer
        .prepare(HOST, QODER_SEARCH_PATH, BODY, credential as QoderSigningCredential, freshSignal())
        .catch(caught => caught)
      expect(error).toBeInstanceOf(QoderSearchProtocolError)
      expect(error).toMatchObject({ code: 'NO_ACCOUNT' })
    } finally {
      signer.dispose()
    }
    const after = __testing.wasmStats()
    expect(after.glueLoads).toBe(before.glueLoads)
    expect(after.contextsCreated).toBe(before.contextsCreated)
  })

  it('凭据缺失且调用方已 abort 时，仍先报 NO_ACCOUNT（凭据检查先于取消）', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('user stop', 'AbortError'))
    const signer = new QoderSigner()
    try {
      await expect(
        signer.prepare(HOST, QODER_SEARCH_PATH, BODY, { ...CREDENTIAL, securityOauthToken: '' }, controller.signal),
      ).rejects.toMatchObject({ code: 'NO_ACCOUNT' })
    } finally {
      signer.dispose()
    }
  })
})

describe('QoderSigner：真实 WASM 签名', () => {
  it('以 /api/v1/webSearch/oneSearch 为输入，由真实 WASM 生成 /algo/...?Encode=1', async () => {
    const signer = new QoderSigner()
    try {
      const prepared = await signer.prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal())

      expect(prepared.url).toBe(SIGNED_URL)
      expect(prepared.url).toContain('/algo/api/v1/webSearch/oneSearch')
      expect(prepared.url.endsWith('?Encode=1')).toBe(true)

      // 只断言签名头的形态与存在性，绝不输出其值。
      expect(prepared.headers.Authorization).toMatch(/^Bearer COSY\./)
      expect(Object.keys(prepared.headers)).toEqual(
        expect.arrayContaining(['Cosy-Version', 'Cosy-MachineId', 'Cosy-User']),
      )

      // 请求体由 WASM 加密，不是调用方传入的明文信封。
      expect(prepared.body.length).toBeGreaterThan(0)
      expect(prepared.body).not.toBe(BODY)
      expect(prepared.body).not.toContain('天气')
      expect(() => JSON.parse(prepared.body)).toThrow()
    } finally {
      signer.dispose()
    }
  })

  it('每次签名创建并立即释放独立上下文与返回值字符串', async () => {
    const before = __testing.wasmStats()
    const signer = new QoderSigner()
    try {
      await signer.prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal())
      await signer.prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal())
    } finally {
      signer.dispose()
    }
    const after = __testing.wasmStats()

    expect(after.contextsCreated - before.contextsCreated).toBe(2)
    expect(after.contextsFreed - before.contextsFreed).toBe(2)
    expect(after.resultsCreated - before.resultsCreated).toBe(2)
    expect(after.resultsFreed - before.resultsFreed).toBe(2)
    // 每次签名释放 1 个 auth 字段返回串 + url + body 共 3 个。
    expect(after.stringsFreed - before.stringsFreed).toBe(6)
  })

  it('签名阶段内部失败时仍释放已创建的上下文，不留下在飞泄漏', async () => {
    const before = __testing.wasmStats()
    const signer = new QoderSigner()
    try {
      // Symbol 无法被 TextEncoder 编码：失败发生在上下文创建之后、返回值读取之前。
      const error = await signer
        .prepare(HOST, QODER_SEARCH_PATH, Symbol('boom') as unknown as string, CREDENTIAL, freshSignal())
        .catch(caught => caught)

      expect(error).toBeInstanceOf(QoderSearchProtocolError)
      expect(error).toMatchObject({ code: 'SEARCH_FAILED' })
      expect(signer.inflight).toBe(0)
    } finally {
      signer.dispose()
    }
    const after = __testing.wasmStats()
    expect(after.contextsCreated - before.contextsCreated).toBe(1)
    expect(after.contextsFreed - before.contextsFreed).toBe(1)
  })

  it('预热后连续签名不增长 WASM 堆（无每次调用的泄漏）', async () => {
    const signer = new QoderSigner()
    try {
      for (let index = 0; index < 25; index += 1) {
        await signer.prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal())
      }
      const before = await __testing.wasmHeapBytes()
      for (let index = 0; index < 150; index += 1) {
        await signer.prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal())
      }
      const after = await __testing.wasmHeapBytes()
      // 每次泄漏约 url+body 长度（约 300 B）；150 次会超过 40 KB。
      expect(after - before).toBeLessThan(16_384)
    } finally {
      signer.dispose()
    }
  })

  it('并发签名各自独立，全部释放且在飞计数归零', async () => {
    const before = __testing.wasmStats()
    const signer = new QoderSigner()
    try {
      const prepared = await Promise.all(
        Array.from({ length: 6 }, () => signer.prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal())),
      )
      expect(new Set(prepared.map(item => item.url))).toEqual(new Set([SIGNED_URL]))
      expect(signer.inflight).toBe(0)
    } finally {
      signer.dispose()
    }
    const after = __testing.wasmStats()
    expect(after.contextsCreated - before.contextsCreated).toBe(6)
    expect(after.contextsFreed - before.contextsFreed).toBe(6)
  })
})

describe('QoderSigner：取消与输入边界', () => {
  it('宿主 deadline 形状的已中止信号在签名前以 TIMEOUT 失败', async () => {
    const controller = new AbortController()
    controller.abort(Object.assign(new Error('TOOL_TIMEOUT'), {
      name: 'TimeoutReason',
      code: 'TOOL_TIMEOUT',
    }))
    const before = __testing.wasmStats()
    const signer = new QoderSigner()
    try {
      await expect(
        signer.prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, controller.signal),
      ).rejects.toMatchObject({ code: 'TIMEOUT' })
    } finally {
      signer.dispose()
    }
    const after = __testing.wasmStats()
    expect(after.contextsCreated).toBe(before.contextsCreated)
  })

  it('普通调用方取消在签名前以 SEARCH_FAILED 失败，不误报 TIMEOUT', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('user stop', 'AbortError'))
    const signer = new QoderSigner()
    try {
      await expect(
        signer.prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, controller.signal),
      ).rejects.toMatchObject({ code: 'SEARCH_FAILED' })
    } finally {
      signer.dispose()
    }
  })

  it('非裸 host 在签名前被拒绝，且不创建上下文', async () => {
    const before = __testing.wasmStats()
    const signer = new QoderSigner()
    try {
      await expect(
        signer.prepare('https://evil.example/', QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal()),
      ).rejects.toMatchObject({ code: 'SEARCH_FAILED' })
    } finally {
      signer.dispose()
    }
    const after = __testing.wasmStats()
    expect(after.contextsCreated).toBe(before.contextsCreated)
  })
})

describe('QoderSigner：R3 生命周期边界', () => {
  it('dispose 后拒绝新签名，且不创建上下文', async () => {
    const before = __testing.wasmStats()
    const signer = new QoderSigner()
    signer.dispose()

    await expect(
      signer.prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal()),
    ).rejects.toMatchObject({ code: 'SEARCH_FAILED' })
    expect(signer.isDisposed).toBe(true)

    const after = __testing.wasmStats()
    expect(after.contextsCreated).toBe(before.contextsCreated)
    expect(after.signerRefs).toBe(before.signerRefs)
  })

  it('dispose 幂等：重复调用不会重复释放引用', async () => {
    const before = __testing.wasmStats()
    const signer = new QoderSigner()
    expect(__testing.wasmStats().signerRefs).toBe(before.signerRefs + 1)
    signer.dispose()
    signer.dispose()
    expect(__testing.wasmStats().signerRefs).toBe(before.signerRefs)
  })

  it('dispose 只释放自己的引用，不销毁其他 signer 正在使用的共享 WASM', async () => {
    // 先确保共享 WASM 已加载，避免把「首次加载」误判成「重新实例化」。
    const warmup = new QoderSigner()
    await warmup.prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal())
    warmup.dispose()

    const glueLoads = __testing.wasmStats().glueLoads
    const other = new QoderSigner()
    const disposed = new QoderSigner()
    try {
      const pending = other.prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal())
      disposed.dispose()
      const prepared = await pending
      expect(prepared.url).toBe(SIGNED_URL)
      expect(__testing.wasmStats().glueLoads).toBe(glueLoads)
      await expect(
        disposed.prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal()),
      ).rejects.toMatchObject({ code: 'SEARCH_FAILED' })
    } finally {
      other.dispose()
    }
  })

  it('自己 dispose 时在飞签名仍安全完成，引用在归零后才释放', async () => {
    const before = __testing.wasmStats()
    const signer = new QoderSigner()
    const pending = signer.prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal())
    signer.dispose()
    // dispose 发生在在飞期间：引用必须等在飞归零后才释放。
    expect(__testing.wasmStats().signerRefs).toBe(before.signerRefs + 1)
    await expect(pending).resolves.toMatchObject({ url: SIGNED_URL })
    expect(signer.inflight).toBe(0)
    expect(__testing.wasmStats().signerRefs).toBe(before.signerRefs)
  })
})

describe('QoderSigner：秘密卫生', () => {
  it('成功、签名失败与无账号路径都不打印秘密或签名头', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const)
      .map(method => vi.spyOn(console, method).mockImplementation(() => {}))

    const signer = new QoderSigner()
    const errorTexts: string[] = []
    try {
      await signer.prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal())

      const signingError = await signer
        .prepare(HOST, QODER_SEARCH_PATH, Symbol('boom') as unknown as string, CREDENTIAL, freshSignal())
        .catch(caught => caught)
      errorTexts.push((signingError as Error).message)

      const noAccount = await new QoderSigner()
        .prepare(HOST, QODER_SEARCH_PATH, BODY, { ...CREDENTIAL, securityOauthToken: '' }, freshSignal())
        .catch(caught => caught)
      errorTexts.push((noAccount as Error).message)
    } finally {
      signer.dispose()
    }

    const output = `${logText(spies)} ${errorTexts.join(' ')}`
    spies.forEach(spy => spy.mockRestore())

    for (const secret of SECRET_VALUES) expect(output).not.toContain(secret)
    expect(output).not.toContain('COSY.')
    expect(output).not.toContain('Bearer COSY')
  })
})
