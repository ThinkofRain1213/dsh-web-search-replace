/**
 * 测试专用：在 `TextEncoder.prototype.encode` 上注入确定性的顺序故障。
 *
 * 生产代码不得包含任何测试开关；I1 的「Rust 接管前输入清理」由本工具从测试侧
 * 触发：
 *
 * - `before-allocation`：匹配的输入在 `encode` 阶段直接抛错 —— 此时
 *   `writeString` 尚未分配 wasm 内存，验证调用方对**更早**已写输入的清理；
 * - `during-write`：先正常编码并返回一个索引访问会抛错的 Proxy ——
 *   `writeString` 已完成分配，在 `.set(encoded)` 时失败，验证 `writeString`
 *   自身的分配自清。
 *
 * 只匹配指定输入内容，其他 encode 调用原样放行；返回的 disposer 必须恢复
 * 原始实现（测试用 try/finally 或 afterEach 调用）。
 */
import { vi } from 'vitest'

export type TextEncoderFaultMode = 'before-allocation' | 'during-write'

export interface TextEncoderFaultOptions {
  /** 只对满足该判据的输入注入故障；其他调用走真实实现。 */
  readonly match: (input: string) => boolean
  readonly mode: TextEncoderFaultMode
  /** 故障错误的文本；测试可注入含假秘密的文本以验证脱敏。 */
  readonly message?: string
}

/** 安装故障；返回严格恢复函数。 */
export function installTextEncoderFault(options: TextEncoderFaultOptions): () => void {
  const original = TextEncoder.prototype.encode
  const message = options.message ?? 'injected TextEncoder failure'

  const spy = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
    this: TextEncoder,
    input?: string,
  ): Uint8Array<ArrayBuffer> {
    if (typeof input !== 'string' || !options.match(input)) {
      return original.call(this, input)
    }
    if (options.mode === 'before-allocation') {
      throw new Error(message)
    }
    const encoded = original.call(this, input)
    return new Proxy(encoded, {
      get(target, property) {
        // 读取数字索引模拟 `.set(encoded)` 的源数组访问失败；`length` 正常。
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          throw new Error(message)
        }
        // ⚠️ 必须用 target 作为 receiver：typed array 的 length 是 accessor，
        // 用 Proxy 当 receiver 会触发 incompatible receiver TypeError。
        return Reflect.get(target, property)
      },
    }) as unknown as Uint8Array<ArrayBuffer>
  })

  return () => { spy.mockRestore() }
}
