/** R43/R37：本机全局持久路由、probe 隔离与双域错误归因。 */
import { describe, expect, it } from 'vitest'

import {
  classifyQoderEndpointFailure,
  QoderEndpointPolicy,
  type QoderInternationalHost,
} from '../../src/host/channels/qoder/endpoint-policy.ts'
import {
  postQoderSearch,
  QoderSearchProtocolError,
} from '../../src/host/channels/qoder/protocol.ts'

const CENTER = 'center.qoder.sh'
const API2 = 'api2.qoder.sh'
const signal = () => new AbortController().signal

function makeGlobalPolicy(initial: 'center.qoder.sh' | 'api2.qoder.sh' | null = null) {
  let persisted = initial
  const reads: unknown[] = []
  const writes: string[] = []
  const policy = new QoderEndpointPolicy({
    readLastSuccessfulHost: () => { reads.push('read'); return persisted },
    writeLastSuccessfulHost: async (host: string) => {
      writes.push(host)
      persisted = host as typeof persisted
    },
  } as any)
  return {
    policy,
    reads,
    writes,
    get persisted() { return persisted },
  }
}

async function execute(policy: QoderEndpointPolicy, accountKey: string, operation: (host: string) => unknown, preference: 'auto' | 'center' | 'api2' = 'auto', rememberSuccess = true) {
  return await policy.execute({
    preference,
    accountKey,
    operation: async ({ host }: { host: QoderInternationalHost }) => await operation(host),
    signal: signal(),
    rememberSuccess,
  } as any)
}

describe('R43 本机全局 lastSuccessfulHost', () => {
  it('所有账号共用唯一值；换账号不清空，新策略实例从持久值开始', async () => {
    const global = makeGlobalPolicy()
    const first = await execute(global.policy, 'account-a', (host) => {
      if (host === CENTER) throw new QoderSearchProtocolError('SEARCH_FAILED', 'offline', 'connection')
      return 'api2-ok'
    })
    expect(first).toBe('api2-ok')
    expect(global.persisted).toBe(API2)

    const otherAccount = await execute(global.policy, 'account-b', () => 'other-ok')
    expect(otherAccount).toBe('other-ok')
    expect(global.persisted).toBe(API2)

    const restarted = new QoderEndpointPolicy({
      readLastSuccessfulHost: () => global.persisted,
      writeLastSuccessfulHost: async (host: string) => { global.writes.push(host) },
    } as any)
    const hosts: string[] = []
    await execute(restarted, 'account-a', (host) => { hosts.push(host); return 'restart-ok' })
    expect(hosts).toEqual([API2])
  })

  it('fixed 忽略持久记录读写；auto 两域均失败不改记录', async () => {
    const global = makeGlobalPolicy(API2)
    const fixedHosts: string[] = []
    await execute(global.policy, 'account-a', (host) => { fixedHosts.push(host); return 'fixed' }, 'center')
    expect(fixedHosts).toEqual([CENTER])
    expect(global.reads).toHaveLength(0)
    expect(global.writes).toHaveLength(0)

    await expect(execute(global.policy, 'account-a', () => {
      throw new QoderSearchProtocolError('SEARCH_FAILED', 'offline', 'connection')
    })).rejects.toThrow()
    expect(global.persisted).toBe(API2)
    expect(global.writes).toHaveLength(0)
  })

  it('capability probe rememberSuccess=false 时不写全局路由', async () => {
    const global = makeGlobalPolicy()
    await execute(global.policy, 'probe-only-not-an-account', () => 'probe-ok', 'auto', false)
    expect(global.persisted).toBeNull()
    expect(global.writes).toHaveLength(0)
  })
})

describe('R37 第二域错误与 redirect 分类', () => {
  it('第二域 401 保留 code/httpStatus/host，不聚合吞掉', async () => {
    const global = makeGlobalPolicy()
    const error = await execute(global.policy, 'account-a', (host) => {
      if (host === CENTER) throw new QoderSearchProtocolError('SEARCH_FAILED', 'offline', 'connection')
      throw new QoderSearchProtocolError('UNAUTHORIZED', 'denied', 'http_status', { status: 401 })
    }).catch(caught => caught)
    expect(error).toMatchObject({
      code: 'UNAUTHORIZED',
      httpStatus: 401,
      host: API2,
    })
  })

  it('redirect:error 是 bad_response，不是可换域 connection', async () => {
    const error = await postQoderSearch({
      host: CENTER,
      path: '/api/v1/webSearch/oneSearch',
      query: 'redirect fixture',
      credential: { securityOauthToken: 'TOKEN', machineId: 'MACHINE' },
      signer: {
        dispose: () => {},
        prepare: async (host, path) => ({
          url: `https://${host}/algo${path}?Encode=1`,
          headers: {},
          body: '{}',
        }),
      },
      signal: signal(),
      fetcher: async () => {
        throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') })
      },
    }).catch(caught => caught)
    expect(classifyQoderEndpointFailure(error)).toMatchObject({
      category: 'bad_response',
      retryable: false,
    })
  })
})
