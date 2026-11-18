import { describe, expect, it } from 'vitest'

import {
  runDshFixture,
  type FixtureDriver,
  type FixtureMode,
} from './dsh-runtime.fixture.ts'

const MODES: readonly FixtureMode[] = ['native', 'ptc']

function downstreamWithoutFallback(mode: FixtureMode): number {
  return mode === 'ptc' ? 1 : 0
}

describe.each(MODES)('%s 官方 web_search output 差分', (mode) => {
  it('多查询值被真实 schema 接受，并由官方 render/presentationMeta/presentResult 投影', async () => {
    const observation = await runDshFixture({
      mode,
      installOverride: true,
      enabled: true,
      driver: 'contract',
      arguments: { queries: ['alpha', 'beta'] },
      lifecycle: true,
    })

    expect(observation.source['@deepseek-ai/dsh-tool-web']).toBe('0.2.2-rc.3')
    expect(observation.officialSearchCalls).toBe(0)
    expect(observation.driverCalls).toEqual([
      { query: 'alpha', maxResults: 10 },
      { query: 'beta', maxResults: 10 },
    ])
    expect(observation.downstreamCalls).toBe(downstreamWithoutFallback(mode))
    expect(observation.lifecycleTracks).toBe(1)
    expect(observation.result).toEqual({
      isError: false,
      value: observation.expectedMockValue,
      content: observation.expectedMockContent,
      meta: observation.expectedMeta,
    })
    expect(observation.result?.value).toMatchObject({
      content: '### alpha\n\nAlpha answer\n\n### beta\n\nBeta answer',
      sources: [
        {
          url: 'https://contract.test/shared',
          title: 'Shared result',
          snippet: 'shared snippet',
          summary: `${'x'.repeat(799)}…`,
          publishedAt: '2026-11-18',
        },
        { url: 'https://contract.test/beta-1', title: 'Beta first' },
        { url: 'https://contract.test/alpha-2', snippet: 'alpha second' },
      ],
      truncated: false,
    })
    expect(observation.presentationResult).toEqual({
      card: 'web',
      kind: 'search',
      title: 'alpha, beta',
      sources: [
        {
          url: 'https://contract.test/shared',
          title: 'Shared result',
          snippet: 'shared snippet',
          publishedAt: '2026-11-18',
        },
        { url: 'https://contract.test/beta-1', title: 'Beta first' },
        { url: 'https://contract.test/alpha-2', snippet: 'alpha second' },
      ],
      truncated: false,
      answer: '### alpha\n\nAlpha answer\n\n### beta\n\nBeta answer',
    })
  })
})

describe.each(MODES)('%s ON 错误 fail-closed', (mode) => {
  it.each([
    {
      driver: 'missing',
      message: 'search override has no account or driver for channel "buddy"',
    },
    { driver: 'unauthorized', message: 'fixture credentials expired' },
    { driver: 'rate-limit', message: 'fixture rate limited' },
    { driver: 'bad-response', message: 'channel search driver returned an invalid response' },
    {
      driver: 'delay',
      message: 'tool call timed out after 10ms',
      timeoutMs: 10,
      info: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' },
    },
  ] satisfies readonly {
    driver: FixtureDriver
    message: string
    timeoutMs?: number
    info?: { name: string; code: string }
  }[])('$driver 不 next 到官方 Provider，宿主保留错误消息', async ({ driver, message, timeoutMs, info }) => {
    const observation = await runDshFixture({
      mode,
      installOverride: true,
      enabled: true,
      driver,
      timeoutMs,
    })

    expect(observation.officialSearchCalls).toBe(0)
    expect(observation.downstreamCalls).toBe(downstreamWithoutFallback(mode))
    expect(observation.result).toMatchObject({
      isError: true,
      error: { message, ...info === undefined ? {} : { info } },
    })
  })
})
