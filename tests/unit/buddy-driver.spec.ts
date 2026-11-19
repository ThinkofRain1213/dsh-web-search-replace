import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createBuddyDriver,
  BUDDY_SEARCH_HOST,
  BUDDY_SEARCH_USER_AGENT,
  type BuddyAccountCredential,
} from '../../src/host/channels/buddy/driver.ts'
import { ChannelSearchError } from '../../src/host/search/errors.ts'

interface FetchCall {
  readonly url: string
  readonly init: RequestInit
}

/** 本渠道账号快照。 */
function credential(accessToken: string): BuddyAccountCredential {
  return { channelId: 'buddy', accountId: 'a000000000001', accessToken }
}

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

function headersOf(init: RequestInit): Headers {
  return new Headers(init.headers)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Buddy 驱动请求形状', () => {
  it('只请求 copilot.tencent.com/agenttool/v1/search，body 与产品头固定', async () => {
    const { fetcher, calls } = jsonFetcher({ results: [{ url: 'https://a.test/' }] })
    const driver = createBuddyDriver({
      resolveCredential: () => credential('BUDDY_AT'),
      fetcher,
    })

    await driver.searchOnce('天气', 10, new AbortController().signal)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://copilot.tencent.com/agenttool/v1/search')
    expect(BUDDY_SEARCH_HOST).toBe('copilot.tencent.com')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      query: '天气',
      type: 'text2text',
      max_results: 10,
    })
    const headers = headersOf(calls[0]!.init)
    expect(headers.get('Authorization')).toBe('Bearer BUDDY_AT')
    expect(headers.get('User-Agent')).toBe(BUDDY_SEARCH_USER_AGENT)
    expect(headers.get('User-Agent')).toBe('CodeBuddyIDE/1.106.1')
  })

  it('结果映射为 url/title/snippet，畸形项被丢弃', async () => {
    const { fetcher } = jsonFetcher({
      results: [
        null,
        { title: 'no-url' },
        { url: 'https://a.test/', title: 'A', snippet: 'SA' },
      ],
    })
    const driver = createBuddyDriver({ resolveCredential: () => credential('BUDDY_AT'), fetcher })

    await expect(driver.searchOnce('q', 10, new AbortController().signal)).resolves.toEqual({
      sources: [{ url: 'https://a.test/', title: 'A', snippet: 'SA' }],
      truncated: false,
    })
  })
})

describe('Buddy 驱动账号隔离与失败边界', () => {
  it('无账号时在任何 fetch 前以 NO_ACCOUNT 失败', async () => {
    const { fetcher, calls } = jsonFetcher({ results: [] })
    const driver = createBuddyDriver({ resolveCredential: () => undefined, fetcher })

    await expect(driver.searchOnce('q', 10, new AbortController().signal)).rejects.toMatchObject({
      name: 'ChannelSearchError',
      code: 'NO_ACCOUNT',
      channel: 'buddy',
    })
    expect(calls).toHaveLength(0)
  })

  it.each([undefined, null, '', '   '])('空账号快照/空 token %j 同样不发请求', async (token) => {
    const { fetcher, calls } = jsonFetcher({ results: [] })
    const driver = createBuddyDriver({
      resolveCredential: () => token === undefined || token === null
        ? token
        : credential(token),
      fetcher,
    })

    await expect(driver.searchOnce('q', 10, new AbortController().signal)).rejects.toMatchObject({
      code: 'NO_ACCOUNT',
      channel: 'buddy',
    })
    expect(calls).toHaveLength(0)
  })

  it('只读取本渠道账号解析，不触碰 WorkBuddy 解析器，也不请求 WorkBuddy', async () => {
    const buddyResolver = vi.fn(() => credential('BUDDY_AT'))
    const workbuddyResolver = vi.fn(() => credential('WORKBUDDY_AT'))
    const { fetcher, calls } = jsonFetcher({ results: [] })
    const driver = createBuddyDriver({ resolveCredential: buddyResolver, fetcher })

    await driver.searchOnce('q', 10, new AbortController().signal)

    expect(buddyResolver).toHaveBeenCalledTimes(1)
    expect(workbuddyResolver).not.toHaveBeenCalled()
    expect(calls.map(call => call.url)).toEqual([
      'https://copilot.tencent.com/agenttool/v1/search',
    ])
  })

  it('拿到其他渠道的账号快照时 fail-closed（SEARCH_FAILED）且不发请求', async () => {
    const { fetcher, calls } = jsonFetcher({ results: [] })
    const driver = createBuddyDriver({
      resolveCredential: () => ({
        channelId: 'workbuddy',
        accountId: 'a000000000002',
        accessToken: 'WORKBUDDY_AT',
      } as unknown as BuddyAccountCredential),
      fetcher,
    })

    const error = await driver.searchOnce('q', 10, new AbortController().signal).catch(caught => caught)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'SEARCH_FAILED', channel: 'buddy' })
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['NO_ACCOUNT', '账号缺失'],
    ['UNAUTHORIZED', '凭据过期'],
    ['TIMEOUT', '解析超时'],
  ])('解析器抛 %s（其他渠道绑定 + 秘密原文）时保留 code、重绑 buddy 且不泄露', async (code) => {
    const secret = 'BUDDY_RESOLVER_SECRET_5f1c'
    const { fetcher, calls } = jsonFetcher({ results: [] })
    const driver = createBuddyDriver({
      resolveCredential: () => {
        throw new ChannelSearchError(code as never, 'workbuddy', `store echoed ${secret}`)
      },
      fetcher,
    })

    const error = await driver.searchOnce('q', 10, new AbortController().signal).catch(caught => caught)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code, channel: 'buddy' })
    expect(String((error as Error).message)).not.toContain(secret)
    expect((error as { cause?: unknown }).cause).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('解析器普通异常只产生固定 SEARCH_FAILED，不泄露底层原文或 cause', async () => {
    const secret = 'BUDDY_GENERIC_SECRET_5f1c'
    const { fetcher, calls } = jsonFetcher({ results: [] })
    const driver = createBuddyDriver({
      resolveCredential: () => { throw new Error(`store offline ${secret}`) },
      fetcher,
    })

    const error = await driver.searchOnce('q', 10, new AbortController().signal).catch(caught => caught)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'SEARCH_FAILED', channel: 'buddy' })
    expect(String((error as Error).message)).not.toContain(secret)
    expect((error as { cause?: unknown }).cause).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('Buddy 失败不会回退到 WorkBuddy 或官方全局 fetch', async () => {
    const officialFetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', officialFetch)
    const { fetcher, calls } = jsonFetcher({ error: 'expired' }, 401)
    const driver = createBuddyDriver({ resolveCredential: () => credential('BUDDY_AT'), fetcher })

    await expect(driver.searchOnce('q', 10, new AbortController().signal)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      channel: 'buddy',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://copilot.tencent.com/agenttool/v1/search')
    expect(officialFetch).not.toHaveBeenCalled()
  })

  it.each([
    { status: 401, code: 'UNAUTHORIZED' },
    { status: 429, code: 'RATE_LIMITED' },
    { status: 500, code: 'SEARCH_FAILED' },
  ])('HTTP $status → $code（渠道为 buddy）', async ({ status, code }) => {
    const { fetcher } = jsonFetcher({}, status)
    const driver = createBuddyDriver({ resolveCredential: () => credential('BUDDY_AT'), fetcher })

    const error = await driver.searchOnce('q', 10, new AbortController().signal).catch(error => error)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code, channel: 'buddy' })
  })

  it('坏响应 → BAD_RESPONSE', async () => {
    const { fetcher } = jsonFetcher({ results: null })
    const driver = createBuddyDriver({ resolveCredential: () => credential('BUDDY_AT'), fetcher })

    await expect(driver.searchOnce('q', 10, new AbortController().signal)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
      channel: 'buddy',
    })
  })

  it('自己的 20s 预算耗尽 → TIMEOUT', async () => {
    let timeoutController: AbortController | undefined
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      expect(ms).toBe(20_000)
      timeoutController = new AbortController()
      return timeoutController.signal
    })
    const { fetcher } = hangingFetcher()
    const driver = createBuddyDriver({ resolveCredential: () => credential('BUDDY_AT'), fetcher })
    const promise = driver.searchOnce('q', 10, new AbortController().signal)
    const assertion = expect(promise).rejects.toMatchObject({
      code: 'TIMEOUT',
      channel: 'buddy',
    })

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    timeoutController!.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    await assertion
  })

  it('外层 abort → SEARCH_FAILED，不误报成 TIMEOUT', async () => {
    const outer = new AbortController()
    const { fetcher } = hangingFetcher()
    const driver = createBuddyDriver({ resolveCredential: () => credential('BUDDY_AT'), fetcher })
    const promise = driver.searchOnce('q', 10, outer.signal)
    const assertion = expect(promise).rejects.toMatchObject({
      code: 'SEARCH_FAILED',
      channel: 'buddy',
    })

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    outer.abort()
    await assertion
  })
})

function hangingFetcher(): { readonly fetcher: typeof fetch } {
  const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
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
  return { fetcher }
}
