/**
 * 账号域测试夹具：内存 credentials + 真实 SettingsService + 账号库/服务。
 *
 * 设置写入仍走真实 `configEditor.edit` 语义的测试替身，因此「写失败保留旧
 * 快照」与 volatile 重读行为都是真实被测路径，而不是账号服务内部的假实现。
 */
import { AccountService } from '../../../src/host/accounts/service.ts'
import { AccountStore } from '../../../src/host/accounts/store.ts'
import { SettingsService } from '../../../src/host/settings/service.ts'
import { createSettingsDouble, type SettingsState } from './settings-double.ts'
import { MemoryCredentials } from './memory-credentials.ts'

/** 账号域夹具。 */
export interface AccountFixture {
  readonly credentials: MemoryCredentials
  readonly store: AccountStore
  readonly settingsDouble: ReturnType<typeof createSettingsDouble>
  readonly settings: SettingsService
  readonly service: AccountService
}

/** 创建一套完全隔离的账号域。 */
export function createAccountFixture(initial?: Partial<SettingsState>): AccountFixture {
  const credentials = new MemoryCredentials()
  const store = new AccountStore({ credentials })
  const settingsDouble = createSettingsDouble(initial)
  const settings = new SettingsService({
    configEditor: settingsDouble.editor,
    entry: { id: 'dsh-web-search-channels' } as never,
    config: settingsDouble.config,
  })
  const service = new AccountService({ store, settings })
  return { credentials, store, settingsDouble, settings, service }
}
