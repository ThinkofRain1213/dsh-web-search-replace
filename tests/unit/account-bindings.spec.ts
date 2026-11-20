/**
 * Task 8：四渠道独立绑定适配器的行为守卫。
 *
 * 锁死的契约：
 * 1. 每个适配器只以**自己的渠道 ID**调用 `resolveCurrentCredential(channel)`；
 *    没有协议族选择器、余额选号、自动轮换或官方/另一渠道回退。
 * 2. 适配器把服务返回的同一账号快照（accountId + 凭据）原样交给驱动；渠道
 *    不匹配的快照一律 fail-closed（NO_ACCOUNT），绝不用于请求。
 * 3. Qoder 国际版绑定必须显式接收稳定 `readLastSuccessfulHost`，不探测 OS、不造共享
 *    默认键；固定 center/api2 不读取它。
 * 4. 驱动实例在绑定时创建一次，同一实例的端点粘性跨查询保留（不是每次 query
 *    重建策略）。
 *
 * 测试只注入内存解析器与 fetcher；Qoder 签名仍使用真实 WASM，无厂商网络。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  createBuddySearchBinding,
  createQoderCnSearchBinding,
  createQoderInternationalSearchBinding,
  createWorkbuddySearchBinding,
  type CurrentChannelCredentialResolver,
} from '../../src/host/accounts/bindings.ts'
import type { ResolvedChannelCredential } from '../../src/host/accounts/service.ts'
import { ChannelSearchError } from '../../src/host/search/errors.ts'
import type { ChannelId } from '../../src/shared/channels.ts'

const CENTER = 'center.qoder.sh'
const API2 = 'api2.qoder.sh'
const BUDDY_TOKEN = 'BINDING_BUDDY_TOKEN_2f7a'
const WORKBUDDY_TOKEN = 'BINDING_WORKBUDDY_TOKEN_2f7a'
const QODER_TOKEN = 'BINDING_QODER_TOKEN_2f7a'
const QODER_MACHINE = 'BINDING_QODER_MACHINE_2f7a'
const LEAK_SENTINEL = 'BINDING_LEAK_SENTINEL_2f7a'

const BUDDY_CREDENTIAL: ResolvedChannelCredential = {
  kind: 'tencent-access-token',
  channelId: 'buddy',
  accountId: 'a000000000001',
  accessToken: BUDDY_TOKEN,
}

const WORKBUDDY_CREDENTIAL: ResolvedChannelCredential = {
  kind: 'tencent-access-token',
  channelId: 'workbuddy',
  accountId: 'a000000000002',
  accessToken: WORKBUDDY_TOKEN,
}

const QODER_CREDENTIAL: ResolvedChannelCredential = {
  kind: 'qoder-signing',
  channelId: 'qoder',
  accountId: 'a000000000003',
  credential: {
    uid: 'BINDING_UID_2f7a',
    securityOauthToken: QODER_TOKEN,
    machineId: QODER_MACHINE,
  },
}

const QODERCN_CREDENTIAL: ResolvedChannelCredential = {
  kind: 'qoder-signing',
  channelId: 'qodercn',
  accountId: 'a000000000004',
  credential: {
    securityOauthToken: QODER_TOKEN,
    machineId: QODER_MACHINE,
  },
}

interface FetchCall {
  readonly url: string
  readonly init: RequestInit
}

/** 可切换返回值的解析器；记录每次调用收到的渠道。 */
function resolverFor(
  resolve: (channel: ChannelId) => ResolvedChannelCredential | null,
): CurrentChannelCredentialResolver & { readonly calls: ChannelId[] } {
  const calls: ChannelId[] = []
  return {
    calls,
    async resolveCurrentCredential(channel) {
      calls.push(channel)
      return resolve(channel)
    },
  }
}

/** JSON fetcher，记录 URL 与 init。 */
function jsonFetcher(
  value: unknown,
  status = 200,
): { readonly fetcher: typeof fetch; readonly calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

/** 始终挂起直到请求 signal 被 abort；模拟真实 fetch 的取消行为。 */
function hangingFetcher(): typeof fetch {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal === undefined || signal === null) return
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }) as unknown as typeof fetch
}

/** 腾讯系响应。 */
const TENCENT_RESULT = { results: [{ url: 'https://tencent-result.test/' }] }
/** Qoder 响应。 */
const QODER_RESULT = { pageItems: [{ link: 'https://qoder-result.test/' }] }

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('腾讯渠道绑定：精确渠道与 host', () => {
  it('Buddy 绑定只解析 buddy，并只请求 copilot.tencent.com', async () => {
    const resolver = resolverFor(channel => channel === 'buddy' ? BUDDY_CREDENTIAL : null)
    const { fetcher, calls } = jsonFetcher(TENCENT_RESULT)
    const driver = createBuddySearchBinding(resolver, { fetcher })

    await driver.searchOnce('天气', 10, signal())

    expect(resolver.calls).toEqual(['buddy'])
    expect(calls.map(call => call.url)).toEqual([
      'https://copilot.tencent.com/agenttool/v1/search',
    ])
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe(`Bearer ${BUDDY_TOKEN}`)
  })

  it('WorkBuddy 绑定只解析 workbuddy，并只请求 www.workbuddy.ai', async () => {
    const resolver = resolverFor(channel => channel === 'workbuddy' ? WORKBUDDY_CREDENTIAL : null)
    const { fetcher, calls } = jsonFetcher(TENCENT_RESULT)
    const driver = createWorkbuddySearchBinding(resolver, { fetcher })

    await driver.searchOnce('天气', 10, signal())

    expect(resolver.calls).toEqual(['workbuddy'])
    expect(calls.map(call => call.url)).toEqual([
      'https://www.workbuddy.ai/agenttool/v1/search',
    ])
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe(`Bearer ${WORKBUDDY_TOKEN}`)
  })

  it('Buddy 拿到 WorkBuddy 快照时 fail-closed（NO_ACCOUNT）且不发请求', async () => {
    const resolver = resolverFor(() => WORKBUDDY_CREDENTIAL)
    const { fetcher, calls } = jsonFetcher(TENCENT_RESULT)
    const driver = createBuddySearchBinding(resolver, { fetcher })

    await expect(driver.searchOnce('q', 10, signal())).rejects.toMatchObject({
      code: 'NO_ACCOUNT',
      channel: 'buddy',
    })
    expect(calls).toHaveLength(0)
  })

  it('解析器抛出其他渠道的结构化错误时保留安全 code、重绑精确渠道且不泄露秘密', async () => {
    const resolver = resolverFor(() => {
      throw new ChannelSearchError(
        'UNAUTHORIZED',
        'workbuddy',
        `upstream echoed ${BUDDY_TOKEN}`,
      )
    })
    const { fetcher, calls } = jsonFetcher(TENCENT_RESULT)
    const driver = createBuddySearchBinding(resolver, { fetcher })

    const error = await driver.searchOnce('q', 10, signal()).catch(caught => caught)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'UNAUTHORIZED', channel: 'buddy' })
    expect(String((error as Error).message)).not.toContain(BUDDY_TOKEN)
    expect((error as { cause?: unknown }).cause).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

describe('Qoder 中国版绑定', () => {
  it('只解析 qodercn，并只请求 gateway.qoder.com.cn', async () => {
    const resolver = resolverFor(channel => channel === 'qodercn' ? QODERCN_CREDENTIAL : null)
    const { fetcher, calls } = jsonFetcher(QODER_RESULT)
    const driver = createQoderCnSearchBinding(resolver, { fetcher })

    await driver.searchOnce('天气', 10, signal())

    expect(resolver.calls).toEqual(['qodercn'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(
      'https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=1',
    )
  })

  it('拿到 qoder 国际版快照时 fail-closed（NO_ACCOUNT）且不加载 WASM/不发请求', async () => {
    const resolver = resolverFor(() => QODER_CREDENTIAL)
    const { fetcher, calls } = jsonFetcher(QODER_RESULT)
    const driver = createQoderCnSearchBinding(resolver, { fetcher })

    await expect(driver.searchOnce('q', 10, signal())).rejects.toMatchObject({
      code: 'NO_ACCOUNT',
      channel: 'qodercn',
    })
    expect(calls).toHaveLength(0)
  })
})

describe('Qoder 国际版绑定：显式网络出口与粘性', () => {
  it('固定 center 不读取 readLastSuccessfulHost，仍只请求 center.qoder.sh', async () => {
    const resolver = resolverFor(channel => channel === 'qoder' ? QODER_CREDENTIAL : null)
    const { fetcher, calls } = jsonFetcher(QODER_RESULT)
    const driver = createQoderInternationalSearchBinding(resolver, {
      readLastSuccessfulHost: () => { throw new Error(`must not be called ${LEAK_SENTINEL}`) },
      resolveEndpointPreference: () => 'center',
      fetcher,
    })

    await driver.searchOnce('天气', 10, signal())

    expect(resolver.calls).toEqual(['qoder'])
    expect(calls.map(call => new URL(call.url).hostname)).toEqual([CENTER])
  })

  it('同一绑定实例跨查询保留全局最近成功域，换账号也不清空', async () => {
    let current: ResolvedChannelCredential | null = QODER_CREDENTIAL
    const resolver = resolverFor(() => current)
    const calls: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const host = new URL(String(input)).hostname
      calls.push(host)
      if (host === CENTER) throw new TypeError('fetch failed')
      return new Response(JSON.stringify(QODER_RESULT), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const driver = createQoderInternationalSearchBinding(resolver, {
      readLastSuccessfulHost: () => null,
      resolveEndpointPreference: () => 'auto',
      fetcher,
    })

    await driver.searchOnce('第一次', 10, signal())
    expect(calls).toEqual([CENTER, API2])

    await driver.searchOnce('第二次', 10, signal())
    expect(calls).toEqual([CENTER, API2, API2])

    current = {
      ...QODER_CREDENTIAL,
      accountId: 'a000000000099',
    }
    await driver.searchOnce('第三次', 10, signal())
    expect(calls).toEqual([CENTER, API2, API2, API2])
  })

  it('没有持久最近成功域时从 center 开始，不需要 networkExitKey 或 OS 探测', async () => {
    const resolver = resolverFor(() => QODER_CREDENTIAL)
    const { fetcher, calls } = jsonFetcher(QODER_RESULT)
    const driver = createQoderInternationalSearchBinding(resolver, {
      resolveEndpointPreference: () => 'auto',
      fetcher,
    })
    await driver.searchOnce('天气', 10, signal())
    expect(calls.map(call => new URL(call.url).hostname)).toEqual([CENTER])
  })

  it('拿到 qodercn 快照时 fail-closed（NO_ACCOUNT）且不发请求', async () => {
    const resolver = resolverFor(() => QODERCN_CREDENTIAL)
    const { fetcher, calls } = jsonFetcher(QODER_RESULT)
    const driver = createQoderInternationalSearchBinding(resolver, {
      readLastSuccessfulHost: () => null,
      resolveEndpointPreference: () => 'center',
      fetcher,
    })

    await expect(driver.searchOnce('q', 10, signal())).rejects.toMatchObject({
      code: 'NO_ACCOUNT',
      channel: 'qoder',
    })
    expect(calls).toHaveLength(0)
  })

  it('解析器普通异常只产生固定 SEARCH_FAILED，不泄露底层原文或 cause', async () => {
    const resolver = resolverFor(() => {
      throw new Error(`credential store offline ${QODER_TOKEN} ${QODER_MACHINE}`)
    })
    const { fetcher, calls } = jsonFetcher(QODER_RESULT)
    const driver = createQoderInternationalSearchBinding(resolver, {
      readLastSuccessfulHost: () => null,
      resolveEndpointPreference: () => 'center',
      fetcher,
    })

    const error = await driver.searchOnce('q', 10, signal()).catch(caught => caught)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'SEARCH_FAILED', channel: 'qoder' })
    expect(String((error as Error).message)).not.toContain(QODER_TOKEN)
    expect(String((error as Error).message)).not.toContain(QODER_MACHINE)
    expect((error as { cause?: unknown }).cause).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('固定 api2 的请求失败不会被自动切到 center', async () => {
    const resolver = resolverFor(() => QODER_CREDENTIAL)
    const { fetcher, calls } = jsonFetcher(QODER_RESULT, 500)
    const driver = createQoderInternationalSearchBinding(resolver, {
      readLastSuccessfulHost: () => null,
      resolveEndpointPreference: () => 'api2',
      fetcher,
    })

    await expect(driver.searchOnce('q', 10, signal())).rejects.toMatchObject({
      code: 'SEARCH_FAILED',
      channel: 'qoder',
    })
    expect(calls.map(call => new URL(call.url).hostname)).toEqual([API2])
  })
})
