/**
 * Qoder 中国版搜索驱动的行为守卫。
 *
 * ## 被锁死的契约
 *
 * 1. **固定端点**：签名输入 path 精确 `/api/v1/webSearch/oneSearch`，host 只能
 *    `gateway.qoder.com.cn`；实发 URL 由真实 WASM 生成
 *    `/algo/api/v1/webSearch/oneSearch?Encode=1`。
 * 2. **请求形状**：`POST`，body 为 `{payload: JSON.stringify({query,timeRange,contents}),encodeVersion:'1'}`
 *    经 WASM 加密后的密文；请求头原样透传 WASM 生成的 `Authorization: Bearer COSY.<…>` 与 `Cosy-*`。
 * 3. **投影**：`pageItems[].link → url`、title/snippet 一对一、合法 `publishedTime → publishedAt`；
 *    `hostname` / `hostLogo` 丢弃；畸形条目/响应防御不炸整条调用。
 * 4. **无账号**：缺 token / machineId 时在任何 fetch/WASM 之前以 `NO_ACCOUNT` 失败。
 * 5. **生命周期**：每次搜索的签名器在成功和失败后都 dispose，异常路径无 WASM 上下文泄漏。
 * 6. **秘密卫生**：token / machineId / 签名头不进入日志或错误消息。
 *
 * 测试只注入 fetcher（签名仍是真实 WASM），全程无真实厂商网络。
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  createQoderCnDriver,
  QODERCN_SEARCH_HOST,
  QODERCN_SEARCH_PATH,
} from '../../src/host/channels/qodercn/driver.ts'
import type {
  QoderRequestSigner,
  QoderSigningCredential,
} from '../../src/host/channels/qoder/protocol.ts'
import {
  postQoderSearch,
  QODER_SEARCH_PATH,
  QoderSearchProtocolError,
} from '../../src/host/channels/qoder/protocol.ts'
import { QoderSigner, __testing } from '../../src/host/channels/qoder/signer.ts'
import { ChannelSearchError } from '../../src/host/search/errors.ts'
import type { SearchDriver } from '../../src/host/drivers/mock-driver.ts'
import { installTextEncoderFault } from './support/text-encoder-fault.ts'

interface FetchCall {
  readonly url: string
  readonly init: RequestInit
}

interface DriverHarness {
  readonly driver: SearchDriver
  readonly calls: FetchCall[]
  readonly fetcher: Mock
  readonly resolver: Mock
}

const CREDENTIAL: QoderSigningCredential = {
  uid: 'TEST_UID_4d2e',
  securityOauthToken: 'TEST_SECURITY_TOKEN_9f3a',
  machineId: 'TEST_MACHINE_ID_7c1b',
}

const SECRET_VALUES = [CREDENTIAL.uid, CREDENTIAL.securityOauthToken, CREDENTIAL.machineId]

function makeCredential(overrides: Partial<QoderSigningCredential> = {}): QoderSigningCredential {
  return { ...CREDENTIAL, ...overrides }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeDriver(options: {
  readonly credential?: QoderSigningCredential | null | undefined
  readonly handler?: (init?: RequestInit) => Response | Promise<Response>
} = {}): DriverHarness {
  const calls: FetchCall[] = []
  const credential = 'credential' in options ? options.credential : makeCredential()
  const resolver = vi.fn(async () => credential)
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return await (options.handler ?? (() => jsonResponse({ pageItems: [] })))(init)
  })
  const driver = createQoderCnDriver({
    resolveCredential: resolver,
    fetcher: fetcher as unknown as typeof fetch,
  })
  return { driver, calls, fetcher, resolver }
}

/** 一直挂起直到请求 signal 被 abort；模拟真实 fetch 的取消行为。 */
function hangingHandler(): (init?: RequestInit) => Promise<Response> {
  return (init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (signal === undefined || signal === null) return
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

/** 返回固定 URL 的协议测试签名器（只测 URL 目标钉死，不参与真实签名）。 */
function fakeSigner(url: string): QoderRequestSigner {
  return {
    async prepare() {
      return { url, headers: { Authorization: 'Bearer COSY.fake' }, body: 'cipher-body' }
    },
    dispose() {},
  }
}

function errorTextOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Qoder CN 驱动：无可用账号（先于 fetch/WASM）', () => {
  it('凭据 undefined → NO_ACCOUNT，且不 fetch、不加载 WASM', async () => {
    const before = __testing.wasmStats()
    const { driver, calls, fetcher } = makeDriver({ credential: undefined })

    const error = await driver.searchOnce('q', 10, new AbortController().signal).catch(caught => caught)

    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'NO_ACCOUNT', channel: 'qodercn' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
    const after = __testing.wasmStats()
    expect(after.glueLoads).toBe(before.glueLoads)
    expect(after.contextsCreated).toBe(before.contextsCreated)
    expect(after.signerRefs).toBe(before.signerRefs)
  })

  it.each([
    ['空 token', { securityOauthToken: '' }],
    ['空白 token', { securityOauthToken: '   ' }],
    ['非字符串 token', { securityOauthToken: 42 as unknown as string }],
    ['空 machineId', { machineId: '' }],
    ['空白 machineId', { machineId: '   ' }],
    ['缺 machineId', { machineId: undefined as unknown as string }],
  ])('%s → NO_ACCOUNT 且不发请求', async (_label, overrides) => {
    const { driver, calls } = makeDriver({ credential: makeCredential(overrides) })
    await expect(driver.searchOnce('q', 10, new AbortController().signal)).rejects.toMatchObject({
      code: 'NO_ACCOUNT',
      channel: 'qodercn',
    })
    expect(calls).toHaveLength(0)
  })

  it('凭据解析器抛错 → SEARCH_FAILED，且不 fetch', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ pageItems: [] }))
    const driver = createQoderCnDriver({
      resolveCredential: async () => { throw new Error('credential store offline') },
      fetcher: fetcher as unknown as typeof fetch,
    })

    await expect(driver.searchOnce('q', 10, new AbortController().signal)).rejects.toMatchObject({
      code: 'SEARCH_FAILED',
      channel: 'qodercn',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('调用前已 abort 且无凭据时仍先报 NO_ACCOUNT', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('user stop', 'AbortError'))
    const { driver, calls } = makeDriver({ credential: undefined })

    await expect(driver.searchOnce('q', 10, controller.signal)).rejects.toMatchObject({
      code: 'NO_ACCOUNT',
      channel: 'qodercn',
    })
    expect(calls).toHaveLength(0)
  })

  it('只读取本渠道解析器，失败也不会回退官方全局 fetch', async () => {
    const officialFetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', officialFetch)
    const { driver, calls, resolver } = makeDriver({
      handler: () => new Response('{"error":"expired"}', { status: 401 }),
    })

    await expect(driver.searchOnce('q', 10, new AbortController().signal)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      channel: 'qodercn',
    })
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(1)
    expect(officialFetch).not.toHaveBeenCalled()
  })
})

describe('Qoder CN 驱动：固定端点与真实 WASM 签名', () => {
  it('签名输入 path 精确，实发 URL 由真实 WASM 生成 /algo/...?Encode=1', async () => {
    const prepareSpy = vi.spyOn(QoderSigner.prototype, 'prepare')
    const { driver, calls } = makeDriver({ handler: () => jsonResponse({ pageItems: [] }) })

    await driver.searchOnce('天气', 10, new AbortController().signal)

    expect(QODERCN_SEARCH_HOST).toBe('gateway.qoder.com.cn')
    expect(QODERCN_SEARCH_PATH).toBe('/api/v1/webSearch/oneSearch')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(
      'https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=1',
    )

    const [host, path, body] = prepareSpy.mock.calls[0] as unknown as [string, string, string]
    expect(host).toBe('gateway.qoder.com.cn')
    expect(path).toBe('/api/v1/webSearch/oneSearch')
    const envelope = JSON.parse(body) as { payload: string; encodeVersion: string }
    expect(envelope.encodeVersion).toBe('1')
    expect(JSON.parse(envelope.payload)).toEqual({
      query: '天气',
      timeRange: 'NoLimit',
      contents: { mainText: false, markdownText: false, summary: false },
    })
  })

  it('POST 密文 body，原样透传 WASM 签名头并附带 X-Session-ID', async () => {
    const { driver, calls } = makeDriver({ handler: () => jsonResponse({ pageItems: [] }) })

    await driver.searchOnce('天气', 10, new AbortController().signal)

    const init = calls[0]!.init
    expect(init.method).toBe('POST')
    // C1：不得跟随重定向把签名头/密文 body 重发到其他 host。
    expect(init.redirect).toBe('error')
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toMatch(/^Bearer COSY\./)
    expect(headers.get('X-Session-ID')).toMatch(/^[0-9a-f-]{36}$/i)
    expect([...headers.keys()].some(key => key.startsWith('cosy-'))).toBe(true)

    const body = String(init.body ?? '')
    expect(body.length).toBeGreaterThan(0)
    expect(body).not.toContain('天气')
    expect(body).not.toContain('payload')
    expect(() => JSON.parse(body)).toThrow()
  })

  it('只请求 gateway.qoder.com.cn，不出现国际版或其他域名', async () => {
    const { driver, calls } = makeDriver({ handler: () => jsonResponse({ pageItems: [] }) })

    await driver.searchOnce('q', 10, new AbortController().signal)

    expect(calls.every(call => call.url.startsWith('https://gateway.qoder.com.cn/'))).toBe(true)
    expect(calls.some(call => call.url.includes('qoder.sh'))).toBe(false)
  })
})

describe('Qoder 协议：签名 URL 目标钉死（C1）', () => {
  async function runWithSignedUrl(url: string): Promise<{
    error: unknown
    value: unknown
    calls: FetchCall[]
  }> {
    const calls: FetchCall[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      return jsonResponse({ pageItems: [] })
    })
    let error: unknown
    let value: unknown
    try {
      value = await postQoderSearch({
        host: QODERCN_SEARCH_HOST,
        path: QODER_SEARCH_PATH,
        query: 'q',
        credential: makeCredential(),
        signer: fakeSigner(url),
        signal: new AbortController().signal,
        fetcher: fetcher as unknown as typeof fetch,
      })
    } catch (caught) {
      error = caught
    }
    return { error, value, calls }
  }

  it.each([
    ['evil origin', 'https://evil.example/algo/api/v1/webSearch/oneSearch?Encode=1'],
    ['http 明文 origin', 'http://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=1'],
    ['wrong path', 'https://gateway.qoder.com.cn/algo/api/v1/other?Encode=1'],
    ['missing Encode', 'https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch'],
    ['Encode=0', 'https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=0'],
    ['invalid URL', 'not a url'],
  ])('%s → SEARCH_FAILED 且 fetch 0 次', async (_label, url) => {
    const { error, calls } = await runWithSignedUrl(url)
    expect(error).toBeInstanceOf(QoderSearchProtocolError)
    expect(error).toMatchObject({ code: 'SEARCH_FAILED' })
    expect(calls).toHaveLength(0)
  })

  it('合法真实 WASM URL 通过，并强制 redirect:error', async () => {
    const { error, value, calls } = await runWithSignedUrl(
      'https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=1',
    )
    expect(error).toBeUndefined()
    expect(value).toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init.redirect).toBe('error')
  })
})

describe('Qoder CN 驱动：结果投影', () => {
  it('pageItems[].link → url，title/snippet 一对一', async () => {
    const { driver } = makeDriver({
      handler: () => jsonResponse({
        pageItems: [
          { title: 'T1', link: 'https://a.test/', snippet: 'S1' },
          { title: 'T2', link: 'https://b.test/', snippet: 'S2' },
        ],
      }),
    })

    await expect(driver.searchOnce('q', 10, new AbortController().signal)).resolves.toEqual({
      sources: [
        { url: 'https://a.test/', title: 'T1', snippet: 'S1' },
        { url: 'https://b.test/', title: 'T2', snippet: 'S2' },
      ],
      truncated: false,
    })
  })

  it('合法 publishedTime → publishedAt；hostname / hostLogo 丢弃', async () => {
    const { driver } = makeDriver({
      handler: () => jsonResponse({
        pageItems: [{
          title: 'T',
          link: 'https://a.test/',
          snippet: 'S',
          publishedTime: '2026-10-01T00:00:00+08:00',
          hostname: 'a.test',
          hostLogo: 'https://logo.test/a.png',
        }],
      }),
    })

    const result = await driver.searchOnce('q', 10, new AbortController().signal)
    expect(result.sources).toEqual([{
      url: 'https://a.test/',
      title: 'T',
      snippet: 'S',
      publishedAt: '2026-10-01T00:00:00+08:00',
    }])
    expect(Object.keys(result.sources[0]!).sort()).toEqual(['publishedAt', 'snippet', 'title', 'url'])
  })

  it('非法 publishedTime 不投影为 publishedAt（不是填空串）', async () => {
    const { driver } = makeDriver({
      handler: () => jsonResponse({
        pageItems: [
          { link: 'https://a.test/', publishedTime: 'not-a-date' },
          { link: 'https://b.test/', publishedTime: '' },
          { link: 'https://c.test/', publishedTime: 123 },
          { link: 'https://d.test/', publishedTime: '2026-10-01' },
        ],
      }),
    })

    const result = await driver.searchOnce('q', 10, new AbortController().signal)
    expect(result.sources).toEqual([
      { url: 'https://a.test/' },
      { url: 'https://b.test/' },
      { url: 'https://c.test/' },
      { url: 'https://d.test/', publishedAt: '2026-10-01' },
    ])
  })

  it('空 title / snippet / 非字符串字段不出现；空 pageItems → 空数组', async () => {
    const { driver } = makeDriver({
      handler: () => jsonResponse({
        pageItems: [
          { title: '', link: 'https://a.test/' },
          { title: 123, link: 'https://b.test/', snippet: '' },
        ],
      }),
    })
    await expect(driver.searchOnce('q', 10, new AbortController().signal)).resolves.toEqual({
      sources: [{ url: 'https://a.test/' }, { url: 'https://b.test/' }],
      truncated: false,
    })

    const empty = makeDriver({ handler: () => jsonResponse({ pageItems: [] }) })
    await expect(empty.driver.searchOnce('q', 10, new AbortController().signal)).resolves.toEqual({
      sources: [],
      truncated: false,
    })
  })

  it('畸形条目被丢弃：null、非对象、缺 link', async () => {
    const { driver } = makeDriver({
      handler: () => jsonResponse({
        pageItems: [null, 'text', { title: 'no-link' }, { link: 'https://ok.test/' }],
      }),
    })

    await expect(driver.searchOnce('q', 10, new AbortController().signal)).resolves.toEqual({
      sources: [{ url: 'https://ok.test/' }],
      truncated: false,
    })
  })
})

describe('Qoder CN 驱动：畸形响应防御', () => {
  it.each([
    ['JSON null', () => jsonResponse(null)],
    ['数组', () => jsonResponse([{ link: 'https://a.test/' }])],
    ['缺 pageItems', () => jsonResponse({ requestId: 'r', searchInformation: {} })],
    ['非 JSON', () => new Response('<html>', { status: 200 })],
  ])('%s → BAD_RESPONSE', async (_label, handler) => {
    const { driver } = makeDriver({ handler })
    const error = await driver.searchOnce('q', 10, new AbortController().signal).catch(caught => caught)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'BAD_RESPONSE', channel: 'qodercn' })
  })
})

describe('Qoder CN 驱动：失败分类', () => {
  it.each([
    [401, 'UNAUTHORIZED'],
    [429, 'RATE_LIMITED'],
    [500, 'SEARCH_FAILED'],
  ])('HTTP %i → %s，消息带固定端点路径且不含秘密', async (status, code) => {
    const { driver } = makeDriver({
      handler: () => new Response('{"error":"upstream rejected"}', { status }),
    })

    const error = await driver.searchOnce('q', 10, new AbortController().signal).catch(caught => caught)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code, channel: 'qodercn' })
    expect(errorTextOf(error)).toContain('/api/v1/webSearch/oneSearch')
    for (const secret of SECRET_VALUES) expect(errorTextOf(error)).not.toContain(secret)
  })

  it('自己的 20s 预算耗尽 → TIMEOUT', async () => {
    let timeoutController: AbortController | undefined
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      expect(ms).toBe(20_000)
      timeoutController = new AbortController()
      return timeoutController.signal
    })
    const { driver, fetcher } = makeDriver({ handler: hangingHandler() })

    const promise = driver.searchOnce('q', 10, new AbortController().signal)
    const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT', channel: 'qodercn' })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    timeoutController!.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    await assertion
    const error = await promise.catch(caught => caught)
    expect(errorTextOf(error)).toMatch(/20000ms/)
  })

  it('调用方普通取消 → SEARCH_FAILED，不误报 TIMEOUT', async () => {
    const outer = new AbortController()
    const { driver, fetcher } = makeDriver({ handler: hangingHandler() })

    const promise = driver.searchOnce('q', 10, outer.signal)
    const assertion = expect(promise).rejects.toMatchObject({ code: 'SEARCH_FAILED', channel: 'qodercn' })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    outer.abort()
    await assertion
  })

  it('宿主 deadline（TimeoutReason/TOOL_TIMEOUT）→ TIMEOUT', async () => {
    const outer = new AbortController()
    const { driver, fetcher } = makeDriver({ handler: hangingHandler() })

    const promise = driver.searchOnce('q', 10, outer.signal)
    const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT', channel: 'qodercn' })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    outer.abort(Object.assign(new Error('TOOL_TIMEOUT'), {
      name: 'TimeoutReason',
      code: 'TOOL_TIMEOUT',
    }))
    await assertion
  })

  it('非 abort 的传输失败 → SEARCH_FAILED', async () => {
    const { driver } = makeDriver({
      handler: () => { throw new Error('ECONNRESET') },
    })
    await expect(driver.searchOnce('q', 10, new AbortController().signal)).rejects.toMatchObject({
      code: 'SEARCH_FAILED',
      channel: 'qodercn',
    })
  })
})

describe('Qoder CN 驱动：签名器生命周期（成功与失败都 dispose）', () => {
  it('成功搜索后 dispose 本次签名器，且无上下文泄漏', async () => {
    const prepareSpy = vi.spyOn(QoderSigner.prototype, 'prepare')
    const disposeSpy = vi.spyOn(QoderSigner.prototype, 'dispose')
    const before = __testing.wasmStats()
    const { driver } = makeDriver({ handler: () => jsonResponse({ pageItems: [{ link: 'https://a.test/' }] }) })

    await driver.searchOnce('q', 10, new AbortController().signal)

    expect(prepareSpy).toHaveBeenCalledTimes(1)
    expect(disposeSpy).toHaveBeenCalledTimes(1)
    const signer = prepareSpy.mock.contexts[0] as QoderSigner
    expect(signer.isDisposed).toBe(true)
    expect(signer.inflight).toBe(0)
    const after = __testing.wasmStats()
    expect(after.contextsCreated - before.contextsCreated).toBe(1)
    expect(after.contextsFreed - before.contextsFreed).toBe(1)
  })

  it('失败搜索（HTTP 401）后同样 dispose，且无上下文泄漏', async () => {
    const prepareSpy = vi.spyOn(QoderSigner.prototype, 'prepare')
    const disposeSpy = vi.spyOn(QoderSigner.prototype, 'dispose')
    const before = __testing.wasmStats()
    const { driver } = makeDriver({ handler: () => new Response('denied', { status: 401 }) })

    await expect(driver.searchOnce('q', 10, new AbortController().signal)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      channel: 'qodercn',
    })

    expect(prepareSpy).toHaveBeenCalledTimes(1)
    expect(disposeSpy).toHaveBeenCalledTimes(1)
    const signer = prepareSpy.mock.contexts[0] as QoderSigner
    expect(signer.isDisposed).toBe(true)
    const after = __testing.wasmStats()
    expect(after.contextsCreated - before.contextsCreated).toBe(1)
    expect(after.contextsFreed - before.contextsFreed).toBe(1)
  })

  it('失败搜索（传输异常）后同样 dispose', async () => {
    const disposeSpy = vi.spyOn(QoderSigner.prototype, 'dispose')
    const { driver } = makeDriver({ handler: () => { throw new Error('ECONNRESET') } })

    await expect(driver.searchOnce('q', 10, new AbortController().signal)).rejects.toMatchObject({
      code: 'SEARCH_FAILED',
      channel: 'qodercn',
    })
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('并发搜索各自独立签名并释放', async () => {
    const { driver, calls } = makeDriver({
      handler: () => jsonResponse({ pageItems: [{ link: 'https://a.test/' }] }),
    })

    const results = await Promise.all([
      driver.searchOnce('q1', 10, new AbortController().signal),
      driver.searchOnce('q2', 10, new AbortController().signal),
    ])

    expect(calls).toHaveLength(2)
    expect(results).toEqual([
      { sources: [{ url: 'https://a.test/' }], truncated: false },
      { sources: [{ url: 'https://a.test/' }], truncated: false },
    ])
  })
})

/** 断言错误文本、日志与 cause 链都不含假秘密/签名头。 */
function expectNoSecrets(error: unknown, logs: string): void {
  for (const secret of SECRET_VALUES) {
    expect(errorTextOf(error)).not.toContain(secret)
    expect(logs).not.toContain(secret)
  }
  expect(errorTextOf(error)).not.toContain('COSY')
  expect(logs).not.toContain('COSY')
  expect((error as { cause?: unknown }).cause).toBeUndefined()
}

function captureConsole(): { readonly text: () => string; readonly restore: () => void } {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const)
    .map(method => vi.spyOn(console, method).mockImplementation(() => {}))
  return {
    text: () => spies
      .flatMap(spy => spy.mock.calls.flat())
      .map(value => (typeof value === 'string' ? value : JSON.stringify(value)))
      .join(' '),
    restore: () => { spies.forEach(spy => spy.mockRestore()) },
  }
}

describe('Qoder CN 驱动：错误边界脱敏（I3）', () => {
  it.each([401, 429, 500])('HTTP %i 响应体回显秘密时错误不含秘密/cause', async (status) => {
    const consoleCapture = captureConsole()
    const leakedBody = `{"error":"token ${CREDENTIAL.securityOauthToken} machine ${CREDENTIAL.machineId} Authorization: Bearer COSY.leak"}`
    const { driver } = makeDriver({
      handler: () => new Response(leakedBody, { status }),
    })

    const error = await driver.searchOnce('q', 10, new AbortController().signal).catch(caught => caught)
    const logs = consoleCapture.text()
    consoleCapture.restore()

    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(errorTextOf(error)).toContain(String(status))
    expectNoSecrets(error, logs)
  })

  it('transport 底层异常回显秘密时错误不含秘密/cause', async () => {
    const consoleCapture = captureConsole()
    const { driver } = makeDriver({
      handler: () => {
        throw new Error(
          `proxy saw token ${CREDENTIAL.securityOauthToken} machine ${CREDENTIAL.machineId} `
          + 'Authorization: Bearer COSY.leak',
        )
      },
    })

    const error = await driver.searchOnce('q', 10, new AbortController().signal).catch(caught => caught)
    const logs = consoleCapture.text()
    consoleCapture.restore()

    expect(error).toBeInstanceOf(ChannelSearchError)
    expectNoSecrets(error, logs)
  })

  it('credential resolver 异常回显秘密时错误不含秘密/cause', async () => {
    const consoleCapture = captureConsole()
    const fetcher = vi.fn(async () => jsonResponse({ pageItems: [] }))
    const driver = createQoderCnDriver({
      resolveCredential: async () => {
        throw new Error(
          `credential store echoed ${CREDENTIAL.securityOauthToken} / ${CREDENTIAL.machineId}`,
        )
      },
      fetcher: fetcher as unknown as typeof fetch,
    })

    const error = await driver.searchOnce('q', 10, new AbortController().signal).catch(caught => caught)
    const logs = consoleCapture.text()
    consoleCapture.restore()

    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(fetcher).not.toHaveBeenCalled()
    expectNoSecrets(error, logs)
  })

  it('signing 阶段异常回显秘密时错误不含秘密/cause', async () => {
    const consoleCapture = captureConsole()
    const { driver } = makeDriver({ handler: () => jsonResponse({ pageItems: [] }) })
    const faultQuery = 'I3_SIGNING_FAULT_QUERY'
    const restore = installTextEncoderFault({
      match: input => input.includes(faultQuery),
      mode: 'before-allocation',
      message: `injected signing leak ${CREDENTIAL.securityOauthToken} ${CREDENTIAL.machineId} Bearer COSY.leak`,
    })
    let error: unknown
    try {
      error = await driver.searchOnce(faultQuery, 10, new AbortController().signal).catch(caught => caught)
    } finally {
      restore()
    }
    const logs = consoleCapture.text()
    consoleCapture.restore()

    expect(error).toBeInstanceOf(ChannelSearchError)
    expectNoSecrets(error, logs)
  })
})

describe('Qoder CN 驱动：秘密卫生', () => {
  it('日志与错误消息不包含 token / machineId / 签名头', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const)
      .map(method => vi.spyOn(console, method).mockImplementation(() => {}))
    const { driver } = makeDriver({
      handler: () => new Response('upstream rejected', { status: 401 }),
    })

    const error = await driver.searchOnce('q', 10, new AbortController().signal).catch(caught => caught)
    const logs = spies
      .flatMap(spy => spy.mock.calls.flat())
      .map(value => (typeof value === 'string' ? value : JSON.stringify(value)))
      .join(' ')
    spies.forEach(spy => spy.mockRestore())

    const output = `${errorTextOf(error)} ${logs}`
    for (const secret of SECRET_VALUES) expect(output).not.toContain(secret)
    expect(output).not.toContain('COSY.')
    expect(output).not.toContain('Bearer COSY')
  })
})
