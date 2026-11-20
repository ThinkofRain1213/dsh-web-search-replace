/** 单一 activation 的接单门禁、取消合成与在飞 settle 协调器。 */
import { InFlight, InFlightStoppedError } from './inflight.ts'

export { InFlightStoppedError } from './inflight.ts'

export interface LifecycleLease {
  readonly signal: AbortSignal
  track<T>(operation: Promise<T>): Promise<T>
}

export class PluginLifecycle {
  private readonly controller = new AbortController()
  private readonly inflight = new InFlight()
  private acceptingFlag = true
  private settling: Promise<void> | undefined

  get acceptingOperations(): boolean {
    return this.acceptingFlag
  }

  get acceptingState(): boolean {
    return this.acceptingFlag
  }

  get accepting(): boolean {
    return this.acceptingFlag
  }

  get inflightCount(): number {
    return this.inflight.size
  }

  /** 必须在创建 operation Promise 前调用；stop 后同步拒绝。 */
  begin(callerSignal?: AbortSignal): LifecycleLease {
    if (!this.acceptingFlag) throw new InFlightStoppedError()
    const signal = callerSignal === undefined
      ? this.controller.signal
      : AbortSignal.any([this.controller.signal, callerSignal])
    return {
      signal,
      track: <T>(operation: Promise<T>): Promise<T> => this.inflight.track(operation),
    }
  }

  /** 兼容早期接口；新代码必须先 begin 取得合成 signal，再创建并 track operation。 */
  track<T>(operation: Promise<T>, _signal?: AbortSignal): Promise<T> {
    return this.inflight.track(operation)
  }

  /** 同步停止接单，但不 abort 已接受工作（OFF 也绝不应调用 abortAll）。 */
  stopAccepting(): void {
    if (!this.acceptingFlag) return
    this.acceptingFlag = false
    this.inflight.stopAccepting()
  }

  /** 同步 stop+abort，再等待全部已接受 operation 真正 settle。 */
  abortAllAndSettle(): Promise<void> {
    this.stopAccepting()
    this.controller.abort(new InFlightStoppedError())
    this.settling ??= this.inflight.settle()
    return this.settling
  }

  async dispose(): Promise<void> {
    await this.abortAllAndSettle()
  }
}
