import { describe, expect, it, vi } from 'vitest'

import type { ChannelId } from '../../src/shared/channels.ts'
import type {
  SearchDriver,
  SearchDriverResult,
} from '../../src/host/drivers/mock-driver.ts'
import { ChannelSearchError } from '../../src/host/search/errors.ts'
import {
  executeSearchQueries,
  SEARCH_DEFAULT_PROFILE,
} from '../../src/host/search/executor.ts'

const EMPTY_RESULT: SearchDriverResult = { sources: [], truncated: false }

interface DriverCall {
  readonly query: string
  readonly maxResults: number
  readonly signal: AbortSignal
}

function recordingDriver(
  run: (query: string, signal: AbortSignal) => Promise<SearchDriverResult> | SearchDriverResult,
): { readonly driver: SearchDriver; readonly calls: DriverCall[] } {
  const calls: DriverCall[] = []
  return {
    calls,
    driver: {
      async searchOnce(query, maxResults, signal) {
        calls.push({ query, maxResults, signal })
        return run(query, signal)
      },
    },
  }
}

function executeWith(
  args: unknown,
  driver: SearchDriver | undefined,
  channel: ChannelId = 'buddy',
): Promise<unknown> {
  return executeSearchQueries(args, {
    channel,
    driver,
    profile: SEARCH_DEFAULT_PROFILE,
  }, new AbortController().signal)
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('SearchExecutor 参数与账号边界', () => {
  it('使用官方默认 10 queries、10 sources、800 摘要字符上限', () => {
    expect(SEARCH_DEFAULT_PROFILE).toEqual({
      maxQueries: 10,
      maxResults: 10,
      summaryMaxChars: 800,
    })
  })

  it.each([
    { label: '非对象参数', args: null },
    { label: 'queries 非数组', args: { queries: 'alpha' } },
    { label: '空数组', args: { queries: [] } },
    { label: '11 项即使全部重复也拒绝', args: { queries: Array(11).fill('alpha') } },
    { label: '空白项', args: { queries: ['alpha', ' \n\t'] } },
    { label: '非字符串项', args: { queries: ['alpha', 1] } },
  ])('$label 在任何账号或驱动工作前失败', async ({ args }) => {
    let accountReads = 0
    const options = {
      channel: 'buddy' as const,
      profile: SEARCH_DEFAULT_PROFILE,
      get driver(): SearchDriver | undefined {
        accountReads++
        throw new Error('参数合法前不得解析账号或驱动')
      },
    }

    await expect(executeSearchQueries(args, options, new AbortController().signal))
      .rejects.toMatchObject({ name: 'ChannelSearchError', code: 'INVALID_ARGUMENTS' })
    expect(accountReads).toBe(0)
  })

  it('沿用官方空数组、数量上限与空白查询错误文本', async () => {
    const { driver, calls } = recordingDriver(() => EMPTY_RESULT)
    await expect(executeWith({ queries: [] }, driver))
      .rejects.toThrow('queries must contain at least one query')
    await expect(executeWith({ queries: Array.from({ length: 11 }, (_, i) => `q${i}`) }, driver))
      .rejects.toThrow('queries must contain at most 10 queries')
    await expect(executeWith({ queries: ['  '] }, driver))
      .rejects.toThrow('each query must be a non-empty string')
    expect(calls).toEqual([])
  })

  it('没有所选渠道账号或驱动时返回结构化 NO_ACCOUNT', async () => {
    const error = await executeWith({ queries: ['alpha'] }, undefined, 'qoder').catch(value => value)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({
      name: 'ChannelSearchError',
      code: 'NO_ACCOUNT',
      channel: 'qoder',
    })
  })
})

describe('SearchExecutor 并发与取消', () => {
  it('精确字符串去重但不 trim，每个去重 query 以 maxResults=10 调用一次', async () => {
    const { driver, calls } = recordingDriver(() => EMPTY_RESULT)
    await executeWith({ queries: [' alpha ', 'alpha', ' alpha ', 'alpha'] }, driver)

    expect(calls.map(call => ({ query: call.query, maxResults: call.maxResults }))).toEqual([
      { query: ' alpha ', maxResults: 10 },
      { query: 'alpha', maxResults: 10 },
    ])
    expect(calls.every(call => !call.signal.aborted)).toBe(true)
  })

  it('在其他 query 尚未完成时并发启动全部去重搜索', async () => {
    const first = deferred<SearchDriverResult>()
    const second = deferred<SearchDriverResult>()
    const { driver, calls } = recordingDriver(query => query === 'alpha' ? first.promise : second.promise)

    const operation = executeWith({ queries: ['alpha', 'beta'] }, driver)
    await vi.waitFor(() => expect(calls.map(call => call.query)).toEqual(['alpha', 'beta']))
    first.resolve(EMPTY_RESULT)
    second.resolve(EMPTY_RESULT)
    await expect(operation).resolves.toEqual({ sources: [], truncated: false })
  })

  it('记录首错、取消兄弟并等待全部 settle 后才抛出', async () => {
    const sibling = deferred<SearchDriverResult>()
    let siblingSignal: AbortSignal | undefined
    let siblingSettled = false
    const { driver } = recordingDriver((query, signal) => {
      if (query === 'bad') {
        return Promise.reject(Object.assign(new Error('credentials expired'), { status: 401 }))
      }
      siblingSignal = signal
      return sibling.promise.finally(() => { siblingSettled = true })
    })

    const operation = executeWith({ queries: ['bad', 'slow'] }, driver)
    let operationSettled = false
    const observed = operation.then(
      () => ({ error: undefined }),
      error => ({ error }),
    )
    void observed.then(() => { operationSettled = true })

    await vi.waitFor(() => expect(siblingSignal?.aborted).toBe(true))
    await Promise.resolve()
    expect(operationSettled).toBe(false)
    expect(siblingSettled).toBe(false)

    sibling.resolve(EMPTY_RESULT)
    const { error } = await observed
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code: 'UNAUTHORIZED', message: 'credentials expired' })
    expect(siblingSettled).toBe(true)
  })
})

describe('SearchExecutor 官方合并与输出值', () => {
  it('按原 query 顺序做 rank 轮转、按 URL 去重并保留多段 answer', async () => {
    const { driver } = recordingDriver(async query => ({
      content: query === 'alpha' ? 'Alpha answer' : 'Beta answer',
      sources: query === 'alpha'
        ? [
            { url: 'https://example.test/shared', title: 'Shared', summary: 'shared summary' },
            { url: 'https://example.test/alpha-2', snippet: 'alpha two', publishedAt: '2026-01-02' },
          ]
        : [
            { url: 'https://example.test/beta-1', title: 'Beta one' },
            { url: 'https://example.test/shared', title: 'duplicate must not replace first' },
          ],
      truncated: false,
    }))

    await expect(executeWith({ queries: ['alpha', 'beta'] }, driver)).resolves.toEqual({
      content: '### alpha\n\nAlpha answer\n\n### beta\n\nBeta answer',
      sources: [
        { url: 'https://example.test/shared', title: 'Shared', summary: 'shared summary' },
        { url: 'https://example.test/beta-1', title: 'Beta one' },
        { url: 'https://example.test/alpha-2', snippet: 'alpha two', publishedAt: '2026-01-02' },
      ],
      truncated: false,
    })
  })

  it('合并结果最多保留 10 个新 URL，只有实际丢弃时标记 truncated', async () => {
    const { driver } = recordingDriver(query => ({
      sources: Array.from({ length: 6 }, (_, rank) => ({
        url: `https://example.test/${query}/${rank}`,
      })),
      truncated: false,
    }))

    const value = await executeWith({ queries: ['a', 'b'] }, driver) as SearchDriverResult
    expect(value.sources.map(source => source.url)).toEqual([
      'https://example.test/a/0', 'https://example.test/b/0',
      'https://example.test/a/1', 'https://example.test/b/1',
      'https://example.test/a/2', 'https://example.test/b/2',
      'https://example.test/a/3', 'https://example.test/b/3',
      'https://example.test/a/4', 'https://example.test/b/4',
    ])
    expect(value.truncated).toBe(true)
  })

  it('折叠摘要空白、按 800 字符截断并保留 publishedAt，不伪造 content', async () => {
    const { driver } = recordingDriver(() => ({
      sources: [{
        url: 'https://example.test/long',
        title: 'Long',
        snippet: 'original snippet',
        summary: `  ${'x'.repeat(801)}  `,
        publishedAt: '2026-11-18',
      }],
      truncated: false,
    }))

    const value = await executeWith({ queries: ['alpha'] }, driver) as SearchDriverResult
    expect(value).toEqual({
      sources: [{
        url: 'https://example.test/long',
        title: 'Long',
        snippet: 'original snippet',
        summary: `${'x'.repeat(799)}…`,
        publishedAt: '2026-11-18',
      }],
      truncated: false,
    })
    expect(value.sources[0]?.summary).toHaveLength(800)
    expect(Object.hasOwn(value, 'content')).toBe(false)
  })

  it.each([
    { label: '缺少 sources', value: { truncated: false } },
    { label: '缺少 URL', value: { sources: [{ title: 'broken' }], truncated: false } },
    { label: 'truncated 非布尔', value: { sources: [], truncated: 'no' } },
    { label: '摘要非字符串', value: { sources: [{ url: 'https://example.test', summary: 1 }], truncated: false } },
  ])('bad response：$label 不进入官方 output', async ({ value }) => {
    const { driver } = recordingDriver(() => value as unknown as SearchDriverResult)
    await expect(executeWith({ queries: ['alpha'] }, driver))
      .rejects.toMatchObject({ name: 'ChannelSearchError', code: 'BAD_RESPONSE' })
  })
})

describe('ChannelSearchError 结构化映射', () => {
  it.each([
    {
      label: '401', code: 'UNAUTHORIZED',
      failure: Object.assign(new Error('unauthorized'), { status: 401 }),
    },
    {
      label: '429', code: 'RATE_LIMITED',
      failure: Object.assign(new Error('too many requests'), { statusCode: 429 }),
    },
    {
      label: '超时', code: 'TIMEOUT',
      failure: Object.assign(new Error('tool call timed out'), { code: 'TOOL_TIMEOUT' }),
    },
  ])('$label 保留首错消息并映射为 $code', async ({ code, failure }) => {
    const { driver } = recordingDriver(() => Promise.reject(failure))
    const error = await executeWith({ queries: ['alpha'] }, driver, 'workbuddy').catch(value => value)
    expect(error).toBeInstanceOf(ChannelSearchError)
    expect(error).toMatchObject({ code, channel: 'workbuddy', message: failure.message })
    expect((error as Error).cause).toBe(failure)
  })

  it('未知驱动错误结构化抛出且不回退', async () => {
    const failure = new Error('driver exploded')
    const { driver, calls } = recordingDriver(() => Promise.reject(failure))
    const error = await executeWith({ queries: ['alpha'] }, driver).catch(value => value)
    expect(error).toMatchObject({ code: 'SEARCH_FAILED', message: 'driver exploded' })
    expect((error as Error).cause).toBe(failure)
    expect(calls).toHaveLength(1)
  })
})
