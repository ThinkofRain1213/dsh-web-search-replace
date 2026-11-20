/** per-path 串行 route broker：handler 代际与底层 registration 分轨管理。 */
import type { ManagementRpcConnection, ManagementRpcRoute } from '../shared/rpc.ts'

interface Registration {
  readonly token: symbol
  readonly handler: ManagementRpcRoute['fetch']
  active: boolean
}

interface UnderlyingRoute {
  readonly owner: Registration
  readonly disposer: () => Promise<void>
}

interface RouteBucket {
  current?: Registration
  currentHandler?: ManagementRpcRoute['fetch']
  underlying?: UnderlyingRoute
  queue: Promise<void>
  busy: boolean
}

const buckets = new WeakMap<ManagementRpcConnection, Map<string, RouteBucket>>()

export interface GenerationRouteRegistration {
  readonly ready: Promise<void>
  dispose(): Promise<void>
}

export function registerGenerationRoute(
  connection: ManagementRpcConnection,
  route: ManagementRpcRoute,
): GenerationRouteRegistration {
  const byPath = buckets.get(connection) ?? new Map<string, RouteBucket>()
  buckets.set(connection, byPath)
  const bucket = byPath.get(route.path) ?? { queue: Promise.resolve(), busy: false }
  byPath.set(route.path, bucket)
  const registration: Registration = {
    token: Symbol(route.path),
    handler: route.fetch,
    active: true,
  }

  // 新 handler 可立即接管稳定代理，保持旧调用方同步语义；底层 route 的
  // register/dispose 仍严格按同一 per-path 队列执行，ready 只在其真正完成后兑现。
  bucket.current = registration
  bucket.currentHandler = registration.handler
  const ready = enqueue(bucket, async () => {
    if (!registration.active) return
    if (bucket.underlying !== undefined) await retireUnderlying(bucket)
    if (!registration.active) return
    try {
      const disposer = connection.fetch.register({
        ...route,
        fetch: async (request) => {
          const handler = bucket.currentHandler
          if (handler === undefined) return new Response('route generation is unavailable', { status: 503 })
          return await handler(request)
        },
      })
      bucket.underlying = { owner: registration, disposer }
      if (!registration.active) await retireUnderlying(bucket, registration)
    } catch (error) {
      if (bucket.current === registration) {
        bucket.current = undefined
        bucket.currentHandler = undefined
      }
      throw error
    }
  })

  return {
    ready,
    dispose: () => {
      registration.active = false
      return enqueue(bucket, async () => {
        if (bucket.current === registration) {
          bucket.current = undefined
          bucket.currentHandler = undefined
        }
        await retireUnderlying(bucket, registration)
      })
    },
  }
}

/** 必须只在 per-path queue 内调用；owner 不匹配时旧 disposer 是 no-op。 */
async function retireUnderlying(
  bucket: RouteBucket,
  owner?: Registration,
): Promise<void> {
  const underlying = bucket.underlying
  if (underlying === undefined) return
  if (owner !== undefined && underlying.owner !== owner) return
  bucket.underlying = undefined
  await underlying.disposer()
}

function enqueue(bucket: RouteBucket, operation: () => Promise<void>): Promise<void> {
  if (bucket.busy) {
    const result = bucket.queue.then(operation, operation)
    bucket.queue = result.then(() => undefined, () => undefined)
    return result
  }
  bucket.busy = true
  let result: Promise<void>
  try {
    // 空队列时保留 DSH 同步注册语义；异步函数在首个真正 await 前同步执行。
    result = operation()
  } catch (error) {
    bucket.busy = false
    return Promise.reject(error)
  }
  bucket.queue = result.then(
    () => { bucket.busy = false },
    () => { bucket.busy = false },
  )
  return result
}
