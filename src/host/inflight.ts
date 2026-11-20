/** 只负责已创建 operation 的在飞计数与 settle；取消由 PluginLifecycle 的 signal 负责。 */

export class InFlightStoppedError extends Error {
  readonly code = 'lifecycle/stopped'

  constructor() {
    super('plugin lifecycle is no longer accepting operations')
    this.name = 'InFlightStoppedError'
  }
}

export class InFlight {
  private readonly operations = new Set<Promise<unknown>>()
  private idleWaiters = new Set<() => void>()
  private accepting = true

  get size(): number {
    return this.operations.size
  }

  get isAccepting(): boolean {
    return this.accepting
  }

  track<T>(operation: Promise<T>): Promise<T> {
    if (!this.accepting) throw new InFlightStoppedError()
    this.operations.add(operation)
    const remove = () => {
      this.operations.delete(operation)
      if (this.operations.size > 0) return
      for (const resolve of this.idleWaiters) resolve()
      this.idleWaiters.clear()
    }
    // then 的两个分支都处理，避免 finally 产生新的未处理拒绝。
    void operation.then(remove, remove)
    return operation
  }

  stopAccepting(): void {
    this.accepting = false
  }

  async settle(): Promise<void> {
    if (this.operations.size === 0) return
    await new Promise<void>((resolve) => { this.idleWaiters.add(resolve) })
  }
}
