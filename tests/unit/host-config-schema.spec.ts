/**
 * task-11 修复轮 2：真实 Host/Client Settings schema 反序列化回归。
 *
 * 独立真实实例证据：Client 服务注入修复后，设置卡仍停在 loading；
 * `ConfigFormController.decode()` 里 `schema.validate(...)` 返回
 * “callback is not a function”。Host `settings.describe` 的值正常。
 *
 * 根因不在测试替身，而在真实 schema 的序列化闭环：`Schema.transform` 节点经过
 * Host `volatileForm` 的 `new Schema(schema.toJSON())` 重建后，callback 变成
 * 新函数（不带 `toJSON`），再次 `form.toJSON()` 时被 JSON 丢弃，客户端
 * 反序列化得到没有 callback 的 transform 节点。
 *
 * 这里用真实 `@deepseek-ai/schemastery` 与真实 `src/host/config.ts` 的
 * Config，按 rc.5 Host `settings.describe` 的投影与线格式（见
 * `tests/unit/support/host-settings-schema.ts`）复现该闭环，不使用手写
 * plain object 假 schema。
 */
import { describe, expect, it } from 'vitest'

import { Config, type SearchConfig } from '../../src/host/config.ts'
import { SettingsService } from '../../src/host/settings/service.ts'
import { DEFAULT_SEARCH_SETTINGS } from '../../src/shared/contracts.ts'
import { clientSchemaFailure, hostDescribedForm, schemaNodeTypes } from './support/host-settings-schema.ts'
import { createSettingsDouble } from './support/settings-double.ts'

describe('Host 设置 schema 反序列化（真实 Config + Schemastery）', () => {
  it('settings.describe 的 schema 信封在客户端仍可校验，且不携带 transform 节点', () => {
    const described = hostDescribedForm(Config)
    const value = described.project(Config({}))

    // 对应客户端 `SettingsSchemaService.rehydrate()` + `validate()`：
    // 失败时 ConfigFormController.decode 会把整个表单判为不可用。
    expect(clientSchemaFailure(described.wire, value)).toBeUndefined()
    expect(schemaNodeTypes(described.wire)).not.toContain('transform')
  })

  it('显式开关、渠道与账号值同样通过反序列化校验', () => {
    const described = hostDescribedForm(Config)
    const value = described.project(Config({
      search: { enabled: true, channel: 'qoder' },
      buddy: { currentAccountId: 'account-1' },
      workbuddy: { currentAccountId: null },
      qoder: { currentAccountId: 'qoder-account', endpointPreference: 'center' },
      qodercn: { currentAccountId: 'account-2' },
    }))

    expect(clientSchemaFailure(described.wire, value)).toBeUndefined()
    expect(value).toMatchObject({
      search: { enabled: true, channel: 'qoder' },
      buddy: { currentAccountId: 'account-1' },
      qoder: { currentAccountId: 'qoder-account', endpointPreference: 'center' },
    })
  })

  it('真实 Config 的缺省账号由 SettingsService 快照归一化为 null', () => {
    const config = Config({}) as unknown as SearchConfig
    const double = createSettingsDouble()
    const service = new SettingsService({
      configEditor: double.editor,
      entry: { id: 'dsh-web-search-replace' } as never,
      config,
    })

    expect(service.getSnapshot()).toEqual(DEFAULT_SEARCH_SETTINGS)
    expect(service.getSnapshot().buddy.currentAccountId).toBeNull()
    expect(service.getSnapshot().workbuddy.currentAccountId).toBeNull()
    expect(service.getSnapshot().qoder.currentAccountId).toBeNull()
    expect(service.getSnapshot().qodercn.currentAccountId).toBeNull()
  })
})