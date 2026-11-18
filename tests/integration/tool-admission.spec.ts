/**
 * Task 3 准入门禁：声明支持的两个 DeepSeek 代表模型在 Native 与 PTC 都必须
 * 经真实 ToolsService.resolve() 看到 web_search；任何缺失都属于产品组合阻断。
 */
import { describe, expect, it } from 'vitest'

import {
  runDshFixture,
  type DshFixtureObservation,
  type FixtureMode,
} from './dsh-runtime.fixture.ts'

const MODES: readonly FixtureMode[] = ['native', 'ptc']
const MAGPIE_MODEL_ROUTES = [
  {
    provider: 'magpie',
    model: 'wps-lingxi-desktop/kimi-k3.1-pro',
    route: 'magpie/wps-lingxi-desktop/kimi-k3.1-pro',
  },
  {
    provider: 'magpie',
    model: 'wps-lingxi-desktop/deepseek-v4.1-flash',
    route: 'magpie/wps-lingxi-desktop/deepseek-v4.1-flash',
  },
] as const

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
  it('Magpie/WPS 灵犀 Kimi-K3.1 Pro 与 DeepSeek-V4.1-Flash 都按真实 route 准入', async () => {
    const observations = await Promise.all(MAGPIE_MODEL_ROUTES.map(route => runDshFixture({
      mode,
      modelSelection: { provider: route.provider, model: route.model },
    })))

    for (const [index, observation] of observations.entries()) {
      const expected = MAGPIE_MODEL_ROUTES[index]!
      expectCurrentHost(observation)
      expect(observation.provider).toBe(expected.provider)
      expect(observation.model).toBe(expected.model)
      expect(observation.route).toBe(expected.route)
      expect(observation.admitted).toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
      expect(observation.nativeSchemas).toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
      expect(observation.readyProviders).toEqual([expected.provider])
      if (mode === 'ptc') {
        expect(observation.ptcSchemas).toEqual(['run_code'])
        expect(observation.ptcSdkHasWebSearch).toBe(true)
      }
    }
  })

  it('安装拦截器前即使 ON 也仍执行一次官方 search spy', async () => {
    const observation = await runDshFixture({ mode, enabled: true, installOverride: false })

    expectCurrentHost(observation)
    expect(observation.route).toBe(MAGPIE_MODEL_ROUTES[0].route)
    expect(observation.readyProviders).toEqual(['magpie'])
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
