/** DSH 按 path 无条件 delete 的缺口由本插件的 generation-aware 稳定 route 代理闭合。 */
import type { ManagementRpcConnection, ManagementRpcRoute } from '../shared/rpc.ts'

interface RouteBucket {
  currentToken?: symbol
  currentHandler?: ManagementRpcRoute['fetch']
  underlyingDisposer?: () => Promise<void>
  queue: Promise<void>
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
  const bucket = byPath.get(route.path) ?? { queue: Promise.resolve() }
  byPath.set(route.path, bucket)
  const token = Symbol(route.path)

  // DSH 本体的 register 同步返回 disposer；同步建立稳定代理可保持既有注册语义，
  // ready/queue 负责后续 async setup 与代际串行化。
  if (bucket.underlyingDisposer === undefined) {
    bucket.underlyingDisposer = connection.fetch.register({
      ...route,
      fetch: async (request) => {
        const handler = bucket.currentHandler
        if (handler === undefined) return new Response('route generation is unavailable', { status: 503 })
        return await handler(request)
      },
    })
  }
  bucket.currentToken = token
  bucket.currentHandler = route.fetch
  const ready = Promise.resolve()

  return {
    ready,
    dispose: () => enqueue(bucket, async () => {
      // 新代已接管时旧代 disposer 是 no-op，绝不调用底层按 path delete。
      if (bucket.currentToken !== token) return
      bucket.currentToken = undefined
      bucket.currentHandler = undefined
      const disposer = bucket.underlyingDisposer
      bucket.underlyingDisposer = undefined
      await disposer?.()
      if (bucket.currentToken === undefined) byPath.delete(route.path)
    }),
  }
}

function enqueue(bucket: RouteBucket, operation: () => Promise<void>): Promise<void> {
  const result = bucket.queue.then(operation, operation)
  bucket.queue = result.then(() => undefined, () => undefined)
  return result
}
