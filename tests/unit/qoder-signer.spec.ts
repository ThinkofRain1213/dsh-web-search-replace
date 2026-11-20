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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  QODER_SEARCH_PATH,
  QoderSearchProtocolError,
  type QoderSigningCredential,
} from '../../src/host/channels/qoder/protocol.ts'
import { QoderSigner, __testing, readApprovedQoderWasm, resolveQoderWasmAssetPath } from '../../src/host/channels/qoder/signer.ts'
import { installTextEncoderFault } from './support/text-encoder-fault.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REAL_WASM = resolve(ROOT, 'assets/qoder/qoder-auth-wasm.wasm')
const APPROVED_WASM_SHA256 = '6419471EFFA631519DEF7797D76D7EDE38B9FCFA9A83C2148C8EF5D43355B43D'

const HOST = 'gateway.qoder.com.cn'
const SIGNED_URL = 'https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=1'
const BODY = JSON.stringify({ payload: JSON.stringify({ query: '天气' }), encodeVersion: '1' })
/** 唯一 body 标记：测试侧故障只匹配它，避免误伤其他 encode 调用。 */
const FAULT_BODY = JSON.stringify({
  payload: JSON.stringify({ query: 'I1_FAULT_BODY_MARKER' }),
  encodeVersion: '1',
})
/** 唯一 machineId 标记：用于定位 context 的第 1 个输入写入。 */
const FAULT_MACHINE_ID = 'TEST_MACHINE_ID_I1_FAULT'

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
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

/** 每个用例创建的临时包目录；afterEach 统一清理。 */
const tempRoots: string[] = []

/**
 * 造一个「包内真实资产 + 包外同名恶意资产」的临时布局。
 *
 * 返回的 `pkg` 同时包含 `lib/` 与 `src/host/channels/qoder/` 两种模块位置，
 * 用于验证两种运行布局都只解析包内资产。
 */
function makeTempPackage(): {
  readonly root: string
  readonly pkg: string
  readonly pkgAsset: string
  readonly parentAsset: string
} {
  const root = mkdtempSync(join(tmpdir(), 'qoder-wasm-'))
  tempRoots.push(root)
  const pkg = join(root, 'pkg')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  mkdirSync(join(pkg, 'src', 'host', 'channels', 'qoder'), { recursive: true })
  mkdirSync(join(pkg, 'assets', 'qoder'), { recursive: true })
  mkdirSync(join(root, 'assets', 'qoder'), { recursive: true })
  const pkgAsset = join(pkg, 'assets', 'qoder', 'qoder-auth-wasm.wasm')
  copyFileSync(REAL_WASM, pkgAsset)
  const parentAsset = join(root, 'assets', 'qoder', 'qoder-auth-wasm.wasm')
  writeFileSync(parentAsset, Buffer.from('evil wasm from package parent'))
  return { root, pkg, pkgAsset, parentAsset }
}

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

  it('预热后 5000 次成功签名不呈每次调用线性增长（精确计数）', async () => {
    const signer = new QoderSigner()
    try {
      for (let index = 0; index < 100; index += 1) {
        await signer.prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal())
      }
      const heapBefore = await __testing.wasmHeapBytes()
      const statsBefore = __testing.wasmStats()
      const iterations = 5_000
      for (let index = 0; index < iterations; index += 1) {
        await signer.prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal())
      }
      const heapAfter = await __testing.wasmHeapBytes()
      const statsAfter = __testing.wasmStats()

      // 每次泄漏约 260B 输入串时，5000 次会增长约 1.3MB，远超一页。
      expect(heapAfter - heapBefore).toBeLessThan(65_536)
      expect(statsAfter.contextsCreated - statsBefore.contextsCreated).toBe(iterations)
      expect(statsAfter.contextsFreed - statsBefore.contextsFreed).toBe(iterations)
      expect(statsAfter.resultsCreated - statsBefore.resultsCreated).toBe(iterations)
      expect(statsAfter.resultsFreed - statsBefore.resultsFreed).toBe(iterations)
      expect(statsAfter.stringsFreed - statsBefore.stringsFreed).toBe(iterations * 3)
      expect(statsAfter.inputStringsAllocated - statsBefore.inputStringsAllocated).toBe(iterations * 10)
      // 成功路径输入所有权交给 Rust；本层不 free（参考实现证明手工 free 会 trap）。
      expect(statsAfter.inputStringsFreed - statsBefore.inputStringsFreed).toBe(0)
    } finally {
      signer.dispose()
    }
  })

  it('2000 次失败签名循环：输入清理精确且不呈线性增长', async () => {
    const signer = new QoderSigner()
    const iterations = 2_000
    // 测试侧故障：body 在 writeString 分配后、写入时失败（不涉及生产开关）。
    const restore = installTextEncoderFault({
      match: input => input === FAULT_BODY,
      mode: 'during-write',
    })
    try {
      for (let index = 0; index < 100; index += 1) {
        await signer
          .prepare(HOST, QODER_SEARCH_PATH, FAULT_BODY, CREDENTIAL, freshSignal())
          .catch(() => undefined)
      }
      const heapBefore = await __testing.wasmHeapBytes()
      const statsBefore = __testing.wasmStats()
      for (let index = 0; index < iterations; index += 1) {
        const error = await signer
          .prepare(HOST, QODER_SEARCH_PATH, FAULT_BODY, CREDENTIAL, freshSignal())
          .catch(caught => caught)
        expect(error).toBeInstanceOf(QoderSearchProtocolError)
      }
      const heapAfter = await __testing.wasmHeapBytes()
      const statsAfter = __testing.wasmStats()

      expect(heapAfter - heapBefore).toBeLessThan(65_536)
      expect(statsAfter.inputStringsAllocated - statsBefore.inputStringsAllocated)
        .toBe(iterations * 10)
      // 每次失败：4 个已写请求输入 + 失败的那个 body 输入 = 5 个被本层清理；
      // auth 1 + context 4 = 5 个已交给 Rust。
      expect(statsAfter.inputStringsFreed - statsBefore.inputStringsFreed)
        .toBe(iterations * 5)
      expect(statsAfter.contextsCreated - statsBefore.contextsCreated).toBe(iterations)
      expect(statsAfter.contextsFreed - statsBefore.contextsFreed).toBe(iterations)
      expect(statsAfter.resultsCreated - statsBefore.resultsCreated).toBe(0)
      // 失败前 auth 字段已成功，其返回串仍被释放。
      expect(statsAfter.stringsFreed - statsBefore.stringsFreed).toBe(iterations)
    } finally {
      restore()
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

describe('QoderSigner：输入字符串异常清理（I1）', () => {
  it('body 非 string 在任何 WASM 分配前被拒绝', async () => {
    const before = __testing.wasmStats()
    const signer = new QoderSigner()
    try {
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
    expect(after.inputStringsAllocated).toBe(before.inputStringsAllocated)
    expect(after.contextsCreated).toBe(before.contextsCreated)
  })

  it('成功签名精确分配 10 个输入串（Rust 接管），返回串释放 3 个', async () => {
    const before = __testing.wasmStats()
    const signer = new QoderSigner()
    try {
      await signer.prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal())
    } finally {
      signer.dispose()
    }
    const after = __testing.wasmStats()
    // 1 个 auth 字段输入 + 4 个 context 输入 + 5 个请求输入。
    expect(after.inputStringsAllocated - before.inputStringsAllocated).toBe(10)
    // 成功路径的输入所有权交给 Rust，本层不得手工 free（会 double-free trap）。
    expect(after.inputStringsFreed - before.inputStringsFreed).toBe(0)
    expect(after.contextsCreated - before.contextsCreated).toBe(1)
    expect(after.contextsFreed - before.contextsFreed).toBe(1)
    expect(after.resultsCreated - before.resultsCreated).toBe(1)
    expect(after.resultsFreed - before.resultsFreed).toBe(1)
    expect(after.stringsFreed - before.stringsFreed).toBe(3)
  })

  it('auth 写入在分配前失败：不产生输入分配', async () => {
    const before = __testing.wasmStats()
    const signer = new QoderSigner()
    const restore = installTextEncoderFault({
      match: input => input.includes('security_oauth_token'),
      mode: 'before-allocation',
    })
    try {
      const error = await signer
        .prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal())
        .catch(caught => caught)
      expect(error).toBeInstanceOf(QoderSearchProtocolError)
      expect(error).toMatchObject({ code: 'SEARCH_FAILED' })
      expect(signer.inflight).toBe(0)
    } finally {
      restore()
      signer.dispose()
    }
    const after = __testing.wasmStats()
    expect(after.inputStringsAllocated - before.inputStringsAllocated).toBe(0)
    expect(after.inputStringsFreed - before.inputStringsFreed).toBe(0)
    expect(after.contextsCreated - before.contextsCreated).toBe(0)
  })

  it('auth 写入在分配后失败：writeString 自清已分配指针', async () => {
    const before = __testing.wasmStats()
    const signer = new QoderSigner()
    const restore = installTextEncoderFault({
      match: input => input.includes('security_oauth_token'),
      mode: 'during-write',
    })
    try {
      const error = await signer
        .prepare(HOST, QODER_SEARCH_PATH, BODY, CREDENTIAL, freshSignal())
        .catch(caught => caught)
      expect(error).toBeInstanceOf(QoderSearchProtocolError)
      expect(error).toMatchObject({ code: 'SEARCH_FAILED' })
    } finally {
      restore()
      signer.dispose()
    }
    const after = __testing.wasmStats()
    expect(after.inputStringsAllocated - before.inputStringsAllocated).toBe(1)
    expect(after.inputStringsFreed - before.inputStringsFreed).toBe(1)
    expect(after.contextsCreated - before.contextsCreated).toBe(0)
  })

  const beforeAllocationCases: ReadonlyArray<{
    readonly label: string
    readonly match: (input: string) => boolean
    readonly allocated: number
    readonly freed: number
    readonly contexts: number
  }> = [
    {
      label: 'context 第 1 个输入（machineId）',
      match: input => input === FAULT_MACHINE_ID,
      allocated: 1,
      freed: 0,
      contexts: 0,
    },
    {
      label: 'context 第 3 个输入（userInfo）',
      match: input => input.includes('encrypt_user_info'),
      allocated: 3,
      freed: 2,
      contexts: 0,
    },
    {
      label: 'request 第 1 个输入（endpoint）',
      match: input => input === `https://${HOST}`,
      allocated: 5,
      freed: 0,
      contexts: 1,
    },
    {
      label: 'request body',
      match: input => input === FAULT_BODY,
      allocated: 9,
      freed: 4,
      contexts: 1,
    },
  ]

  it.each(beforeAllocationCases)(
    '$label 在分配前失败：清理所有已写未接管输入',
    async (testCase) => {
      const before = __testing.wasmStats()
      const signer = new QoderSigner()
      const restore = installTextEncoderFault({
        match: testCase.match,
        mode: 'before-allocation',
      })
      try {
        const error = await signer
          .prepare(
            HOST,
            QODER_SEARCH_PATH,
            FAULT_BODY,
            { ...CREDENTIAL, machineId: FAULT_MACHINE_ID },
            freshSignal(),
          )
          .catch(caught => caught)
        expect(error).toBeInstanceOf(QoderSearchProtocolError)
        expect(error).toMatchObject({ code: 'SEARCH_FAILED' })
        expect(signer.inflight).toBe(0)
      } finally {
        restore()
        signer.dispose()
      }
      const after = __testing.wasmStats()
      expect(after.inputStringsAllocated - before.inputStringsAllocated).toBe(testCase.allocated)
      expect(after.inputStringsFreed - before.inputStringsFreed).toBe(testCase.freed)
      expect(after.contextsCreated - before.contextsCreated).toBe(testCase.contexts)
      expect(after.contextsFreed - before.contextsFreed).toBe(testCase.contexts)
      expect(after.resultsCreated - before.resultsCreated).toBe(0)
    },
  )

  it('request body 在分配后失败：writeString 自清 + 调用方清理先前输入', async () => {
    const before = __testing.wasmStats()
    const signer = new QoderSigner()
    const restore = installTextEncoderFault({
      match: input => input === FAULT_BODY,
      mode: 'during-write',
    })
    try {
      const error = await signer
        .prepare(HOST, QODER_SEARCH_PATH, FAULT_BODY, CREDENTIAL, freshSignal())
        .catch(caught => caught)
      expect(error).toBeInstanceOf(QoderSearchProtocolError)
      expect(error).toMatchObject({ code: 'SEARCH_FAILED' })
      expect(signer.inflight).toBe(0)
    } finally {
      restore()
      signer.dispose()
    }
    const after = __testing.wasmStats()
    expect(after.inputStringsAllocated - before.inputStringsAllocated).toBe(10)
    expect(after.inputStringsFreed - before.inputStringsFreed).toBe(5)
    expect(after.contextsCreated - before.contextsCreated).toBe(1)
    expect(after.contextsFreed - before.contextsFreed).toBe(1)
    expect(after.resultsCreated - before.resultsCreated).toBe(0)
  })
})

describe('QoderSigner：返回值读取重新获取 DataView（I2）', () => {
  it('invoke 触发内存增长（旧 buffer detach）时仍读取返回值并释放返回串', () => {
    let current = new ArrayBuffer(64)
    const stale = current
    const freed: Array<{ ptr: number; len: number }> = []
    const glue = {
      exports: {
        __wbindgen_add_to_stack_pointer: (_delta: number) => 0,
      },
      view: () => new DataView(current),
      readString: (ptr: number, len: number) => `ptr=${ptr};len=${len}`,
      freeString: (ptr: number, len: number) => { freed.push({ ptr, len }) },
    }

    const invoke = (stack: number, result: number): void => {
      expect(result).toBe(7)
      // 模拟 memory.grow：旧 ArrayBuffer 被 detach，glue.view() 之后返回新 buffer。
      structuredClone(stale, { transfer: [stale] })
      current = new ArrayBuffer(64)
      const data = new DataView(current)
      data.setInt32(stack + 0, 1234, true)
      data.setInt32(stack + 4, 9, true)
    }

    const value = __testing.readRequestResultString(glue as never, 7, invoke)
    expect(value).toBe('ptr=1234;len=9')
    expect(freed).toEqual([{ ptr: 1234, len: 9 }])
  })

  it('大尺寸真实签名触发堆增长时仍成功读取 URL/body', async () => {
    const signer = new QoderSigner()
    try {
      let grew = false
      for (const size of [1_000_000, 2_000_000, 4_000_000]) {
        const body = JSON.stringify({
          payload: JSON.stringify({ query: 'x'.repeat(size) }),
          encodeVersion: '1',
        })
        const before = await __testing.wasmHeapBytes()
        const prepared = await signer.prepare(HOST, QODER_SEARCH_PATH, body, CREDENTIAL, freshSignal())
        const after = await __testing.wasmHeapBytes()
        expect(prepared.url).toBe(SIGNED_URL)
        expect(prepared.body.length).toBeGreaterThan(size)
        if (after > before) grew = true
      }
      expect(grew).toBe(true)
    } finally {
      signer.dispose()
    }
  })
})

describe('QoderSigner：requestresult_headers fail-closed', () => {
  it('B6：非 Map headers 固定失败且不泄露秘密，request result 仍释放', () => {
    const buffer = new ArrayBuffer(64)
    const freedResults: number[] = []
    let nextPtr = 1
    const glue = {
      exports: {
        qodercontext_prepareRequest: () => {},
        requestresult_headers: () => 99,
        requestresult_url: (stack: number) => {
          const view = new DataView(buffer)
          view.setInt32(stack + 0, 100, true)
          view.setInt32(stack + 4, 1, true)
        },
        requestresult_body: (stack: number) => {
          const view = new DataView(buffer)
          view.setInt32(stack + 0, 200, true)
          view.setInt32(stack + 4, 1, true)
        },
        __wbindgen_add_to_stack_pointer: () => 0,
      },
      writeString: () => nextPtr++,
      lastLength: () => 1,
      callPointer: (invoke: (stack: number) => void) => { invoke(0); return 7 },
      takeObject: () => ({ Authorization: 'Bearer COSY.HEADER_SECRET' }),
      view: () => new DataView(buffer),
      readString: (ptr: number) => ptr === 100
        ? 'https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=1'
        : 'encrypted',
      freePointer: (_name: string, ptr: number) => { freedResults.push(ptr) },
      freeString: () => {},
      releaseInputString: () => {},
    }
    const error = (() => {
      try {
        ;(__testing as any).prepareSignedRequest(glue, 1, 'https://gateway.qoder.com.cn', QODER_SEARCH_PATH, BODY)
        return undefined
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(QoderSearchProtocolError)
    expect(error).toMatchObject({ code: 'SEARCH_FAILED', kind: 'signing' })
    expect((error as Error).message).not.toContain('HEADER_SECRET')
    expect(freedResults).toEqual([7])
  })
})

describe('QoderSigner：包内批准资产（C1）', () => {
  it('lib 布局只解析包内 assets，不回退到包外同名文件', () => {
    const { pkg, pkgAsset, parentAsset } = makeTempPackage()
    const resolved = resolveQoderWasmAssetPath(
      pathToFileURL(join(pkg, 'lib', 'index.js')).href,
    )
    expect(resolved).toBe(pkgAsset)
    expect(resolved).not.toBe(parentAsset)
    expect(resolved.startsWith(pkg)).toBe(true)
  })

  it('源码布局只解析包内 assets，不回退到包外同名文件', () => {
    const { pkg, pkgAsset, parentAsset } = makeTempPackage()
    const resolved = resolveQoderWasmAssetPath(
      pathToFileURL(join(pkg, 'src', 'host', 'channels', 'qoder', 'signer.ts')).href,
    )
    expect(resolved).toBe(pkgAsset)
    expect(resolved).not.toBe(parentAsset)
  })

  it('包内资产缺失时不会回退到包外同名文件', () => {
    const { pkg, pkgAsset, parentAsset } = makeTempPackage()
    rmSync(pkgAsset)
    const resolved = resolveQoderWasmAssetPath(
      pathToFileURL(join(pkg, 'lib', 'index.js')).href,
    )
    expect(resolved).toBe(pkgAsset)
    expect(readFileSync(parentAsset).byteLength).toBeGreaterThan(0)
    expect(() => readApprovedQoderWasm(resolved)).toThrow(QoderSearchProtocolError)
  })

  it('运行时 SHA256 不匹配 fail-closed（包外与包内被篡改都不接受）', () => {
    const { pkgAsset, parentAsset } = makeTempPackage()
    expect(() => readApprovedQoderWasm(parentAsset)).toThrow(QoderSearchProtocolError)

    const tampered = readFileSync(pkgAsset)
    tampered[0] = (tampered[0] ?? 0) ^ 0xff
    writeFileSync(pkgAsset, tampered)
    expect(() => readApprovedQoderWasm(pkgAsset)).toThrow(QoderSearchProtocolError)
  })

  it('真实仓库的 lib 布局解析到包内 assets', () => {
    const resolved = resolveQoderWasmAssetPath(
      pathToFileURL(resolve(ROOT, 'lib', 'index.js')).href,
    )
    expect(resolved).toBe(REAL_WASM)
    expect(resolved.startsWith(ROOT)).toBe(true)
  })

  it('批准资产被接受，且大小/SHA256 与批准基线一致', async () => {
    const { createHash } = await import('node:crypto')
    const bytes = readApprovedQoderWasm(REAL_WASM)
    expect(bytes.byteLength).toBe(298606)
    expect(createHash('sha256').update(bytes).digest('hex').toUpperCase()).toBe(APPROVED_WASM_SHA256)
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
