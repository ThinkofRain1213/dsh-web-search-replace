/**
 * Task 3 准入门禁：声明支持的两个 DeepSeek 代表模型在 Native 与 PTC 都必须
 * 经真实 ToolsService.resolve() 看到 web_search；任何缺失都属于产品组合阻断。
 */
import { describe, expect, it } from 'vitest'

import { runDshFixture, type DshFixtureObservation, type FixtureMode } from './dsh-runtime.fixture.ts'

const MODES: readonly FixtureMode[] = ['native', 'ptc']
const MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const

function expectCurrentHost(observation: DshFixtureObservation): void {
  expect(observation.source).toMatchObject({
    desktop: '0.2.2-rc.3',
    '@deepseek-ai/cordis': '4.1.0',
    '@deepseek-ai/dsh-web': '0.2.2-rc.3',
    '@deepseek-ai/dsh-tools': '0.2.2-rc.3',
    '@deepseek-ai/dsh-tool-web': '0.2.2-rc.3',
    '@deepseek-ai/dsh-tool-executor-native': '0.2.2-rc.3',
    '@deepseek-ai/dsh-tool-executor-ptc': '0.2.2-rc.3',
    '@deepseek-ai/dsh-tool-call-timeout-policy': '0.2.2-rc.3',
  })
}

describe.each(MODES)('%s 真实工具准入', (mode) => {
  it('两个代表模型都解析并声明 web_search，PTC SDK 也包含 binding', async () => {
    const observations = await Promise.all(MODELS.map(model => runDshFixture({ mode, model })))

    for (const [index, observation] of observations.entries()) {
      expectCurrentHost(observation)
      expect(observation.model).toBe(MODELS[index])
      expect(observation.admitted).toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
      expect(observation.nativeSchemas).toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
      expect(observation.readyProviders).toEqual(['deepseek-account'])
      if (mode === 'ptc') {
        expect(observation.ptcSchemas).toEqual(['run_code'])
        expect(observation.ptcSdkHasWebSearch).toBe(true)
      }
    }
  })

  it('安装拦截器前即使 ON 也仍执行一次官方 search spy', async () => {
    const observation = await runDshFixture({ mode, enabled: true, installOverride: false })

    expectCurrentHost(observation)
    expect(observation.officialSearchCalls).toBe(1)
    expect(observation.officialFetchCalls).toBe(0)
    expect(observation.driverCalls).toEqual([])
    expect(observation.result).toMatchObject({
      isError: false,
      value: { content: 'official answer: fixture query', truncated: false },
    })
    if (mode === 'ptc') expect(observation.transportResult).toMatchObject({ isError: false })
  })
})
