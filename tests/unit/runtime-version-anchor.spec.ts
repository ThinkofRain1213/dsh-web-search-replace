/** B9：无 env 时必须以 rc.5 为默认锚点，不能自动采用 installed version。 */
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('DSH_TEST_EXPECTED_VERSION anchor', () => {
  it('无 env 默认仍是 0.2.2-rc.5，而非旧 rc.3 或当前安装版', async () => {
    vi.stubEnv('DSH_TEST_EXPECTED_VERSION', undefined)
    vi.resetModules()
    const fixture = await import('../integration/dsh-runtime.fixture.ts')
    expect(fixture.DSH_TEST_EXPECTED_VERSION).toBe('0.2.2-rc.5')
    expect(fixture.DSH_TEST_EXPECTED_VERSION).not.toBe('0.2.2-rc.3')
  })

  it('显式 env 仍可覆盖为其他兼容验证版本', async () => {
    vi.stubEnv('DSH_TEST_EXPECTED_VERSION', '0.2.2-rc.3')
    vi.resetModules()
    const fixture = await import('../integration/dsh-runtime.fixture.ts')
    expect(fixture.DSH_TEST_EXPECTED_VERSION).toBe('0.2.2-rc.3')
  })
})
