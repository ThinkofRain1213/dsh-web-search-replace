/** B9：无 env 时必须固定 rc.3，不能自动采用 installed version。 */
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('DSH_TEST_EXPECTED_VERSION anchor', () => {
  it('无 env 默认仍是 0.2.2-rc.3，而非当前安装版', async () => {
    vi.stubEnv('DSH_TEST_EXPECTED_VERSION', undefined)
    vi.resetModules()
    const fixture = await import('../integration/dsh-runtime.fixture.ts')
    expect(fixture.DSH_TEST_EXPECTED_VERSION).toBe('0.2.2-rc.3')
    expect(fixture.DSH_TEST_EXPECTED_VERSION).not.toBe('0.2.2-rc.5')
  })

  it('只有显式 env 才切换兼容验证版本', async () => {
    vi.stubEnv('DSH_TEST_EXPECTED_VERSION', '0.2.2-rc.5')
    vi.resetModules()
    const fixture = await import('../integration/dsh-runtime.fixture.ts')
    expect(fixture.DSH_TEST_EXPECTED_VERSION).toBe('0.2.2-rc.5')
  })
})
