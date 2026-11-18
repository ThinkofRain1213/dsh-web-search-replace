/**
 * Task 3 短路 Spike：监听器只接管 web_search；ON 的 {value} 必须由真实共享
 * pipeline 用 tool-web 官方 output schema/render 归一化，错误与 timeout 均不得
 * 落回官方 Provider。每个断言都针对可观察结果或真实外部边界次数。
 */
import { describe, expect, it } from 'vitest'

import { runDshFixture, type DshFixtureObservation, type FixtureMode } from './dsh-runtime.fixture.ts'

const MODES: readonly FixtureMode[] = ['native', 'ptc']
const MAGPIE_KIMI_ROUTE = 'magpie/wps-lingxi-desktop/kimi-k3.1-pro'
const DEEPSEEK_OFF_CONTROL = {
  provider: 'deepseek-account',
  model: 'deepseek-flash',
} as const

function expectMagpieKimiRoute(observation: DshFixtureObservation): void {
  expect(observation.provider).toBe('magpie')
  expect(observation.model).toBe('wps-lingxi-desktop/kimi-k3.1-pro')
  expect(observation.route).toBe(MAGPIE_KIMI_ROUTE)
  expect(observation.readyProviders).toEqual(['magpie'])
}

function delegatedCalls(mode: FixtureMode, nestedDelegated: boolean): number {
  if (mode === 'native') return nestedDelegated ? 1 : 0
  return nestedDelegated ? 2 : 1
}

describe.each(MODES)('%s tools/execute override', (mode) => {
  it('OFF 在读取 mock 账号或驱动之前 next，官方 spy 恰好一次', async () => {
    const observation = await runDshFixture({
      mode,
      enabled: false,
      installOverride: true,
      driver: 'missing',
      modelSelection: DEEPSEEK_OFF_CONTROL,
    })

    expect(observation.route).toBe('deepseek-account/deepseek-flash')
    expect(observation.officialSearchCalls).toBe(1)
    expect(observation.driverCalls).toEqual([])
    expect(observation.downstreamCalls).toBe(delegatedCalls(mode, true))
    expect(observation.result).toMatchObject({
      isError: false,
      value: { content: 'official answer: fixture query' },
    })
    expect(observation.providersConfig).toEqual({
      searchProvider: 'official-search',
      fetchProvider: 'official-fetch',
    })
  })

  it('ON 调用所选 mock 并以 {value} 经过官方 schema、render 与 meta', async () => {
    const observation = await runDshFixture({
      mode,
      enabled: true,
      channel: 'qoder',
      installOverride: true,
      lifecycle: true,
    })

    expectMagpieKimiRoute(observation)
    expect(observation.officialSearchCalls).toBe(0)
    expect(observation.driverCalls).toEqual([{ query: 'fixture query', maxResults: 10 }])
    expect(observation.downstreamCalls).toBe(delegatedCalls(mode, false))
    expect(observation.lifecycleTracks).toBe(1)
    expect(observation.events).toContain('lifecycle:signal:true')
    expect(observation.result?.value).toMatchObject({
      content: 'Mock answer for fixture query',
      sources: [{
        url: 'https://mock.search.test/result?q=fixture%20query',
        title: 'Mock result for fixture query',
      }],
      truncated: false,
    })
    expect(observation.result).toMatchObject({
      isError: false,
      value: observation.expectedMockValue,
      content: observation.expectedMockContent,
      meta: { truncated: false },
    })
    expect(observation.transportResult).toMatchObject({ isError: false })
    expect(observation.providersConfig).toEqual({
      searchProvider: 'official-search',
      fetchProvider: 'official-fetch',
    })
  })

  it('ON 的 web_fetch 始终 next，不调用 mock search', async () => {
    const observation = await runDshFixture({
      mode,
      enabled: true,
      installOverride: true,
      tool: 'web_fetch',
    })

    expect(observation.officialFetchCalls).toBe(1)
    expectMagpieKimiRoute(observation)
    expect(observation.officialSearchCalls).toBe(0)
    expect(observation.driverCalls).toEqual([])
    expect(observation.downstreamCalls).toBe(delegatedCalls(mode, true))
    expect(observation.result).toMatchObject({
      isError: false,
      value: {
        url: 'https://official.example/fixture',
        statusCode: 200,
        body: { kind: 'text', content: 'official fetch body' },
      },
    })
  })

  it('ON 无账号或所选驱动时形成错误结果，绝不 next 到官方', async () => {
    const observation = await runDshFixture({
      mode,
      enabled: true,
      channel: 'workbuddy',
      installOverride: true,
      driver: 'missing',
    })

    expectMagpieKimiRoute(observation)
    expect(observation.officialSearchCalls).toBe(0)
    expect(observation.driverCalls).toEqual([])
    expect(observation.downstreamCalls).toBe(delegatedCalls(mode, false))
    expect(observation.result).toMatchObject({ isError: true })
    expect(observation.result?.error).toMatchObject({
      message: expect.stringMatching(/workbuddy.*driver|driver.*workbuddy/i),
    })
  })

  it('ON 的非法 mock 参数在驱动和官方网络之前失败', async () => {
    const observation = await runDshFixture({
      mode,
      enabled: true,
      installOverride: true,
      arguments: { queries: ['   '] },
    })

    expectMagpieKimiRoute(observation)
    expect(observation.officialSearchCalls).toBe(0)
    expect(observation.driverCalls).toEqual([])
    expect(observation.downstreamCalls).toBe(delegatedCalls(mode, false))
    expect(observation.result).toMatchObject({ isError: true })
    expect(observation.result?.error).toMatchObject({
      message: expect.stringMatching(/quer/i),
    })
  })

  it('ON 的驱动错误不 next，也不改走官方 Provider', async () => {
    const observation = await runDshFixture({
      mode,
      enabled: true,
      installOverride: true,
      driver: 'throw',
    })

    expectMagpieKimiRoute(observation)
    expect(observation.officialSearchCalls).toBe(0)
    expect(observation.driverCalls).toEqual([{ query: 'fixture query', maxResults: 10 }])
    expect(observation.downstreamCalls).toBe(delegatedCalls(mode, false))
    expect(observation.result).toMatchObject({
      isError: true,
      error: { message: 'mock driver exploded' },
    })
  })

  it('timeout 先包裹 override，派生 signal 到达驱动且归因为 TOOL_TIMEOUT', async () => {
    const observation = await runDshFixture({
      mode,
      enabled: true,
      installOverride: true,
      driver: 'delay',
      timeoutMs: 10,
    })

    expectMagpieKimiRoute(observation)
    expect(observation.officialSearchCalls).toBe(0)
    expect(observation.driverCalls).toEqual([{ query: 'fixture query', maxResults: 10 }])
    expect(observation.downstreamCalls).toBe(delegatedCalls(mode, false))
    expect(observation.result).toMatchObject({
      isError: true,
      error: {
        message: 'tool call timed out after 10ms',
        info: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' },
      },
    })
    const nestedDriverStart = observation.events.lastIndexOf('driver:start')
    expect(observation.events.slice(nestedDriverStart - 2, nestedDriverStart + 5)).toEqual([
      'timeout-outer:enter',
      'timeout-inner:enter',
      'driver:start',
      'driver:abort:true',
      'driver:end',
      'timeout-inner:exit:aborted:true',
      'timeout-outer:exit:restored:true',
    ])
  })
})
