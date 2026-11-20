import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  postTencentSearch,
  TENCENT_SEARCH_TIMEOUT_MS,
  TencentSearchProtocolError,
  toTencentChannelSearchError,
  type TencentSearchRequest,
} from '../../src/host/channels/tencent/protocol.ts'

interface FetchCall {
  readonly url: string
  readonly init: RequestInit
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

function textFetcher(
  body: string,
  status = 200,
): { readonly fetcher: typeof fetch; readonly calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(body, { status })
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

function request(overrides: Partial<TencentSearchRequest> = {}): TencentSearchRequest {
  return {
    host: 'copilot.tencent.com',
    accessToken: 'ACCESS_TOKEN',
    query: '天气',
    maxResults: 10,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function headersOf(init: RequestInit): Headers {
  return new Headers(init.headers)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('postTencentSearch 请求形状', () => {
  it('向注入的 host 发 POST，body 精确为 {query,type,max_results} 且带 Bearer 头', async () => {
    const { fetcher, calls } = jsonFetcher({
      results: [{ url: 'https://a.test/', title: 'A', snippet: 'S' }],
    })

    const sources = await postTencentSearch(request({
      fetcher,
      headers: { 'User-Agent': 'ProductUA/1.0' },
    }))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://copilot.tencent.com/agenttool/v1/search')
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      query: '天气',
      type: 'text2text',
      max_results: 10,
    })
    const headers = headersOf(calls[0]!.init)
    expect(headers.get('Authorization')).toBe('Bearer ACCESS_TOKEN')
    expect(headers.get('Content-Type')).toBe('application/json;charset=UTF-8')
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('User-Agent')).toBe('ProductUA/1.0')
    expect(sources).toEqual([{ url: 'https://a.test/', title: 'A', snippet: 'S' }])
  })

  it('腾讯搜索 data-plane 明确 redirect:error，不跟随重定向转发授权材料', async () => {
    const { fetcher, calls } = jsonFetcher({ results: [] })
    await postTencentSearch(request({ fetcher }))
    expect(calls[0]?.init.redirect).toBe('error')
  })

  it('共享层不写死渠道 host，也不自行封顶 maxResults', async () => {
    const { fetcher, calls } = jsonFetcher({ results: [] })

    await postTencentSearch(request({ host: 'example.test', maxResults: 10, fetcher }))

    expect(calls[0]!.url).toBe('https://example.test/agenttool/v1/search')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      query: '天气',
      type: 'text2text',
      max_results: 10,
    })
  })

  it('默认使用全局 fetch，测试可注入 fetcher 覆盖', async () => {
    const globalFetch = vi.fn(async () => new Response(JSON.stringify({ results: [] })))
    vi.stubGlobal('fetch', globalFetch)

    await postTencentSearch(request())

    expect(globalFetch).toHaveBeenCalledTimes(1)
  })
})

describe('postTencentSearch 响应投影与防御', () => {
  it('results[].url/title/snippet 一对一投影', async () => {
    const { fetcher } = jsonFetcher({
      results: [
        { url: 'https://a.test/', title: 'A', snippet: 'SA' },
        { url: 'https://b.test/', title: 'B', snippet: 'SB' },
      ],
    })

    await expect(postTencentSearch(request({ fetcher }))).resolves.toEqual([
      { url: 'https://a.test/', title: 'A', snippet: 'SA' },
      { url: 'https://b.test/', title: 'B', snippet: 'SB' },
    ])
  })

  it('丢弃 null、非对象、缺 url、空 url 与非法字段，保留合法条目', async () => {
    const { fetcher } = jsonFetcher({
      results: [
        null,
        'not-an-object',
        42,
        [],
        {},
        { url: '' },
        { url: 123 },
        { url: 'https://empty-fields.test/', title: '', snippet: 7 },
        { url: 'https://kept.test/', title: 'T', snippet: 'S' },
      ],
    })

    await expect(postTencentSearch(request({ fetcher }))).resolves.toEqual([
      { url: 'https://empty-fields.test/' },
      { url: 'https://kept.test/', title: 'T', snippet: 'S' },
    ])
  })

  it.each([
    { label: 'JSON null', body: 'null' },
    { label: '缺 results', body: '{}' },
    { label: 'results 非数组', body: '{"results":"nope"}' },
    { label: 'results 为对象', body: '{"results":{"url":"https://a.test/"}}' },
  ])('$label → BAD_RESPONSE', async ({ body }) => {
    const { fetcher } = textFetcher(body)

    await expect(postTencentSearch(request({ fetcher }))).rejects.toMatchObject({
      name: 'TencentSearchProtocolError',
      code: 'BAD_RESPONSE',
    })
  })

  it('非 JSON 响应 → BAD_RESPONSE', async () => {
    const { fetcher } = textFetcher('this is not json')
    const promise = postTencentSearch(request({ fetcher }))

    await expect(promise).rejects.toBeInstanceOf(TencentSearchProtocolError)
    await expect(promise).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
  })
})

describe('postTencentSearch HTTP 与传输错误分类', () => {
  it.each([
    { status: 401, code: 'UNAUTHORIZED' },
    { status: 429, code: 'RATE_LIMITED' },
    { status: 500, code: 'SEARCH_FAILED' },
    { status: 503, code: 'SEARCH_FAILED' },
    { status: 403, code: 'SEARCH_FAILED' },
  ])('HTTP $status → $code', async ({ status, code }) => {
    const { fetcher } = textFetcher('upstream detail', status)

    await expect(postTencentSearch(request({ fetcher }))).rejects.toMatchObject({
      name: 'TencentSearchProtocolError',
      code,
      status,
    })
  })

  it('toTencentChannelSearchError 把实际 HTTP 401/403 保留为可信 httpStatus', async () => {
    for (const status of [401, 403]) {
      const { fetcher } = textFetcher('upstream detail', status)
      const protocolError = await postTencentSearch(request({ fetcher })).catch(
        (error: unknown) => error,
      )
      const bound = toTencentChannelSearchError(protocolError, 'buddy')
      expect(bound).toMatchObject({ channel: 'buddy', httpStatus: status })
      expect(bound.cause).toBe(protocolError)
    }
  })

  it('非 abort 的网络错误 → SEARCH_FAILED，并保留 cause', async () => {
    const networkError = new TypeError('network unreachable')
    const fetcher = vi.fn(async () => {
      throw networkError
    }) as unknown as typeof fetch

    await expect(postTencentSearch(request({ fetcher }))).rejects.toMatchObject({
      name: 'TencentSearchProtocolError',
      code: 'SEARCH_FAILED',
      cause: networkError,
    })
  })

  it('自己的 20s 预算耗尽 → TIMEOUT，且确实以 20000ms 创建超时信号', async () => {
    expect(TENCENT_SEARCH_TIMEOUT_MS).toBe(20_000)
    let timeoutController: AbortController | undefined
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      expect(ms).toBe(20_000)
      timeoutController = new AbortController()
      return timeoutController.signal
    })
    const { fetcher } = hangingFetcher()
    const promise = postTencentSearch(request({ fetcher }))
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'TencentSearchProtocolError',
      code: 'TIMEOUT',
    })

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    timeoutController!.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    await assertion
    expect(timeoutSpy).toHaveBeenCalledTimes(1)
  })

  it('外层 abort 归为 SEARCH_FAILED，不误报成自己的 20s TIMEOUT', async () => {
    const outer = new AbortController()
    const { fetcher } = hangingFetcher()
    const promise = postTencentSearch(request({ signal: outer.signal, fetcher }))
    const assertion = expect(promise).rejects.toMatchObject({
      code: 'SEARCH_FAILED',
      message: expect.stringContaining('aborted'),
    })

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    outer.abort()
    await assertion
  })

  it('调用前已 abort 时不发请求，也不归为 TIMEOUT', async () => {
    const outer = new AbortController()
    outer.abort()
    const { fetcher, calls } = jsonFetcher({ results: [] })

    await expect(postTencentSearch(request({ signal: outer.signal, fetcher }))).rejects.toMatchObject({
      code: 'SEARCH_FAILED',
    })
    expect(calls).toHaveLength(0)
  })

  it('外层 in-flight abort 为宿主 TimeoutReason(code=TOOL_TIMEOUT) → TIMEOUT', async () => {
    const outer = new AbortController()
    const { fetcher } = hangingFetcher()
    const promise = postTencentSearch(request({ signal: outer.signal, fetcher }))
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'TencentSearchProtocolError',
      code: 'TIMEOUT',
    })

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    outer.abort(new HostTimeoutReason('host deadline elapsed'))
    await assertion
  })

  it('调用前已以宿主 TimeoutReason(code=TOOL_TIMEOUT) abort → TIMEOUT 且 fetch 0 次', async () => {
    const outer = new AbortController()
    outer.abort(new HostTimeoutReason('host deadline elapsed'))
    const { fetcher, calls } = jsonFetcher({ results: [] })

    await expect(postTencentSearch(request({ signal: outer.signal, fetcher }))).rejects.toMatchObject({
      name: 'TencentSearchProtocolError',
      code: 'TIMEOUT',
    })
    expect(calls).toHaveLength(0)
  })

  it('非 TimeoutReason/TimeoutError name 但 code=TOOL_TIMEOUT 的宿主 reason → TIMEOUT', async () => {
    const outer = new AbortController()
    const { fetcher } = hangingFetcher()
    const promise = postTencentSearch(request({ signal: outer.signal, fetcher }))
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'TencentSearchProtocolError',
      code: 'TIMEOUT',
    })

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    outer.abort(new ToolTimeoutReason('host deadline elapsed'))
    await assertion
  })
})

/** 当前 DSH `deadline()` 的宿主真实形状。 */
class HostTimeoutReason extends Error {
  override name = 'TimeoutReason'
  readonly code = 'TOOL_TIMEOUT'
}

/** 仅靠 code 兼容的宿主 timeout 形状；name 不是已知超时名。 */
class ToolTimeoutReason extends Error {
  override name = 'ToolTimeoutError'
  readonly code = 'TOOL_TIMEOUT'
}

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
