/**
 * Qoder 国际版搜索驱动的行为守卫。
 *
 * ## 被锁死的契约
 *
 * 1. **域名边界**：只允许 `center.qoder.sh` / `api2.qoder.sh`；绝不出现
 *    `gateway.qoder.com.cn`、其他渠道或官方全局 fetch。
 * 2. **自动模式**：初始 center；只有连接失败、请求超时、上游 5xx 才在同一账号、
 *    同一 query 下顺序切换另一域一次；401/403/429/坏响应/签名失败都不切换。
 * 3. **固定模式**：center / api2 只走所选域，任何错误都不切换。
 * 4. **粘性**：成功域按「账号 + 网络出口」在当前进程内粘性；不同账号、不同出口、
 *    新驱动实例互不共享。
 * 5. **无账号**：缺账号/凭据/账号键时在任何 fetch/WASM 之前失败。
 * 6. **秘密卫生**：错误消息、观察记录与日志不含 query、token、machineId、
 *    账号键或签名头；两域失败错误只含域名与结构化类别。
 * 7. **生命周期**：每次尝试独立签名器，成功与失败后都 dispose。
 *
 * 测试只注入 fetcher（签名仍是真实 WASM），全程无真实厂商网络。
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  createQoderInternationalDriver,
  QODER_CHANNEL,
  QODER_INTERNATIONAL_SEARCH_PATH,
  type QoderInternationalAccount,
} from '../../src/host/channels/qoder/driver.ts'
import {
  QODER_INTERNATIONAL_HOSTS,
  type QoderEndpointObservation,
} from '../../src/host/channels/qoder/endpoint-policy.ts'
import type { QoderSigningCredential } from '../../src/host/channels/qoder/protocol.ts'
import { QoderSigner, __testing } from '../../src/host/channels/qoder/signer.ts'
import type { SearchDriver } from '../../src/host/drivers/mock-driver.ts'
import { ChannelSearchError } from '../../src/host/search/errors.ts'
import type { QoderEndpointPreference } from '../../src/shared/channels.ts'
import { installTextEncoderFault } from './support/text-encoder-fault.ts'

const CENTER = 'center.qoder.sh'
const API2 = 'api2.qoder.sh'
const SEARCH_PATH = '/api/v1/webSearch/oneSearch'

const CREDENTIAL: QoderSigningCredential = {
  uid: 'TEST_UID_7f2c',
  securityOauthToken: 'TEST_SECURITY_TOKEN_7f2c',
  machineId: 'TEST_MACHINE_ID_7f2c',
}

const SECRET_VALUES = [CREDENTIAL.uid!, CREDENTIAL.securityOauthToken, CREDENTIAL.machineId]

const ACCOUNT_A: QoderInternationalAccount = {
  channelId: 'qoder',
  accountId: 'a0000000000a1',
  credential: CREDENTIAL,
}
const ACCOUNT_B: QoderInternationalAccount = {
  channelId: 'qoder',
  accountId: 'a0000000000b2',
  credential: CREDENTIAL,
}

const QUERY = '国际版测试查询 7f2c'

interface FetchCall {
  readonly url: string
  readonly init: RequestInit
}

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>

interface HarnessOptions {
  readonly account?: QoderInternationalAccount | null | undefined
  readonly preference?: QoderEndpointPreference
  readonly exitKey?: string
  readonly handler?: FetchHandler
}

interface Harness {
  readonly driver: SearchDriver
  readonly calls: FetchCall[]
  readonly observations: QoderEndpointObservation[]
  readonly accountResolver: Mock
  readonly preferenceResolver: Mock
  setAccount(account: QoderInternationalAccount | null | undefined): void
  setPreference(preference: QoderEndpointPreference): void
  setExitKey(key: string): void
  setHandler(handler: FetchHandler): void
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const DEFAULT_RESULT = { pageItems: [{ link: 'https://result.test/' }] }

function defaultHandler(): Response {
  return jsonResponse(DEFAULT_RESULT)
}

function hostOf(url: string): string {
  return new URL(url).hostname
}

/** 一直挂起直到请求 signal 被 abort；模拟真实 fetch 的取消行为。 */
function hangingHandler(): FetchHandler {
  return (_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal
    if (signal === undefined || signal === null) return
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const calls: FetchCall[] = []
  const observations: QoderEndpointObservation[] = []
  let account = 'account' in options ? options.account : ACCOUNT_A
  let preference = options.preference ?? 'auto'
  let exitKey = options.exitKey ?? 'exit-a'
  let handler = options.handler ?? defaultHandler

  const accountResolver = vi.fn(async () => account)
  const preferenceResolver = vi.fn(async () => preference)
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const requestInit = init ?? {}
    calls.push({ url, init: requestInit })
    return await handler(url, requestInit)
  })

  const driver = createQoderInternationalDriver({
    resolveAccount: accountResolver,
    resolveEndpointPreference: preferenceResolver,
    networkExitKey: () => exitKey,
    fetcher: fetcher as unknown as typeof fetch,
    onObservation: (observation) => { observations.push(observation) },
  })

  return {
    driver,
    calls,
    observations,
    accountResolver,
    preferenceResolver,
    setAccount: (next) => { account = next },
    setPreference: (next) => { preference = next },
    setExitKey: (next) => { exitKey = next },
    setHandler: (next) => { handler = next },
  }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function errorTextOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 只让 center 连接失败，其余（含 api2）成功。 */
function failCenterConnection(url: string): Response {
  if (hostOf(url) === CENTER) throw new TypeError('fetch failed')
  return jsonResponse(DEFAULT_RESULT)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Qoder 国际版驱动：固定端点', () => {
  it('固定 center：真实 WASM 签名只发往 center.qoder.sh', async () => {
    const { driver, calls } = makeHarness({ preference: 'center' })

    const result = await driver.searchOnce(QUERY, 10, signal())

    expect(QODER_INTERNATIONAL_SEARCH_PATH).toBe(SEARCH_PATH)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`https://${CENTER}/algo${SEARCH_PATH}?Encode=1`)
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.redirect).toBe('error')
    expect(result).toEqual({
      sources: [{ url: 'https://result.test/' }],
      truncated: false,
    })
  })

  it('固定 api2：真实 WASM 签名只发往 api2.qoder.sh', async () => {
    const { driver, calls } = makeHarness({ preference: 'api2' })

    await driver.searchOnce(QUERY, 10, signal())
    expect(calls.map(call => hostOf(call.url))).toEqual([API2])
  })

  it('固定 center 遇到 500 不切到 api2', async () => {
    const { driver, calls } = makeHarness({
      preference: 'center',
      handler: () => new Response('upstream boom', { status: 500 }),
    })

    await expect(driver.searchOnce(QUERY, 10, signal())).rejects.toMatchObject({
      code: 'SEARCH_FAILED',
      channel: QODER_CHANNEL,
    })
    expect(calls.map(call => hostOf(call.url))).toEqual([CENTER])
  })

  it('固定 center 连接失败不切到 api2', async () => {
    const { driver, calls } = makeHarness({
      preference: 'center',
      handler: () => { throw new TypeError('fetch failed') },
    })

    await expect(driver.searchOnce(QUERY, 10, signal())).rejects.toMatchObject({
      code: 'SEARCH_FAILED',
      channel: QODER_CHANNEL,
    })
    expect(calls.map(call => hostOf(call.url))).toEqual([CENTER])
  })

  it('固定 api2 遇到 500 不切到 center', async () => {
    const { driver, calls } = makeHarness({
      preference: 'api2',
      handler: () => new Response('upstream boom', { status: 500 }),
    })

    await expect(driver.searchOnce(QUERY, 10, signal())).rejects.toMatchObject({
      code: 'SEARCH_FAILED',
      channel: QODER_CHANNEL,
    })
    expect(calls.map(call => hostOf(call.url))).toEqual([API2])
  })
})

describe('Qoder 国际版驱动：可信 HTTP 状态透传', () => {
  it('实际 HTTP 401 透传 httpStatus=401（供同账号刷新重试判定）', async () => {
    const { driver, calls } = makeHarness({
      preference: 'center',
      handler: () => new Response('denied', { status: 401 }),
    })

    const error = await driver.searchOnce(QUERY, 10, signal()).catch(caught => caught)

    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({
      code: 'UNAUTHORIZED',
      channel: QODER_CHANNEL,
      httpStatus: 401,
    })
    expect(calls.map(call => hostOf(call.url))).toEqual([CENTER])
  })

  it('实际 HTTP 403 透传 httpStatus=403，不得伪造成 401', async () => {
    const { driver } = makeHarness({
      preference: 'center',
      handler: () => new Response('forbidden', { status: 403 }),
    })

    const error = await driver.searchOnce(QUERY, 10, signal()).catch(caught => caught)

    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'SEARCH_FAILED', channel: QODER_CHANNEL, httpStatus: 403 })
  })
})

describe('Qoder 国际版驱动：自动模式限定切换', () => {
  it('auto 初始只请求 center.qoder.sh', async () => {
    const { driver, calls, observations } = makeHarness()

    await driver.searchOnce(QUERY, 10, signal())

    expect(calls.map(call => hostOf(call.url))).toEqual([CENTER])
    expect(observations[0]).toMatchObject({
      preference: 'auto',
      outcome: 'succeeded',
      host: CENTER,
    })
  })

  it('auto 连接失败后同账号同 query 顺序切到 api2，并保持粘性', async () => {
    const prepareSpy = vi.spyOn(QoderSigner.prototype, 'prepare')
    const { driver, calls } = makeHarness({ handler: failCenterConnection })

    const result = await driver.searchOnce(QUERY, 10, signal())
    expect(result.sources).toEqual([{ url: 'https://result.test/' }])
    expect(calls.map(call => hostOf(call.url))).toEqual([CENTER, API2])

    // 两次尝试使用同一账号凭据与同一 query 的明文信封（只换 host）。
    const hosts = prepareSpy.mock.calls.map(call => call[0] as string)
    const bodies = prepareSpy.mock.calls.map(call => call[2] as string)
    expect(hosts).toEqual([CENTER, API2])
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toBe(bodies[1])
    expect(JSON.parse(JSON.parse(bodies[0]!).payload).query).toBe(QUERY)

    // 粘性：下一次调用先走 api2，不再请求 center。
    await driver.searchOnce('第二次查询', 10, signal())
    expect(calls.map(call => hostOf(call.url))).toEqual([CENTER, API2, API2])
  })

  it('auto 请求超时后切换另一域', async () => {
    const timeoutControllers: AbortController[] = []
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController()
      timeoutControllers.push(controller)
      return controller.signal
    })
    const { driver, calls } = makeHarness({ handler: hangingHandler() })

    const promise = driver.searchOnce(QUERY, 10, signal())
    await vi.waitFor(() => expect(timeoutControllers).toHaveLength(1))
    timeoutControllers[0]!.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    timeoutControllers[1]!.abort(new DOMException('The operation timed out.', 'TimeoutError'))

    const error = await promise.catch(caught => caught)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'TIMEOUT', channel: QODER_CHANNEL })
    expect(errorTextOf(error)).toContain(CENTER)
    expect(errorTextOf(error)).toContain(API2)
    expect(calls.map(call => hostOf(call.url))).toEqual([CENTER, API2])
  })

  it('auto 上游 5xx 后切换另一域', async () => {
    const { driver, calls } = makeHarness({
      handler: (url) => {
        if (hostOf(url) === CENTER) return new Response('boom', { status: 503 })
        return jsonResponse(DEFAULT_RESULT)
      },
    })

    await expect(driver.searchOnce(QUERY, 10, signal())).resolves.toMatchObject({
      sources: [{ url: 'https://result.test/' }],
    })
    expect(calls.map(call => hostOf(call.url))).toEqual([CENTER, API2])
  })

  it.each([
    ['401 未授权', () => new Response('denied', { status: 401 }), 'UNAUTHORIZED'],
    ['403 禁止', () => new Response('forbidden', { status: 403 }), 'SEARCH_FAILED'],
    ['429 限流', () => new Response('slow down', { status: 429 }), 'RATE_LIMITED'],
  ])('auto %s 不切换域名', async (_label, makeResponse, code) => {
    const { driver, calls } = makeHarness({ handler: () => makeResponse() })

    await expect(driver.searchOnce(QUERY, 10, signal())).rejects.toMatchObject({
      code,
      channel: QODER_CHANNEL,
    })
    expect(calls.map(call => hostOf(call.url))).toEqual([CENTER])
  })

  it('auto 响应格式错误不切换域名', async () => {
    const { driver, calls } = makeHarness({
      handler: () => new Response('<html>not json</html>', { status: 200 }),
    })

    await expect(driver.searchOnce(QUERY, 10, signal())).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
      channel: QODER_CHANNEL,
    })
    expect(calls.map(call => hostOf(call.url))).toEqual([CENTER])
  })

  it('auto 签名阶段失败不切换域名', async () => {
    const prepareSpy = vi.spyOn(QoderSigner.prototype, 'prepare')
    const faultQuery = '签名故障查询 7f2c'
    const restore = installTextEncoderFault({
      match: input => input.includes(faultQuery),
      mode: 'before-allocation',
    })
    try {
      const { driver, calls } = makeHarness()
      const error = await driver.searchOnce(faultQuery, 10, signal()).catch(caught => caught)

      expect(error).toBeInstanceOf(ChannelSearchError)
      expect(error).toMatchObject({ code: 'SEARCH_FAILED', channel: QODER_CHANNEL })
      expect(calls).toHaveLength(0)
      expect(prepareSpy).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('auto 调用方取消不切换域名', async () => {
    const outer = new AbortController()
    const { driver, calls } = makeHarness({ handler: hangingHandler() })

    const promise = driver.searchOnce(QUERY, 10, outer.signal)
    const assertion = expect(promise).rejects.toMatchObject({
      code: 'SEARCH_FAILED',
      channel: QODER_CHANNEL,
    })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    outer.abort()
    await assertion
    expect(calls.map(call => hostOf(call.url))).toEqual([CENTER])
  })
})

describe('Qoder 国际版驱动：两域失败可归因', () => {
  it('两域都失败时错误包含两个域名与结构化类别，且不含秘密', async () => {
    const { driver, calls } = makeHarness({
      handler: (url) => {
        if (hostOf(url) === CENTER) return new Response('upstream boom', { status: 503 })
        throw new TypeError('fetch failed')
      },
    })

    const error = await driver.searchOnce(QUERY, 10, signal()).catch(caught => caught)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'SEARCH_FAILED', channel: QODER_CHANNEL })
    const text = errorTextOf(error)
    expect(text).toContain(CENTER)
    expect(text).toContain(API2)
    expect(text).toContain('server_error')
    expect(text).toContain('connection')
    expect(text).toContain('503')
    for (const secret of SECRET_VALUES) expect(text).not.toContain(secret)
    expect(text).not.toContain(QUERY)
    expect(text).not.toContain('COSY')
    expect((error as { cause?: unknown }).cause).toBeUndefined()
    expect(calls.map(call => hostOf(call.url))).toEqual([CENTER, API2])
  })

  it('两域失败时单 query 每域最多一次', async () => {
    const { driver, calls } = makeHarness({
      handler: () => { throw new TypeError('fetch failed') },
    })

    await driver.searchOnce(QUERY, 10, signal()).catch(() => undefined)
    expect(calls).toHaveLength(2)
    expect(calls.map(call => hostOf(call.url))).toEqual([CENTER, API2])
  })
})

describe('Qoder 国际版驱动：账号边界（先于 fetch/WASM）', () => {
  it('无账号 → NO_ACCOUNT，且不 fetch、不加载 WASM、不解析偏好', async () => {
    const before = __testing.wasmStats()
    const { driver, calls, preferenceResolver } = makeHarness({ account: undefined })

    const error = await driver.searchOnce(QUERY, 10, signal()).catch(caught => caught)

    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'NO_ACCOUNT', channel: QODER_CHANNEL })
    expect(calls).toHaveLength(0)
    expect(preferenceResolver).not.toHaveBeenCalled()
    const after = __testing.wasmStats()
    expect(after.glueLoads).toBe(before.glueLoads)
    expect(after.contextsCreated).toBe(before.contextsCreated)
    expect(after.signerRefs).toBe(before.signerRefs)
  })

  it.each([
    ['空 token', { securityOauthToken: '' }],
    ['空白 token', { securityOauthToken: '   ' }],
    ['空 machineId', { machineId: '' }],
    ['空白 machineId', { machineId: '   ' }],
  ])('%s → NO_ACCOUNT 且不发请求', async (_label, overrides) => {
    const { driver, calls } = makeHarness({
      account: {
        channelId: 'qoder',
        accountId: 'a0000000000c3',
        credential: { ...CREDENTIAL, ...overrides },
      },
    })

    await expect(driver.searchOnce(QUERY, 10, signal())).rejects.toMatchObject({
      code: 'NO_ACCOUNT',
      channel: QODER_CHANNEL,
    })
    expect(calls).toHaveLength(0)
  })

  it('缺账号键 → INVALID_ARGUMENTS 且不发请求', async () => {
    const { driver, calls } = makeHarness({
      account: { channelId: 'qoder', accountId: '   ', credential: CREDENTIAL },
    })

    await expect(driver.searchOnce(QUERY, 10, signal())).rejects.toMatchObject({
      code: 'INVALID_ARGUMENTS',
      channel: QODER_CHANNEL,
    })
    expect(calls).toHaveLength(0)
  })

  it('拿到其他渠道的账号快照时 fail-closed（SEARCH_FAILED）且不发请求/不加载 WASM', async () => {
    const before = __testing.wasmStats()
    const { driver, calls, preferenceResolver } = makeHarness({
      account: {
        channelId: 'qodercn',
        accountId: 'a0000000000d4',
        credential: CREDENTIAL,
      } as unknown as QoderInternationalAccount,
    })

    const error = await driver.searchOnce(QUERY, 10, signal()).catch(caught => caught)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'SEARCH_FAILED', channel: QODER_CHANNEL })
    expect(calls).toHaveLength(0)
    expect(preferenceResolver).not.toHaveBeenCalled()
    const after = __testing.wasmStats()
    expect(after.contextsCreated).toBe(before.contextsCreated)
  })

  it.each([
    ['NO_ACCOUNT', '账号缺失'],
    ['UNAUTHORIZED', '凭据过期'],
    ['TIMEOUT', '解析超时'],
  ])('解析器抛 %s（其他渠道绑定 + 秘密原文）时保留 code、重绑 qoder 且不泄露', async (code) => {
    const secret = 'QODER_RESOLVER_SECRET_7f2c'
    const fetcher = vi.fn(async () => jsonResponse(DEFAULT_RESULT))
    const driver = createQoderInternationalDriver({
      resolveAccount: async () => {
        throw new ChannelSearchError(code as never, 'qodercn', `store echoed ${secret}`)
      },
      resolveEndpointPreference: async () => 'auto' as const,
      networkExitKey: () => 'exit-a',
      fetcher: fetcher as unknown as typeof fetch,
    })

    const error = await driver.searchOnce(QUERY, 10, signal()).catch(caught => caught)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code, channel: QODER_CHANNEL })
    expect(errorTextOf(error)).not.toContain(secret)
    expect((error as { cause?: unknown }).cause).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('账号解析器抛错 → SEARCH_FAILED 且不 fetch', async () => {
    const fetcher = vi.fn(async () => jsonResponse(DEFAULT_RESULT))
    const driver = createQoderInternationalDriver({
      resolveAccount: async () => { throw new Error(`store offline ${CREDENTIAL.securityOauthToken}`) },
      resolveEndpointPreference: async () => 'auto' as const,
      networkExitKey: () => 'exit-a',
      fetcher: fetcher as unknown as typeof fetch,
    })

    const error = await driver.searchOnce(QUERY, 10, signal()).catch(caught => caught)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'SEARCH_FAILED', channel: QODER_CHANNEL })
    expect(errorTextOf(error)).not.toContain(CREDENTIAL.securityOauthToken)
    expect((error as { cause?: unknown }).cause).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('端点偏好解析器抛错 → SEARCH_FAILED 且不 fetch', async () => {
    const fetcher = vi.fn(async () => jsonResponse(DEFAULT_RESULT))
    const driver = createQoderInternationalDriver({
      resolveAccount: async () => ACCOUNT_A,
      resolveEndpointPreference: async () => { throw new Error('settings offline') },
      networkExitKey: () => 'exit-a',
      fetcher: fetcher as unknown as typeof fetch,
    })

    await expect(driver.searchOnce(QUERY, 10, signal())).rejects.toMatchObject({
      code: 'SEARCH_FAILED',
      channel: QODER_CHANNEL,
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('Qoder 国际版驱动：渠道与域名边界', () => {
  it('只使用 center / api2，绝不出现 gateway、中国版或其他渠道域名', async () => {
    const { driver, calls } = makeHarness({
      handler: () => { throw new TypeError('fetch failed') },
    })

    await driver.searchOnce(QUERY, 10, signal()).catch(() => undefined)

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      const host = hostOf(call.url)
      expect(QODER_INTERNATIONAL_HOSTS as readonly string[]).toContain(host)
      expect(call.url.startsWith(`https://${host}/algo${SEARCH_PATH}?Encode=1`)).toBe(true)
    }
    const all = calls.map(call => call.url).join(' ')
    expect(all).not.toContain('gateway')
    expect(all).not.toContain('qoder.com.cn')
    expect(all).not.toContain('workbuddy')
    expect(all).not.toContain('copilot.tencent.com')
  })

  it('不回退官方全局 fetch', async () => {
    const officialFetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', officialFetch)
    const { driver, calls } = makeHarness({ handler: failCenterConnection })

    await driver.searchOnce(QUERY, 10, signal())

    expect(officialFetch).not.toHaveBeenCalled()
    expect(calls).toHaveLength(2)
  })
})

describe('Qoder 国际版驱动：粘性按账号与网络出口隔离', () => {
  it('切换账号后重新从 center 开始', async () => {
    const harness = makeHarness({ handler: failCenterConnection })

    await harness.driver.searchOnce(QUERY, 10, signal())
    expect(harness.calls.map(call => hostOf(call.url))).toEqual([CENTER, API2])

    harness.setHandler(defaultHandler)
    await harness.driver.searchOnce(QUERY, 10, signal())
    expect(harness.calls.map(call => hostOf(call.url))).toEqual([CENTER, API2, API2])

    harness.setAccount(ACCOUNT_B)
    await harness.driver.searchOnce(QUERY, 10, signal())
    expect(harness.calls.map(call => hostOf(call.url))).toEqual([CENTER, API2, API2, CENTER])
  })

  it('网络出口变化后重新从 center 开始', async () => {
    const harness = makeHarness({ handler: failCenterConnection })

    await harness.driver.searchOnce(QUERY, 10, signal())
    harness.setHandler(defaultHandler)
    await harness.driver.searchOnce(QUERY, 10, signal())
    expect(harness.calls.map(call => hostOf(call.url))).toEqual([CENTER, API2, API2])

    harness.setExitKey('exit-b')
    await harness.driver.searchOnce(QUERY, 10, signal())
    expect(harness.calls.map(call => hostOf(call.url))).toEqual([CENTER, API2, API2, CENTER])
  })

  it('新驱动实例（进程重启）回到 center', async () => {
    const first = makeHarness({ handler: failCenterConnection })
    await first.driver.searchOnce(QUERY, 10, signal())

    const restarted = makeHarness()
    await restarted.driver.searchOnce(QUERY, 10, signal())
    expect(restarted.calls.map(call => hostOf(call.url))).toEqual([CENTER])
  })
})

describe('Qoder 国际版驱动：并发与兄弟 query', () => {
  it('并发两个 query：成功的兄弟只请求一次', async () => {
    let centerAttempts = 0
    const { driver, calls } = makeHarness({
      handler: (url) => {
        if (hostOf(url) === CENTER) {
          centerAttempts += 1
          if (centerAttempts === 1) throw new TypeError('fetch failed')
        }
        return jsonResponse(DEFAULT_RESULT)
      },
    })

    const [first, second] = await Promise.all([
      driver.searchOnce('并发查询一', 10, signal()),
      driver.searchOnce('并发查询二', 10, signal()),
    ])

    expect(first.sources).toEqual([{ url: 'https://result.test/' }])
    expect(second.sources).toEqual([{ url: 'https://result.test/' }])
    expect(calls).toHaveLength(3)
    expect(calls.filter(call => hostOf(call.url) === CENTER)).toHaveLength(2)
    expect(calls.filter(call => hostOf(call.url) === API2)).toHaveLength(1)
  })

  it('每次尝试独立签名器，成功与失败后都 dispose', async () => {
    const prepareSpy = vi.spyOn(QoderSigner.prototype, 'prepare')
    const disposeSpy = vi.spyOn(QoderSigner.prototype, 'dispose')
    const { driver } = makeHarness({ handler: failCenterConnection })

    await driver.searchOnce(QUERY, 10, signal())

    expect(prepareSpy).toHaveBeenCalledTimes(2)
    expect(disposeSpy).toHaveBeenCalledTimes(2)
    for (const signer of prepareSpy.mock.contexts) {
      expect((signer as QoderSigner).isDisposed).toBe(true)
      expect((signer as QoderSigner).inflight).toBe(0)
    }
  })

  it('端点偏好每次调用解析一次，只影响新调用', async () => {
    const harness = makeHarness({ preference: 'center' })

    await harness.driver.searchOnce(QUERY, 10, signal())
    expect(harness.preferenceResolver).toHaveBeenCalledTimes(1)
    expect(harness.calls.map(call => hostOf(call.url))).toEqual([CENTER])

    harness.setPreference('api2')
    await harness.driver.searchOnce(QUERY, 10, signal())
    expect(harness.preferenceResolver).toHaveBeenCalledTimes(2)
    expect(harness.calls.map(call => hostOf(call.url))).toEqual([CENTER, API2])
  })
})

describe('Qoder 国际版驱动：观察记录与秘密卫生', () => {
  it('成功时观察记录只含域名、耗时与偏好，不含 query/凭据', async () => {
    const { driver, observations } = makeHarness()

    await driver.searchOnce(QUERY, 10, signal())

    expect(observations).toHaveLength(1)
    const observation = observations[0]!
    expect(observation).toMatchObject({ preference: 'auto', outcome: 'succeeded', host: CENTER })
    expect(observation.attempts).toHaveLength(1)
    expect(observation.attempts[0]!.durationMs).toBeGreaterThanOrEqual(0)

    const text = JSON.stringify(observation)
    expect(text).not.toContain(QUERY)
    for (const secret of SECRET_VALUES) expect(text).not.toContain(secret)
    expect(text).not.toContain(ACCOUNT_A.accountId)
    expect(text).not.toContain('COSY')
  })

  it('失败时观察记录逐域给出类别，且不含秘密', async () => {
    const { driver, observations } = makeHarness({
      handler: (url) => {
        if (hostOf(url) === CENTER) throw new TypeError('fetch failed')
        return new Response('denied', { status: 401 })
      },
    })

    await driver.searchOnce(QUERY, 10, signal()).catch(() => undefined)

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({ preference: 'auto', outcome: 'failed' })
    expect(observations[0]!.attempts.map(attempt => attempt.failure)).toEqual([
      'connection',
      'unauthorized',
    ])
    const text = JSON.stringify(observations)
    for (const secret of SECRET_VALUES) expect(text).not.toContain(secret)
  })
})
