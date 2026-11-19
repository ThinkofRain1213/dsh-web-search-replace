/**
 * Qoder 国际版双域端点策略（`center.qoder.sh` / `api2.qoder.sh`）的行为守卫。
 *
 * ## 被锁死的契约
 *
 * 1. **自动初始**：每个「账号 + 网络出口」的首次调用只走 `center.qoder.sh`。
 * 2. **限定切换**：只有连接失败（DNS/TCP/TLS）、请求超时、上游 5xx 才在首域
 *    settle 后**顺序**尝试另一域一次；绝不并行双发、不后台测速、不换账号。
 * 3. **非限定错误不切换**：401/403/429、坏响应、签名/配置/账号/本地校验错误、
 *    调用方取消都只停留在首域；未知异常默认不切换。
 * 4. **粘性**：成功的域成为该账号 + 该网络出口在当前进程内的首选；不同账号、
 *    不同出口、不同策略实例（重启）互不共享；固定模式不写入 auto 粘性。
 * 5. **固定模式**：center / api2 只走所选域，任何错误都不切换。
 * 6. **可归因失败**：两域都失败时抛出含两个域名与结构化类别的安全错误；单 query
 *    每域最多一次；错误与观察记录都不含 query、凭据、账号键或底层异常原文。
 *
 * 全部使用注入 operation 的确定性桩，没有任何真实网络。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  QODER_INTERNATIONAL_HOSTS,
  QoderEndpointPolicy,
  QoderEndpointUnavailableError,
  type QoderEndpointObservation,
  type QoderEndpointOperationContext,
} from '../../src/host/channels/qoder/endpoint-policy.ts'
import {
  QoderSearchProtocolError,
  type QoderProtocolFailureCode,
  type QoderProtocolFailureKind,
} from '../../src/host/channels/qoder/protocol.ts'
import { ChannelSearchError } from '../../src/host/search/errors.ts'
import type { QoderEndpointPreference } from '../../src/shared/channels.ts'

const CENTER = 'center.qoder.sh'
const API2 = 'api2.qoder.sh'
const ACCOUNT_KEY = 'account-key-7f2c'
const EXIT_KEY = 'network-exit-7f2c'
const QUERY = '策略测试查询 7f2c'

/** 构造共享协议层失败；策略只能依赖结构化 kind/status，不能靠消息猜测。 */
function protocolError(
  kind: QoderProtocolFailureKind,
  options: {
    readonly code?: QoderProtocolFailureCode
    readonly status?: number
    readonly message?: string
  } = {},
): QoderSearchProtocolError {
  return new QoderSearchProtocolError(
    options.code ?? 'SEARCH_FAILED',
    options.message ?? `injected ${kind} failure for ${QUERY}`,
    kind,
    options.status === undefined ? {} : { status: options.status },
  )
}

interface Recorder {
  readonly hosts: string[]
  readonly contexts: readonly QoderEndpointOperationContext[]
  readonly maxConcurrent: number
  readonly operation: (context: QoderEndpointOperationContext) => Promise<string>
}

/** 记录每次尝试的域名、并发峰值与 operation 入参形状。 */
function recordingOperation(
  handler: (host: string, attempt: number) => Promise<string> | string,
): Recorder {
  const hosts: string[] = []
  const contexts: QoderEndpointOperationContext[] = []
  let active = 0
  let maxConcurrent = 0
  return {
    hosts,
    contexts,
    get maxConcurrent(): number {
      return maxConcurrent
    },
    async operation(context) {
      contexts.push(context)
      hosts.push(context.host)
      active += 1
      maxConcurrent = Math.max(maxConcurrent, active)
      try {
        return await handler(context.host, hosts.length)
      } finally {
        active -= 1
      }
    },
  }
}

interface PolicyHarness {
  readonly policy: QoderEndpointPolicy
  readonly observations: QoderEndpointObservation[]
}

function makePolicy(options: {
  readonly exitKey?: () => string
  readonly onObservation?: (observation: QoderEndpointObservation) => void
} = {}): PolicyHarness {
  const observations: QoderEndpointObservation[] = []
  const policy = new QoderEndpointPolicy({
    networkExitKey: options.exitKey ?? (() => EXIT_KEY),
    onObservation: (observation) => {
      observations.push(observation)
      options.onObservation?.(observation)
    },
  })
  return { policy, observations }
}

function execute(
  policy: QoderEndpointPolicy,
  preference: QoderEndpointPreference,
  operation: (context: QoderEndpointOperationContext) => Promise<string>,
  options: {
    readonly accountKey?: string
    readonly signal?: AbortSignal
  } = {},
): Promise<string> {
  return policy.execute({
    preference,
    accountKey: options.accountKey ?? ACCOUNT_KEY,
    operation,
    signal: options.signal ?? new AbortController().signal,
  })
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

describe('Qoder 国际版端点策略：自动初始与固定模式', () => {
  it('auto 首次调用只走 center.qoder.sh', async () => {
    const { policy } = makePolicy()
    const recorder = recordingOperation(() => 'ok')

    await expect(execute(policy, 'auto', recorder.operation)).resolves.toBe('ok')
    expect(recorder.hosts).toEqual([CENTER])
  })

  it('固定 center 成功时只走 center.qoder.sh', async () => {
    const { policy } = makePolicy()
    const recorder = recordingOperation(() => 'ok')

    await execute(policy, 'center', recorder.operation)
    expect(recorder.hosts).toEqual([CENTER])
  })

  it('固定 api2 成功时只走 api2.qoder.sh', async () => {
    const { policy } = makePolicy()
    const recorder = recordingOperation(() => 'ok')

    await execute(policy, 'api2', recorder.operation)
    expect(recorder.hosts).toEqual([API2])
  })

  it.each([
    ['连接失败', () => protocolError('connection')],
    ['请求超时', () => protocolError('timeout', { code: 'TIMEOUT' })],
    ['上游 5xx', () => protocolError('http_status', { status: 503 })],
    ['401 未授权', () => protocolError('http_status', { status: 401, code: 'UNAUTHORIZED' })],
    ['调用方取消', () => protocolError('aborted')],
  ])('固定 center 遇到%s也不切到 api2', async (_label, makeError) => {
    const { policy } = makePolicy()
    const recorder = recordingOperation(() => { throw makeError() })

    const error = await execute(policy, 'center', recorder.operation).catch(caught => caught)
    expect(error).toBeInstanceOf(QoderSearchProtocolError)
    expect(recorder.hosts).toEqual([CENTER])
  })

  it.each([
    ['连接失败', () => protocolError('connection')],
    ['请求超时', () => protocolError('timeout', { code: 'TIMEOUT' })],
    ['上游 5xx', () => protocolError('http_status', { status: 500 })],
    ['429 限流', () => protocolError('http_status', { status: 429, code: 'RATE_LIMITED' })],
  ])('固定 api2 遇到%s也不切到 center', async (_label, makeError) => {
    const { policy } = makePolicy()
    const recorder = recordingOperation(() => { throw makeError() })

    const error = await execute(policy, 'api2', recorder.operation).catch(caught => caught)
    expect(error).toBeInstanceOf(QoderSearchProtocolError)
    expect(recorder.hosts).toEqual([API2])
  })
})

describe('自动模式：限定故障顺序切换一次并粘性', () => {
  it('连接失败后按 center → api2 顺序切换，成功后 api2 成为粘性首选', async () => {
    const { policy } = makePolicy()
    const recorder = recordingOperation((host) => {
      if (host === CENTER) throw protocolError('connection')
      return 'api2-ok'
    })

    await expect(execute(policy, 'auto', recorder.operation)).resolves.toBe('api2-ok')
    expect(recorder.hosts).toEqual([CENTER, API2])

    const next = recordingOperation(() => 'sticky-ok')
    await expect(execute(policy, 'auto', next.operation)).resolves.toBe('sticky-ok')
    expect(next.hosts).toEqual([API2])
  })

  it('请求超时后切换', async () => {
    const { policy } = makePolicy()
    const recorder = recordingOperation((host) => {
      if (host === CENTER) throw protocolError('timeout', { code: 'TIMEOUT' })
      return 'ok'
    })

    await expect(execute(policy, 'auto', recorder.operation)).resolves.toBe('ok')
    expect(recorder.hosts).toEqual([CENTER, API2])
  })

  it.each([500, 502, 503])('上游 %i 后切换', async (status) => {
    const { policy } = makePolicy()
    const recorder = recordingOperation((host) => {
      if (host === CENTER) throw protocolError('http_status', { status })
      return 'ok'
    })

    await expect(execute(policy, 'auto', recorder.operation)).resolves.toBe('ok')
    expect(recorder.hosts).toEqual([CENTER, API2])
  })

  it('双向切换：api2 粘性下连接失败后回到 center 并粘性 center', async () => {
    const { policy } = makePolicy()
    // 先让 api2 成为粘性首选。
    await execute(policy, 'auto', recordingOperation((host) => {
      if (host === CENTER) throw protocolError('connection')
      return 'api2'
    }).operation)

    const second = recordingOperation((host) => {
      if (host === API2) throw protocolError('connection')
      return 'center'
    })
    await expect(execute(policy, 'auto', second.operation)).resolves.toBe('center')
    expect(second.hosts).toEqual([API2, CENTER])

    const third = recordingOperation(() => 'center-sticky')
    await execute(policy, 'auto', third.operation)
    expect(third.hosts).toEqual([CENTER])
  })

  it('切换后第一域（粘性域）成功时不再请求第二域', async () => {
    const { policy } = makePolicy()
    await execute(policy, 'auto', recordingOperation((host) => {
      if (host === CENTER) throw protocolError('connection')
      return 'api2'
    }).operation)

    const recorder = recordingOperation(() => 'ok')
    await execute(policy, 'auto', recorder.operation)
    expect(recorder.hosts).toEqual([API2])
  })
})

describe('自动模式：非限定故障不切换', () => {
  const NON_RETRYABLE: readonly (readonly [string, () => QoderSearchProtocolError])[] = [
    ['401 未授权', () => protocolError('http_status', { status: 401, code: 'UNAUTHORIZED' })],
    ['403 禁止', () => protocolError('http_status', { status: 403 })],
    ['429 限流', () => protocolError('http_status', { status: 429, code: 'RATE_LIMITED' })],
    ['400 其他 4xx', () => protocolError('http_status', { status: 400 })],
    ['响应格式错误', () => protocolError('bad_response', { code: 'BAD_RESPONSE' })],
    ['签名失败', () => protocolError('signing')],
    ['配置/本地校验失败', () => protocolError('config')],
    ['无可用账号', () => protocolError('no_account', { code: 'NO_ACCOUNT' })],
    ['调用方取消', () => protocolError('aborted')],
  ]

  it.each(NON_RETRYABLE)('%s 不触发跨域切换', async (_label, makeError) => {
    const { policy } = makePolicy()
    const recorder = recordingOperation(() => { throw makeError() })

    const error = await execute(policy, 'auto', recorder.operation).catch(caught => caught)
    expect(error).toBeInstanceOf(QoderSearchProtocolError)
    expect(recorder.hosts).toEqual([CENTER])
  })

  it('未知异常默认不切换（只信结构化分类）', async () => {
    const { policy } = makePolicy()
    const recorder = recordingOperation(() => { throw new Error('boom') })

    await expect(execute(policy, 'auto', recorder.operation)).rejects.toThrow('boom')
    expect(recorder.hosts).toEqual([CENTER])
  })

  it('第一域失败后调用方已取消时不再尝试第二域', async () => {
    const { policy } = makePolicy()
    const controller = new AbortController()
    const recorder = recordingOperation(() => {
      controller.abort(new DOMException('caller stop', 'AbortError'))
      throw protocolError('connection')
    })

    const error = await execute(policy, 'auto', recorder.operation, {
      signal: controller.signal,
    }).catch(caught => caught)
    expect(error).toBeInstanceOf(QoderSearchProtocolError)
    expect(recorder.hosts).toEqual([CENTER])
  })
})

describe('自动模式：粘性按账号与网络出口隔离', () => {
  it('不同账号不共享粘性', async () => {
    const { policy } = makePolicy()
    await execute(policy, 'auto', recordingOperation((host) => {
      if (host === CENTER) throw protocolError('connection')
      return 'api2'
    }).operation, { accountKey: 'account-a' })

    const other = recordingOperation(() => 'ok')
    await execute(policy, 'auto', other.operation, { accountKey: 'account-b' })
    expect(other.hosts).toEqual([CENTER])
  })

  it('不同网络出口不共享粘性', async () => {
    let exit = 'exit-a'
    const { policy } = makePolicy({ exitKey: () => exit })
    await execute(policy, 'auto', recordingOperation((host) => {
      if (host === CENTER) throw protocolError('connection')
      return 'api2'
    }).operation)

    exit = 'exit-b'
    const other = recordingOperation(() => 'ok')
    await execute(policy, 'auto', other.operation)
    expect(other.hosts).toEqual([CENTER])
  })

  it('新策略实例（进程重启）回到 center', async () => {
    const first = makePolicy()
    await execute(first.policy, 'auto', recordingOperation((host) => {
      if (host === CENTER) throw protocolError('connection')
      return 'api2'
    }).operation)

    const restarted = makePolicy()
    const recorder = recordingOperation(() => 'ok')
    await execute(restarted.policy, 'auto', recorder.operation)
    expect(recorder.hosts).toEqual([CENTER])
  })

  it('固定模式不写入 auto 粘性', async () => {
    const { policy } = makePolicy()
    await execute(policy, 'api2', recordingOperation(() => 'fixed-api2-ok').operation)

    const auto = recordingOperation(() => 'ok')
    await execute(policy, 'auto', auto.operation)
    expect(auto.hosts).toEqual([CENTER])
  })

  it('粘性不改变传入的端点偏好，固定模式仍严格只走所选域', async () => {
    const { policy } = makePolicy()
    await execute(policy, 'auto', recordingOperation((host) => {
      if (host === CENTER) throw protocolError('connection')
      return 'api2'
    }).operation)

    const fixedCenter = recordingOperation(() => 'ok')
    await execute(policy, 'center', fixedCenter.operation)
    expect(fixedCenter.hosts).toEqual([CENTER])

    const fixedApi2 = recordingOperation(() => 'ok')
    await execute(policy, 'api2', fixedApi2.operation)
    expect(fixedApi2.hosts).toEqual([API2])
  })
})

describe('Qoder 国际版端点策略：固定模式不依赖 networkExitKey', () => {
  /**
   * 网络出口键只服务于 auto 粘性。固定 center/api2 没有粘性语义，因此不得读取
   * 该依赖——否则一个与固定端点无关的 resolver 故障会阻断搜索（修复轮 1 / I1）。
   */
  const EXIT_KEY_FAILURES: readonly (readonly [string, () => string])[] = [
    ['resolver 抛错', () => { throw new Error('exit probe offline') }],
    ['返回空串', () => ''],
    ['返回空白串', () => '   '],
    ['返回非字符串', () => 42 as unknown as string],
  ]

  it.each(EXIT_KEY_FAILURES)('固定 center + %s：不解析出口键，仍只走 center 且成功', async (
    _label,
    exitKey,
  ) => {
    const exitResolver = vi.fn(exitKey)
    const { policy } = makePolicy({ exitKey: exitResolver })
    const recorder = recordingOperation(() => 'ok')

    await expect(execute(policy, 'center', recorder.operation)).resolves.toBe('ok')
    expect(recorder.hosts).toEqual([CENTER])
    expect(exitResolver).not.toHaveBeenCalled()
  })

  it.each(EXIT_KEY_FAILURES)('固定 api2 + %s：不解析出口键，仍只走 api2 且成功', async (
    _label,
    exitKey,
  ) => {
    const exitResolver = vi.fn(exitKey)
    const { policy } = makePolicy({ exitKey: exitResolver })
    const recorder = recordingOperation(() => 'ok')

    await expect(execute(policy, 'api2', recorder.operation)).resolves.toBe('ok')
    expect(recorder.hosts).toEqual([API2])
    expect(exitResolver).not.toHaveBeenCalled()
  })

  it('固定 center 在出口键不可用且连接失败时仍只走 center，不切换也不解析出口键', async () => {
    const exitResolver = vi.fn((): string => { throw new Error('exit probe offline') })
    const { policy } = makePolicy({ exitKey: exitResolver })
    const recorder = recordingOperation(() => { throw protocolError('connection') })

    const error = await execute(policy, 'center', recorder.operation).catch(caught => caught)
    expect(error).toBeInstanceOf(QoderSearchProtocolError)
    expect(recorder.hosts).toEqual([CENTER])
    expect(exitResolver).not.toHaveBeenCalled()
  })
})

describe('自动模式：两域失败可归因', () => {
  it('两域都失败时抛出含两个域名与结构化类别的安全错误', async () => {
    const { policy } = makePolicy()
    const recorder = recordingOperation((host) => {
      if (host === CENTER) throw protocolError('connection')
      throw protocolError('http_status', { status: 502 })
    })

    const error = await execute(policy, 'auto', recorder.operation).catch(caught => caught)
    expect(error).toBeInstanceOf(QoderEndpointUnavailableError)
    const unavailable = error as QoderEndpointUnavailableError
    expect(unavailable.code).toBe('SEARCH_FAILED')
    expect(unavailable.message).toContain(CENTER)
    expect(unavailable.message).toContain(API2)
    expect(unavailable.message).toContain('connection')
    expect(unavailable.message).toContain('server_error')
    expect(unavailable.message).toContain('502')
    expect(unavailable.attempts).toHaveLength(2)
    expect(unavailable.attempts.map(attempt => attempt.host)).toEqual([CENTER, API2])
    // R16：不附带底层异常原文或 raw cause。
    expect((unavailable as Error).cause).toBeUndefined()
    expect(recorder.hosts).toEqual([CENTER, API2])
  })

  it('两域都超时 → TIMEOUT，且每域最多一次', async () => {
    const { policy } = makePolicy()
    const recorder = recordingOperation(() => {
      throw protocolError('timeout', { code: 'TIMEOUT' })
    })

    const error = await execute(policy, 'auto', recorder.operation).catch(caught => caught)
    expect(error).toBeInstanceOf(QoderEndpointUnavailableError)
    expect((error as QoderEndpointUnavailableError).code).toBe('TIMEOUT')
    expect(recorder.hosts).toEqual([CENTER, API2])
    expect(recorder.hosts).toHaveLength(2)
  })

  it('单 query 每域最多一次：两域失败后不再重试', async () => {
    const { policy } = makePolicy()
    const recorder = recordingOperation(() => { throw protocolError('connection') })

    await execute(policy, 'auto', recorder.operation).catch(() => undefined)
    expect(recorder.hosts).toEqual([CENTER, API2])
  })

  it('错误不含 query、账号键、网络出口键或原始异常文本', async () => {
    const { policy } = makePolicy()
    const recorder = recordingOperation((host) => {
      if (host === CENTER) throw protocolError('connection', { message: `leak ${QUERY}` })
      throw protocolError('http_status', { status: 500, message: `leak ${QUERY}` })
    })

    const error = await execute(policy, 'auto', recorder.operation).catch(caught => caught)
    const text = `${(error as Error).message} ${JSON.stringify(error)}`
    expect(text).not.toContain(QUERY)
    expect(text).not.toContain(ACCOUNT_KEY)
    expect(text).not.toContain(EXIT_KEY)
  })
})

describe('自动模式：绝不并行双发', () => {
  it('第二域在首域 settle 之后才开始', async () => {
    const { policy } = makePolicy()
    const events: string[] = []
    const firstAttempt = deferred()
    const operation = async ({ host }: QoderEndpointOperationContext): Promise<string> => {
      events.push(`start:${host}`)
      if (host === CENTER) {
        await firstAttempt.promise
        events.push(`settle:${host}`)
        throw protocolError('connection')
      }
      events.push(`end:${host}`)
      return 'ok'
    }

    const promise = execute(policy, 'auto', operation)
    await Promise.resolve()
    expect(events).toEqual([`start:${CENTER}`])

    firstAttempt.resolve()
    await expect(promise).resolves.toBe('ok')
    expect(events).toEqual([`start:${CENTER}`, `settle:${CENTER}`, `start:${API2}`, `end:${API2}`])
  })

  it('并发峰值始终为 1（顺序而非并行）', async () => {
    const { policy } = makePolicy()
    const recorder = recordingOperation((host) => {
      if (host === CENTER) throw protocolError('connection')
      return 'ok'
    })

    await execute(policy, 'auto', recorder.operation)
    expect(recorder.maxConcurrent).toBe(1)
  })
})

describe('自动模式：并发兄弟 query 不重复', () => {
  it('成功的兄弟 query 只请求一次，失败 query 才切换', async () => {
    const { policy } = makePolicy()
    const hostsByQuery = new Map<string, string[]>()
    const operationFor = (query: string, failCenter: boolean) =>
      async ({ host }: QoderEndpointOperationContext): Promise<string> => {
        const hosts = hostsByQuery.get(query) ?? []
        hosts.push(host)
        hostsByQuery.set(query, hosts)
        if (failCenter && host === CENTER) throw protocolError('connection')
        return query
      }

    const [first, second] = await Promise.all([
      execute(policy, 'auto', operationFor('q1', true)),
      execute(policy, 'auto', operationFor('q2', false)),
    ])

    expect(first).toBe('q1')
    expect(second).toBe('q2')
    expect(hostsByQuery.get('q1')).toEqual([CENTER, API2])
    expect(hostsByQuery.get('q2')).toEqual([CENTER])
  })

  it('并发兄弟不会互相取消或重复切换', async () => {
    const { policy } = makePolicy()
    const hosts: string[] = []
    const operation = async ({ host }: QoderEndpointOperationContext): Promise<string> => {
      hosts.push(host)
      await Promise.resolve()
      if (host === CENTER) throw protocolError('connection')
      return 'ok'
    }

    const results = await Promise.all([
      execute(policy, 'auto', operation),
      execute(policy, 'auto', operation),
      execute(policy, 'auto', operation),
    ])

    expect(results).toEqual(['ok', 'ok', 'ok'])
    // 每个 query 最多两域各一次：3 个 query ≤ 6 次尝试，且没有第三次重试。
    expect(hosts.length).toBeLessThanOrEqual(6)
    expect(hosts.filter(host => host === CENTER).length).toBeLessThanOrEqual(3)
    expect(hosts.filter(host => host === API2).length).toBeLessThanOrEqual(3)
  })
})

describe('Qoder 国际版端点策略：观察记录（脱敏状态）', () => {
  it('成功时只报告实际域名、耗时与偏好', async () => {
    const { policy, observations } = makePolicy()
    await execute(policy, 'auto', recordingOperation(() => 'ok').operation)

    expect(observations).toHaveLength(1)
    const observation = observations[0]!
    expect(observation).toMatchObject({ preference: 'auto', outcome: 'succeeded', host: CENTER })
    expect(observation.attempts).toHaveLength(1)
    expect(observation.attempts[0]!.outcome).toBe('succeeded')
    expect(observation.attempts[0]!.durationMs).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(observation.attempts[0]!.durationMs)).toBe(true)

    const text = JSON.stringify(observation)
    expect(text).not.toContain(QUERY)
    expect(text).not.toContain(ACCOUNT_KEY)
    expect(text).not.toContain(EXIT_KEY)
  })

  it('失败时逐域报告类别、状态与耗时', async () => {
    const { policy, observations } = makePolicy()
    const recorder = recordingOperation((host) => {
      if (host === CENTER) throw protocolError('connection')
      throw protocolError('http_status', { status: 503 })
    })

    await execute(policy, 'auto', recorder.operation).catch(() => undefined)
    expect(observations).toHaveLength(1)
    const observation = observations[0]!
    expect(observation.outcome).toBe('failed')
    expect(observation.host).toBeUndefined()
    expect(observation.attempts).toEqual([
      { host: CENTER, outcome: 'failed', failure: 'connection', durationMs: expect.any(Number) },
      { host: API2, outcome: 'failed', failure: 'server_error', status: 503, durationMs: expect.any(Number) },
    ])
  })

  it('非限定失败也记录在案，且不报告成功域名', async () => {
    const { policy, observations } = makePolicy()
    const recorder = recordingOperation(() => {
      throw protocolError('http_status', { status: 401, code: 'UNAUTHORIZED' })
    })

    await execute(policy, 'auto', recorder.operation).catch(() => undefined)
    expect(observations).toHaveLength(1)
    expect(observations[0]!.outcome).toBe('failed')
    expect(observations[0]!.attempts).toEqual([
      { host: CENTER, outcome: 'failed', failure: 'unauthorized', status: 401, durationMs: expect.any(Number) },
    ])
  })

  it('观察钩子抛错不影响搜索结果', async () => {
    const { policy } = makePolicy({
      onObservation: () => { throw new Error('status sink offline') },
    })

    await expect(execute(policy, 'auto', recordingOperation(() => 'ok').operation)).resolves.toBe('ok')
  })
})

describe('Qoder 国际版端点策略：域名边界与参数校验', () => {
  it('任何路径都只使用 center / api2，绝不出现 gateway 或其他域名', async () => {
    const { policy } = makePolicy()
    const hosts: string[] = []
    const operation = async ({ host }: QoderEndpointOperationContext): Promise<string> => {
      hosts.push(host)
      throw protocolError('connection')
    }

    await execute(policy, 'auto', operation).catch(() => undefined)
    await execute(policy, 'center', operation).catch(() => undefined)
    await execute(policy, 'api2', operation).catch(() => undefined)

    expect(hosts.every(host => (QODER_INTERNATIONAL_HOSTS as readonly string[]).includes(host))).toBe(true)
    expect(hosts.some(host => host.includes('gateway'))).toBe(false)
    expect(hosts.some(host => host.includes('qoder.com.cn'))).toBe(false)
  })

  it('operation 只收到域名，不收到账号或凭据（结构上无法换账号）', async () => {
    const { policy } = makePolicy()
    const recorder = recordingOperation(() => 'ok')

    await execute(policy, 'auto', recorder.operation)
    expect(recorder.contexts).toEqual([{ host: CENTER }])
    expect(Object.keys(recorder.contexts[0]!)).toEqual(['host'])
  })

  it('非法端点偏好 → INVALID_ARGUMENTS 且不调用 operation', async () => {
    const { policy } = makePolicy()
    const recorder = recordingOperation(() => 'ok')

    const error = await execute(
      policy,
      'gateway' as QoderEndpointPreference,
      recorder.operation,
    ).catch(caught => caught)

    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENTS', channel: 'qoder' })
    expect(recorder.hosts).toEqual([])
  })

  it('空 accountKey → 结构化错误且不调用 operation', async () => {
    const { policy } = makePolicy()
    const recorder = recordingOperation(() => 'ok')

    const error = await execute(policy, 'auto', recorder.operation, { accountKey: '   ' })
      .catch(caught => caught)

    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENTS', channel: 'qoder' })
    expect(recorder.hosts).toEqual([])
  })

  it('networkExitKey 解析失败 → 结构化错误且不调用 operation', async () => {
    const { policy } = makePolicy({
      exitKey: () => { throw new Error(`exit probe leaked ${ACCOUNT_KEY}`) },
    })
    const recorder = recordingOperation(() => 'ok')

    const error = await execute(policy, 'auto', recorder.operation).catch(caught => caught)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'SEARCH_FAILED', channel: 'qoder' })
    expect((error as Error).message).not.toContain(ACCOUNT_KEY)
    expect((error as Error).cause).toBeUndefined()
    expect(recorder.hosts).toEqual([])
  })
})
