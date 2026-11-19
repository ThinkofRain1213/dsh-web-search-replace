/**
 * 测试替身：内存版 credentials provider。
 *
 * 只实现本插件用到的 record 半边（read/modify/delete/list），并刻意复现真实
 * provider 的两个关键语义：
 *
 * 1. `modifyRecord` 是**独占读改写**：所有调用串行进入同一条队列，mutate 看到
 *    的是轮到它时的当前记录；返回 `undefined` 表示不改动。
 * 2. `listRecords` 只返回 key 与 kind，绝不返回 payload。
 *
 * 测试用它验证账号库的 scope/channel 过滤、并发写入与写失败回滚，不接触任何
 * 真实凭据或网络。
 */
import type {
  AccountCredentialProvider,
  AccountCredentialRecordEntry,
} from '../../../src/host/accounts/store.ts'

/** 一条内存记录；payload 由账号库自行解释。 */
export interface MemoryCredentialRecord {
  readonly kind: string
  /** api-key 记录的键值（本插件不会读取，但真实 provider 允许）。 */
  readonly key?: string
  /** api-key 记录的环境变量值。 */
  readonly env?: Readonly<Record<string, string>>
  readonly payload?: unknown
}

/** 深拷贝，模拟跨进程/JSON 存储边界，避免测试与实现共享可变对象。 */
function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}

/** 内存 credentials provider；测试可注入一次性失败。 */
export class MemoryCredentials implements AccountCredentialProvider {
  private readonly records = new Map<string, MemoryCredentialRecord>()
  private queue: Promise<unknown> = Promise.resolve()

  /** 所有被读取的 key，用于断言实现只碰本插件 scope。 */
  readonly reads: string[] = []
  /** 所有被 modifyRecord 的 key。 */
  readonly writes: string[] = []
  /** 所有被 deleteRecord 的 key。 */
  readonly deletes: string[] = []

  /** 让下一次 modifyRecord 以给定错误失败。 */
  failNextModify: Error | undefined
  /** 让下一次 readRecord 以给定错误失败。 */
  failNextRead: Error | undefined
  /** 让下一次 deleteRecord 以给定错误失败。 */
  failNextDelete: Error | undefined
  /** 让下一次 listRecords 以给定错误失败。 */
  failNextList: Error | undefined

  /** 直接写入一条记录（模拟外部/历史数据）。 */
  seed(key: string, record: MemoryCredentialRecord): void {
    this.records.set(key, clone(record))
  }

  /** 读取原始记录快照。 */
  raw(key: string): MemoryCredentialRecord | undefined {
    return clone(this.records.get(key))
  }

  /** 当前所有 key。 */
  keys(): readonly string[] {
    return [...this.records.keys()]
  }

  async readRecord(key: string): Promise<unknown> {
    this.reads.push(key)
    const failure = this.failNextRead
    if (failure !== undefined) {
      this.failNextRead = undefined
      throw failure
    }
    return clone(this.records.get(key))
  }

  async modifyRecord(
    key: string,
    mutate: (current: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    const run = this.queue.then(async () => {
      this.writes.push(key)
      const failure = this.failNextModify
      if (failure !== undefined) {
        this.failNextModify = undefined
        throw failure
      }
      const current = clone(this.records.get(key))
      const next = await mutate(current)
      if (next === undefined) return current
      this.records.set(key, clone(next as MemoryCredentialRecord))
      return clone(next)
    })
    // 队列本身不能因为一次失败而中断；失败仍原样抛给本次调用方。
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  async deleteRecord(key: string): Promise<void> {
    this.deletes.push(key)
    const failure = this.failNextDelete
    if (failure !== undefined) {
      this.failNextDelete = undefined
      throw failure
    }
    this.records.delete(key)
  }

  async listRecords(): Promise<readonly AccountCredentialRecordEntry[]> {
    const failure = this.failNextList
    if (failure !== undefined) {
      this.failNextList = undefined
      throw failure
    }
    return [...this.records.entries()].map(([key, record]) => ({
      key,
      kind: record.kind,
    }))
  }
}
