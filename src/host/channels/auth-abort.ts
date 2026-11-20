/** 共享授权取消工具：只放弃等待，不假装底层物理操作已回滚。 */

/** 把可选 caller signal 与 flow 自有 controller 合成；无 caller 时保留原 signal。 */
export function combineAuthSignals(
  owner: AbortSignal,
  caller?: AbortSignal,
): AbortSignal {
  return caller === undefined ? owner : AbortSignal.any([owner, caller])
}

/**
 * 等待一个只读/另有 owner 跟踪的 Promise，并在 caller abort 时停止等待。
 * 原 Promise 的 rejection 始终有处理器；写操作必须在自身实现里接收同一 signal
 * 并由 owner 的在飞集合继续等待 settle。
 */
/** 把 caller abort 转发给 flow owner，并返回终态时的解绑函数。 */
export function forwardAuthAbort(owner: AbortController, caller?: AbortSignal): () => void {
  if (caller === undefined) return () => {}
  const abort = () => { owner.abort(caller.reason) }
  if (caller.aborted) {
    abort()
    return () => {}
  }
  caller.addEventListener('abort', abort, { once: true })
  return () => { caller.removeEventListener('abort', abort) }
}

export async function waitWithAuthAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  aborted: () => Error,
): Promise<T> {
  if (signal.aborted) throw aborted()
  let onAbort: (() => void) | undefined
  const cancellation = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(aborted()) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([operation, cancellation])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    // Promise.race 已给 operation 安装 settle 处理器，不会留下未处理拒绝。
    void operation.catch(() => {})
  }
}
