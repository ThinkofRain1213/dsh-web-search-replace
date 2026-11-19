/**
 * Qoder COSY 签名器：真实 `qoder-auth-wasm.wasm` 的 wasm-bindgen 桥。
 *
 * ## 为什么需要它
 *
 * Qoder 的搜索端点不接受普通 `Bearer <token>`，而是要求客户端内嵌 WASM 生成的
 * COSY 签名头与加密请求体：
 *
 * ```
 * POST https://{host}/algo/api/v1/webSearch/oneSearch?Encode=1
 * Authorization: Bearer COSY.<载荷>.<签名>
 * body: <由本 WASM 加密>
 * ```
 *
 * 本模块把 `assets/qoder/qoder-auth-wasm.wasm` 按 wasm-bindgen 约定接起来，只保留
 * 搜索需要的两个导出：`qodercontext_new`（账号上下文）与
 * `qodercontext_prepareRequest`（任意端点签名）。**不 mock、不手写签名**。
 *
 * ## 生命周期（R3）
 *
 * - WASM 实例是**进程级共享**的（`gluePromise` 单例）；本任务**不**释放它。
 * - 每次 `prepare()` 创建独立的 `QoderContext` 与 `RequestResult`，并在
 *   `try/finally` 中**立即释放**（成功与失败路径都释放），返回的字符串也逐个
 *   free —— 否则 wasm 线性内存只增不减，最终 trap `unreachable`。
 * - `QoderSigner.dispose()` 只释放**本 signer** 的引用计数，不销毁其他 signer
 *   仍在使用的共享 WASM。进程级最终释放属于 Task 15。
 *
 * ## 三个实测踩过的坑（改动时务必保留）
 *
 * 1. **两个 `getRandomValues` import 的签名方向相反**：一个写 wasm 内存，一个调
 *    JS 对象；写反会得到 Rust panic `unreachable`。
 * 2. **返回值布局有两套**：字符串类为 `ptr/len/valIdx/isErr`，而
 *    `qodercontext_new` / `prepareRequest` 为 `ptr/errIdx/isErr`；混用会得到
 *    `null pointer passed to rust`。
 * 3. **`requestresult_url(栈指针, ptr)` 参数顺序与直觉相反**（栈指针在前）。
 *
 * ⚠️ 只释放「对象」与「返回值字符串」，**绝不碰输入字符串**：`qodercontext_new`
 * 的输入由 Rust 侧持有，手工释放会当场 trap `unreachable`。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  QODER_CLIENT_METADATA,
  QODER_COSY_VERSION,
  QoderSearchProtocolError,
  type PreparedRequest,
  type QoderRequestSigner,
  type QoderSigningCredential,
} from './protocol.ts'

/** wasm-bindgen 生成的 import 对象名；WASM 里 embed 了这个路径，必须完全一致。 */
const IMPORT_MODULE = './qoder_auth_wasm_bg.js'

/** `generate_runtime_auth_fields` 的产物。 */
interface QoderRuntimeAuthFields {
  encrypt_user_info: string
  key: string
}

/** 本模块只用 `.buffer`（用于建立 TypedArray 视图）。 */
interface WasmMemory {
  readonly buffer: ArrayBuffer
}

type WasmFn = (...args: number[]) => number
type WasmExports = Record<string, WasmFn> & { readonly memory: WasmMemory }

/** 可释放的 wasm 对象导出名；刻意不包含输入字符串的释放入口。 */
type WasmFreeExport = '__wbg_requestresult_free' | '__wbg_qodercontext_free'

/** 进程级共享 WASM 的 glue 状态。 */
interface Glue {
  readonly exports: WasmExports
  heap(): Uint8Array<ArrayBuffer>
  view(): DataView
  readString(ptr: number, len: number): string
  writeString(text: string): number
  lastLength(): number
  heapObject(index: number): unknown
  pushObject(value: unknown): number
  takeObject(index: number): unknown
  callString(invoke: (stack: number) => void): string
  callPointer(invoke: (stack: number) => void): number
  freePointer(name: WasmFreeExport, ptr: number): void
  freeString(ptr: number, len: number): void
  memoryBytes(): number
}

/** 测试可观察的生命周期计数；生产路径只写不读。 */
interface WasmStats {
  /** 共享 WASM 实例化次数；用于证明 dispose 不会重新实例化/销毁共享实例。 */
  glueLoads: number
  /** 仍存活的 `QoderSigner` 引用数。 */
  signerRefs: number
  contextsCreated: number
  contextsFreed: number
  resultsCreated: number
  resultsFreed: number
  stringsFreed: number
}

const wasmStats: WasmStats = {
  glueLoads: 0,
  signerRefs: 0,
  contextsCreated: 0,
  contextsFreed: 0,
  resultsCreated: 0,
  resultsFreed: 0,
  stringsFreed: 0,
}

/** 进程级共享 WASM；Task 15 才负责在在飞归零后最终释放。 */
let gluePromise: Promise<Glue> | null = null

function getGlue(): Promise<Glue> {
  if (gluePromise === null) {
    gluePromise = createGlue().catch((error: unknown) => {
      // 资产缺失/实例化失败不应永久缓存拒绝，便于安装修复后重试。
      gluePromise = null
      throw error
    })
  }
  return gluePromise
}

/**
 * 解析 WASM 资产路径。
 *
 * 源码布局（vitest）与构建产物布局（`lib/index.js`）相对位置不同，按顺序探测：
 * - `src/host/channels/qoder/signer.ts` → `../../../../assets/qoder/...`
 * - `lib/index.js` → `../assets/qoder/...`
 */
function resolveWasmPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(here, '../../../../assets/qoder/qoder-auth-wasm.wasm'),
    resolve(here, '../assets/qoder/qoder-auth-wasm.wasm'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new QoderSearchProtocolError(
    'SEARCH_FAILED',
    'Qoder signing asset is missing: assets/qoder/qoder-auth-wasm.wasm',
  )
}

/** 真正实例化 WASM 并接好 import。 */
async function createGlue(): Promise<Glue> {
  const wasmBytes = readFileSync(resolveWasmPath())
  // 显式复制到 ArrayBuffer 支撑的 Uint8Array，避免 Buffer 的 ArrayBufferLike
  // 泛型与 WebAssembly.compile 的 BufferSource 类型不兼容。
  const bytes = new Uint8Array(wasmBytes.byteLength)
  bytes.set(wasmBytes)
  const module = await WebAssembly.compile(bytes)

  let exports: WasmExports = { memory: { buffer: new ArrayBuffer(0) } } as unknown as WasmExports
  let cachedHeap: Uint8Array<ArrayBuffer> | null = null
  let cachedBuffer: ArrayBuffer | null = null
  let cachedView: DataView | null = null

  const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
  const encoder = new TextEncoder()

  const heap = (): Uint8Array<ArrayBuffer> => {
    const buffer = exports.memory.buffer
    if (cachedHeap === null || cachedBuffer !== buffer) {
      cachedHeap = new Uint8Array(buffer)
      cachedBuffer = buffer
    }
    return cachedHeap
  }
  const view = (): DataView => {
    const buffer = exports.memory.buffer
    if (cachedView === null || cachedView.buffer !== buffer) {
      cachedView = new DataView(buffer)
    }
    return cachedView
  }
  const readString = (ptr: number, len: number): string =>
    decoder.decode(heap().subarray(ptr >>> 0, (ptr >>> 0) + len))

  /** 对象堆（与官方一致：1024 个 undefined，再 push 四个哨兵）。 */
  const objects: unknown[] = new Array(1024).fill(undefined)
  objects.push(undefined, null, true, false)
  let firstFree = objects.length
  const heapObject = (index: number): unknown => objects[index]
  const pushObject = (value: unknown): number => {
    if (firstFree === objects.length) objects.push(objects.length + 1)
    const index = firstFree
    firstFree = objects[index] as number
    objects[index] = value
    return index
  }
  const takeObject = (index: number): unknown => {
    const value = heapObject(index)
    // 索引 < 1028 是哨兵（undefined/null/true/false），不可回收。
    if (index >= 1028) {
      objects[index] = firstFree
      firstFree = index
    }
    return value
  }

  let lastLength = 0
  const writeString = (text: string): number => {
    const encoded = encoder.encode(text)
    const ptr = exports.__wbindgen_export2!(encoded.length, 1) >>> 0
    heap().subarray(ptr, ptr + encoded.length).set(encoded)
    lastLength = encoded.length
    return ptr
  }

  const callString = (invoke: (stack: number) => void): string => {
    let ptr = 0
    let len = 0
    const stack = exports.__wbindgen_add_to_stack_pointer!(-16)
    try {
      invoke(stack)
      const data = view()
      ptr = data.getInt32(stack + 0, true)
      len = data.getInt32(stack + 4, true)
      const isError = data.getInt32(stack + 12, true)
      if (isError) throw takeObject(data.getInt32(stack + 8, true))
      return readString(ptr, len)
    } catch (error) {
      throw describeWasmFailure(error)
    } finally {
      exports.__wbindgen_add_to_stack_pointer!(16)
      if (ptr) freeString(ptr, len)
    }
  }

  const callPointer = (invoke: (stack: number) => void): number => {
    const stack = exports.__wbindgen_add_to_stack_pointer!(-16)
    try {
      invoke(stack)
      const data = view()
      const ptr = data.getInt32(stack + 0, true)
      const isError = data.getInt32(stack + 8, true)
      if (isError) throw takeObject(data.getInt32(stack + 4, true))
      return ptr
    } catch (error) {
      throw describeWasmFailure(error)
    } finally {
      exports.__wbindgen_add_to_stack_pointer!(16)
    }
  }

  /**
   * 释放 wasm 堆上的 Rust 对象。
   *
   * ⚠️ 第二参恒为 `0`：那是 `<T as IntoWasmAbi>` 的额外 ABI 槽位，实测导出
   * arity 为 2；指针为 0 时跳过（哨兵 0 代表「无对象」）。
   */
  const freePointer = (name: WasmFreeExport, ptr: number): void => {
    if (ptr === 0) return
    try {
      exports[name]!(ptr, 0)
    } catch (error) {
      throw describeWasmFailure(error)
    }
    if (name === '__wbg_qodercontext_free') wasmStats.contextsFreed += 1
    else wasmStats.resultsFreed += 1
  }

  /**
   * 释放 wasm-bindgen 的返回值字符串（`__wbindgen_export4(ptr, len, 1)`）。
   *
   * ⚠️ 与 `freePointer` 是两套 ABI：那个是 `(ptr, 0)`，这个是 `(ptr, len, 1)`。
   * 不释放会按返回值长度每次泄漏（url + body ≈ 1:1）。
   */
  const freeString = (ptr: number, len: number): void => {
    if (ptr === 0) return
    try {
      exports.__wbindgen_export4!(ptr, len, 1)
    } catch (error) {
      throw describeWasmFailure(error)
    }
    wasmStats.stringsFreed += 1
  }

  /** wasm-bindgen 的「调用 JS 函数并捕获异常」包装。 */
  const guard = (fn: (...args: number[]) => void, args: number[]): void => {
    try {
      fn(...args)
    } catch (error) {
      exports.__wbindgen_export!(pushObject(error))
    }
  }

  const imports: Record<string, (...args: number[]) => unknown> = {
    __wbindgen_object_drop_ref: (a: number) => takeObject(a),
    __wbindgen_object_clone_ref: (a: number) => pushObject(heapObject(a)),
    __wbindgen_cast_0000000000000001: (a: number, e: number) =>
      pushObject(heap().subarray(a >>> 0, (a >>> 0) + e)),
    __wbindgen_cast_0000000000000002: (a: number, e: number) => pushObject(readString(a, e)),
    __wbg_set_08463b1df38a7e29: (a: number, e: number, t: number) =>
      pushObject((heapObject(a) as Uint8Array).set(heapObject(e) as Uint8Array, heapObject(t) as number)),
    // ⚠️ 这两个签名方向相反：一个写 wasm 内存，一个调 JS 对象。
    __wbg_getRandomValues_d49329ff89a07af1: (...a: number[]) =>
      guard((x: number, y: number) => {
        globalThis.crypto.getRandomValues(heap().subarray(x >>> 0, (x >>> 0) + y))
      }, a),
    __wbg_getRandomValues_c44a50d8cfdaebeb: (...a: number[]) =>
      guard((x: number, y: number) => {
        ;(heapObject(x) as { getRandomValues: (value: unknown) => void }).getRandomValues(heapObject(y))
      }, a),
    __wbg_crypto_38df2bab126b63dc: (a: number) =>
      pushObject((heapObject(a) as { crypto: unknown }).crypto),
    __wbg_process_44c7a14e11e9f69e: (a: number) =>
      pushObject((heapObject(a) as { process: unknown }).process),
    __wbg_versions_276b2795b1c6a219: (a: number) =>
      pushObject((heapObject(a) as { versions: unknown }).versions),
    __wbg_node_84ea875411254db1: (a: number) => pushObject((heapObject(a) as { node: unknown }).node),
    // 官方 glue 返回 CommonJS `module`；ESM 宿主没有该全局，WASM 也不会用它取 crypto。
    __wbg_require_b4edbdcf3e2a1ef0: (...a: number[]) => guard(() => pushObject(undefined), a),
    __wbg_msCrypto_bd5a034af96bcba6: (a: number) =>
      pushObject((heapObject(a) as { msCrypto: unknown }).msCrypto),
    __wbg_randomFillSync_6c25eac9869eb53c: (...a: number[]) =>
      guard((x: number, y: number) => {
        ;(heapObject(x) as { randomFillSync: (value: unknown) => void }).randomFillSync(takeObject(y))
      }, a),
    __wbg_call_d578befcc3145dee: (...a: number[]) =>
      guard((fn: number, self: number, arg: number) => {
        const target = heapObject(fn) as { call: (thisArg: unknown, ...rest: unknown[]) => unknown }
        pushObject(target.call(heapObject(self), heapObject(arg)))
      }, a),
    __wbg_new_with_length_9cedd08484b73942: (a: number) => pushObject(new Uint8Array(a >>> 0)),
    __wbg_length_0c32cb8543c8e4c8: (a: number) => (heapObject(a) as { length: number }).length,
    __wbg_prototypesetcall_3e05eb9545565046: (a: number, e: number, t: number) => {
      Uint8Array.prototype.set.call(heap().subarray(a >>> 0, (a >>> 0) + e), heapObject(t) as Uint8Array)
    },
    __wbg_subarray_0f98d3fb634508ad: (a: number, e: number, t: number) =>
      pushObject((heapObject(a) as Uint8Array).subarray(e >>> 0, t >>> 0)),
    __wbg_new_99cabae501c0a8a0: () => pushObject(new Map()),
    __wbg_now_88621c9c9a4f3ffc: () => Date.now(),
    __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () => pushObject(globalThis),
    __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () => pushObject(globalThis),
    __wbg_static_accessor_SELF_24f78b6d23f286ea: () =>
      (globalThis as { self?: unknown }).self === undefined
        ? 0
        : pushObject((globalThis as { self?: unknown }).self),
    __wbg_static_accessor_WINDOW_59fd959c540fe405: () =>
      (globalThis as { window?: unknown }).window === undefined
        ? 0
        : pushObject((globalThis as { window?: unknown }).window),
    __wbg___wbindgen_throw_81fc77679af83bc6: (p: number, l: number) => {
      throw new Error(readString(p, l))
    },
    __wbg_Error_2e59b1b37a9a34c3: (p: number, l: number) => pushObject(new Error(readString(p, l))),
    __wbg___wbindgen_is_object_40c5a80572e8f9d3: (id: number) => {
      const value = heapObject(id)
      return typeof value === 'object' && value !== null
    },
    __wbg___wbindgen_is_string_b29b5c5a8065ba1a: (id: number) => typeof heapObject(id) === 'string',
    __wbg___wbindgen_is_function_49868bde5eb1e745: (id: number) => typeof heapObject(id) === 'function',
    __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: (id: number) => heapObject(id) === undefined,
  }

  const instance = await WebAssembly.instantiate(module, { [IMPORT_MODULE]: imports })
  exports = instance.exports as unknown as WasmExports
  wasmStats.glueLoads += 1

  return {
    exports,
    heap,
    view,
    readString,
    writeString,
    lastLength: () => lastLength,
    heapObject,
    pushObject,
    takeObject,
    callString,
    callPointer,
    freePointer,
    freeString,
    memoryBytes: () => exports.memory.buffer.byteLength,
  }
}

/**
 * 把 V8 对 wasm `unreachable` trap 的裸报文改写成可自解释的错误。
 *
 * 裸 `unreachable` 不含 host / 阶段信息；真实成因通常是 wasm 堆耗尽或 Rust
 * panic。只改写报文**恰好**是 `unreachable` 的 `RuntimeError`，其他原样放行。
 */
function describeWasmFailure(error: unknown): unknown {
  if (!(error instanceof Error) || error.name !== 'RuntimeError') return error
  if (error.message.trim() !== 'unreachable') return error
  return new Error(
    'qoder signing WASM trapped with "unreachable" (WASM heap exhausted or a Rust panic); '
    + 'restart the host to reset the shared WASM heap',
    { cause: error },
  )
}

/** 生成运行时鉴权字段（`encrypt_user_info` / `key`）。 */
function generateRuntimeAuthFields(
  glue: Glue,
  user: QoderSigningCredential,
): QoderRuntimeAuthFields {
  const payload = JSON.stringify({
    uid: user.uid ?? '',
    security_oauth_token: user.securityOauthToken,
    organization_id: user.organizationId ?? '',
    organization_tags: [],
    data_policy_agreed: false,
  })
  const raw = glue.callString((stack) => {
    const ptr = glue.writeString(payload)
    glue.exports.generate_runtime_auth_fields!(stack, ptr, glue.lastLength())
  })
  try {
    return JSON.parse(raw) as QoderRuntimeAuthFields
  } catch {
    // 原始报文含 encrypt_user_info / key（签名秘密），不得进入错误消息。
    throw new QoderSearchProtocolError(
      'SEARCH_FAILED',
      'qoder signing failed: malformed auth fields returned by the bundled WASM',
    )
  }
}

/** 创建本次签名独占的 `QoderContext`；调用方必须在 finally 中释放。 */
function createContext(glue: Glue, machineId: string, userInfoJson: string): number {
  const metadataJson = JSON.stringify(QODER_CLIENT_METADATA)
  const context = glue.callPointer((stack) => {
    const machine = glue.writeString(machineId)
    const machineLen = glue.lastLength()
    const version = glue.writeString(QODER_COSY_VERSION)
    const versionLen = glue.lastLength()
    const info = glue.writeString(userInfoJson)
    const infoLen = glue.lastLength()
    const metadata = glue.writeString(metadataJson)
    const metadataLen = glue.lastLength()
    // 参数顺序：(sp, machineId, len, version, len, userInfo, len, clientMeta, len)
    glue.exports.qodercontext_new!(
      stack,
      machine, machineLen,
      version, versionLen,
      info, infoLen,
      metadata, metadataLen,
    )
  })
  if (context !== 0) wasmStats.contextsCreated += 1
  return context
}

/** 用 `qodercontext_prepareRequest` 生成签名 URL / 头 / 密文 body。 */
function prepareSignedRequest(
  glue: Glue,
  context: number,
  endpoint: string,
  path: string,
  body: string,
): PreparedRequest {
  const result = glue.callPointer((stack) => {
    const endpointPtr = glue.writeString(endpoint)
    const endpointLen = glue.lastLength()
    const pathPtr = glue.writeString(path)
    const pathLen = glue.lastLength()
    const methodPtr = glue.writeString('POST')
    const methodLen = glue.lastLength()
    const modePtr = glue.writeString('auth')
    const modeLen = glue.lastLength()
    const bodyPtr = glue.writeString(body)
    const bodyLen = glue.lastLength()
    // 可选 headers 缺席传 0（glue 的 `MX(r) ? 0 : ...` 语义），不能传空串指针。
    glue.exports.qodercontext_prepareRequest!(
      stack,
      context,
      endpointPtr, endpointLen,
      pathPtr, pathLen,
      methodPtr, methodLen,
      modePtr, modeLen,
      bodyPtr, bodyLen,
      0, 0,
    )
  })
  if (result !== 0) wasmStats.resultsCreated += 1

  // url / headers / body 全部拷进 JS 后即可释放 result；用 try/finally 覆盖
  // 读取抛错的路径，否则异常路径反倒成了泄漏最多的那条。
  try {
    const headerMap = glue.takeObject(glue.exports.requestresult_headers!(result))
    const headers: Record<string, string> = {}
    if (headerMap instanceof Map) {
      for (const [key, value] of headerMap) headers[String(key)] = String(value)
    }

    const readResultString = (invoke: (stack: number, ptr: number) => void): string => {
      let out = ''
      let outPtr = 0
      let outLen = 0
      const data = glue.view()
      const stack = glue.exports.__wbindgen_add_to_stack_pointer!(-16)
      try {
        invoke(stack, result)
        outPtr = data.getInt32(stack + 0, true)
        outLen = data.getInt32(stack + 4, true)
        out = outPtr ? glue.readString(outPtr, outLen) : ''
      } finally {
        glue.exports.__wbindgen_add_to_stack_pointer!(16)
        // requestresult_url / requestresult_body 返回的是 Rust 新分配的 String，
        // 所有权已交给 JS，必须释放（否则每次泄漏 ≈ url+body 长度）。
        glue.freeString(outPtr, outLen)
      }
      return out
    }

    return {
      // ⚠️ 参数顺序：(栈指针, ptr) —— 与直觉相反。
      url: readResultString((stack, ptr) => glue.exports.requestresult_url!(stack, ptr)),
      headers,
      body: readResultString((stack, ptr) => glue.exports.requestresult_body!(stack, ptr)),
    }
  } finally {
    glue.freePointer('__wbg_requestresult_free', result)
  }
}

/** 一次签名：auth 字段 → 独占上下文 → 签名请求，上下文在 finally 释放。 */
function signOnce(
  glue: Glue,
  endpoint: string,
  path: string,
  body: string,
  credential: QoderSigningCredential,
): PreparedRequest {
  const fields = generateRuntimeAuthFields(glue, credential)
  const userInfoJson = JSON.stringify({
    uid: credential.uid ?? '',
    encrypt_user_info: fields.encrypt_user_info,
    key: fields.key,
    organization_id: credential.organizationId ?? '',
    organization_tags: [],
    data_policy_agreed: false,
  })

  let context = 0
  try {
    context = createContext(glue, credential.machineId, userInfoJson)
    return prepareSignedRequest(glue, context, endpoint, path, body)
  } finally {
    // 🔴 只释放 context：qodercontext_new 的输入字符串由 Rust 侧持有。
    if (context !== 0) glue.freePointer('__wbg_qodercontext_free', context)
  }
}

/** host 必须是裸域名；带 scheme / 端口 / 路径都视为调用方错误。 */
function normalizeEndpoint(host: string): string {
  const trimmed = typeof host === 'string' ? host.trim() : ''
  if (trimmed.length === 0 || /[\s/?#:]/.test(trimmed)) {
    throw new QoderSearchProtocolError(
      'SEARCH_FAILED',
      'qoder signer requires a bare host name (for example gateway.qoder.com.cn)',
    )
  }
  return `https://${trimmed}`
}

/** 签名输入 path 必须是以 `/` 开头的绝对路径。 */
function assertSigningPath(path: string): void {
  if (typeof path !== 'string' || !path.startsWith('/') || /[\s?#]/.test(path)) {
    throw new QoderSearchProtocolError('SEARCH_FAILED', 'qoder signer requires an absolute request path')
  }
}

/** 缺 token / machineId 必须在任何 WASM 工作之前失败。 */
function requireSigningCredential(
  credential: QoderSigningCredential | null | undefined,
): QoderSigningCredential {
  if (typeof credential !== 'object' || credential === null) throw noAccount()
  const token = typeof credential.securityOauthToken === 'string'
    ? credential.securityOauthToken.trim()
    : ''
  const machineId = typeof credential.machineId === 'string' ? credential.machineId.trim() : ''
  if (token.length === 0 || machineId.length === 0) throw noAccount()
  return credential
}

function noAccount(): QoderSearchProtocolError {
  return new QoderSearchProtocolError(
    'NO_ACCOUNT',
    'Qoder search has no usable account; sign in to a Qoder account first',
  )
}

/** 调用前已 abort：超时原因按超时归因，其余按取消归因。 */
function throwIfAborted(signal: AbortSignal): void {
  if (signal === undefined || signal === null || !signal.aborted) return
  if (isTimeoutReason(signal.reason)) {
    throw new QoderSearchProtocolError(
      'TIMEOUT',
      'qoder search timed out before signing (the host tool budget elapsed)',
    )
  }
  throw new QoderSearchProtocolError('SEARCH_FAILED', 'qoder search aborted by the caller')
}

function isTimeoutReason(reason: unknown): boolean {
  const record = reason as { name?: unknown; code?: unknown } | undefined
  return record?.name === 'TimeoutReason'
    || record?.name === 'TimeoutError'
    || record?.code === 'TOOL_TIMEOUT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 一次搜索签名句柄。
 *
 * - 每次 `prepare()` 的资源（context / result / 返回字符串）在方法返回前释放；
 * - `dispose()` 只释放本句柄的引用计数，**不**销毁共享 WASM；
 * - 已 `dispose()` 的句柄拒绝新签名，但在飞调用会安全完成。
 */
export class QoderSigner implements QoderRequestSigner {
  private disposed = false
  private inflightCount = 0
  /** dispose 时仍有在飞签名：等在飞归零后再释放引用，避免提前销毁共享 WASM。 */
  private releaseWhenIdle = false

  constructor() {
    wasmStats.signerRefs += 1
  }

  /** 当前在飞签名数；生命周期所有者据此等待归零。 */
  get inflight(): number {
    return this.inflightCount
  }

  /** 本句柄是否已 dispose。 */
  get isDisposed(): boolean {
    return this.disposed
  }

  async prepare(
    host: string,
    path: string,
    body: string,
    credential: QoderSigningCredential,
    signal: AbortSignal,
  ): Promise<PreparedRequest> {
    if (this.disposed) {
      throw new QoderSearchProtocolError('SEARCH_FAILED', 'qoder signer has been disposed')
    }
    // 顺序很重要：凭据 → 输入 → 取消，全部先于 WASM/网络工作。
    const usable = requireSigningCredential(credential)
    const endpoint = normalizeEndpoint(host)
    assertSigningPath(path)
    throwIfAborted(signal)

    this.inflightCount += 1
    try {
      const glue = await getGlue()
      throwIfAborted(signal)
      return signOnce(glue, endpoint, path, body, usable)
    } catch (error) {
      // 内部异常（编码失败、WASM trap、JSON 结构异常）统一归到可路由类别；
      // 消息只带底层错误文本，绝不拼接 token / machineId / 签名头。
      if (error instanceof QoderSearchProtocolError) throw error
      throw new QoderSearchProtocolError(
        'SEARCH_FAILED',
        `qoder signing failed: ${errorMessage(error)}`,
        undefined,
        error,
      )
    } finally {
      this.finishOperation()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.inflightCount === 0) wasmStats.signerRefs -= 1
    else this.releaseWhenIdle = true
  }

  /** 在飞归零；若 dispose 已发生，此时才释放本句柄的引用。 */
  private finishOperation(): void {
    this.inflightCount -= 1
    if (this.inflightCount === 0 && this.releaseWhenIdle) {
      this.releaseWhenIdle = false
      wasmStats.signerRefs -= 1
    }
  }
}

/**
 * 测试与 Task 15 的只读观察口。
 *
 * ⚠️ 生产路径不会调用；这里不提供释放共享 WASM 的入口 —— 进程级最终释放属于
 * Task 15，避免本任务的 dispose 语义被误用成全局销毁。
 */
export const __testing = {
  wasmStats(): Readonly<WasmStats> {
    return { ...wasmStats }
  },
  async wasmHeapBytes(): Promise<number> {
    const glue = await getGlue()
    return glue.memoryBytes()
  },
}
