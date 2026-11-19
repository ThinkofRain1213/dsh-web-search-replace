/**
 * Task 2：SettingsService 的读取、写入、校验与失败回滚。
 *
 * 设置服务是普通配置的唯一写入口：写入必须经过 `configEditor.edit`，成功后
 * 重读 volatile 引用再发布快照；任何校验失败或写失败都不得发布新快照。
 * 账号存在性由 Task 8 的 account-aware service 校验，本任务只校验渠道与
 * 稳定小写 slug。
 */
import { describe, expect, it } from 'vitest'

import { Config, type SearchConfig } from '../../src/host/config.ts'
import { SettingsService, SettingsWriteCancelledError } from '../../src/host/settings/service.ts'
import { DEFAULT_SEARCH_SETTINGS } from '../../src/shared/contracts.ts'
import { createSettingsDouble } from './support/settings-double.ts'

/** 用默认替身创建服务。 */
function createService() {
  const double = createSettingsDouble()
  const service = new SettingsService({
    configEditor: double.editor,
    entry: { id: 'dsh-web-search-channels' },
    config: double.config,
  })
  return { service, double }
}

describe('SettingsService 初始快照', () => {
  it('真实 volatile Config 模式解析出默认开关与四个 null 当前账号', () => {
    const config = Config({}) as unknown as SearchConfig

    expect(config.search.enabled.get()).toBe(false)
    expect(config.search.channel.get()).toBe('buddy')
    expect(config.buddy.currentAccountId.get()).toBeNull()
    expect(config.workbuddy.currentAccountId.get()).toBeNull()
    expect(config.qoder.currentAccountId.get()).toBeNull()
    expect(config.qoder.endpointPreference.get()).toBe('auto')
    expect(config.qodercn.currentAccountId.get()).toBeNull()
  })

  it('默认关闭搜索、CodeBuddy，四个渠道均无当前账号', () => {
    const { service } = createService()
    expect(service.getSnapshot()).toEqual(DEFAULT_SEARCH_SETTINGS)
  })

  it('快照是冻结的普通对象，调用方不能改动服务内部状态', () => {
    const { service } = createService()
    const snapshot = service.getSnapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.search)).toBe(true)
    expect(Object.isFrozen(snapshot.buddy)).toBe(true)
    expect(Object.isFrozen(snapshot.workbuddy)).toBe(true)
    expect(Object.isFrozen(snapshot.qoder)).toBe(true)
    expect(Object.isFrozen(snapshot.qodercn)).toBe(true)
  })
})

describe('SettingsService.updateSearch', () => {
  it('把 enabled 与 channel 写入同一份普通配置并重读快照', async () => {
    const { service, double } = createService()

    const snapshot = await service.updateSearch({ enabled: true, channel: 'qoder' })

    expect(snapshot).toEqual({
      ...DEFAULT_SEARCH_SETTINGS,
      search: { enabled: true, channel: 'qoder' },
    })
    expect(service.getSnapshot()).toEqual(snapshot)
    expect(double.edits).toHaveLength(1)
    expect(double.getState()).toEqual({
      search: { enabled: true, channel: 'qoder' },
      buddy: { currentAccountId: null },
      workbuddy: { currentAccountId: null },
      qoder: { currentAccountId: null, endpointPreference: 'auto' },
      qodercn: { currentAccountId: null },
    })
  })

  it('只写 qoder.endpointPreference，不影响渠道与账号', async () => {
    const { service, double } = createService()

    const snapshot = await service.updateSearch({ endpointPreference: 'api2' })

    expect(snapshot.search).toEqual({ enabled: false, channel: 'buddy' })
    expect(snapshot.qoder).toEqual({ currentAccountId: null, endpointPreference: 'api2' })
    expect(snapshot.buddy.currentAccountId).toBeNull()
    expect(snapshot.workbuddy.currentAccountId).toBeNull()
    expect(snapshot.qodercn.currentAccountId).toBeNull()
    expect(double.getState().qoder.endpointPreference).toBe('api2')
  })

  it('保留未提交字段的已有值', async () => {
    const double = createSettingsDouble({
      search: { enabled: true, channel: 'workbuddy' },
      qoder: { currentAccountId: 'qoder-account', endpointPreference: 'center' },
    })
    const service = new SettingsService({
      configEditor: double.editor,
      entry: { id: 'dsh-web-search-channels' },
      config: double.config,
    })

    await service.updateSearch({ enabled: false })

    expect(double.getState()).toEqual({
      search: { enabled: false, channel: 'workbuddy' },
      buddy: { currentAccountId: null },
      workbuddy: { currentAccountId: null },
      qoder: { currentAccountId: 'qoder-account', endpointPreference: 'center' },
      qodercn: { currentAccountId: null },
    })
  })

  it('拒绝非法渠道且不写配置', async () => {
    const { service, double } = createService()
    const before = service.getSnapshot()

    await expect(service.updateSearch({ channel: 'deepseek' as never })).rejects.toThrow(/渠道|channel/i)

    expect(service.getSnapshot()).toEqual(before)
    expect(double.edits).toHaveLength(0)
  })

  it('拒绝非法端点偏好且不写配置', async () => {
    const { service, double } = createService()
    const before = service.getSnapshot()

    await expect(service.updateSearch({ endpointPreference: 'gateway' as never })).rejects.toThrow(/端点|endpoint/i)

    expect(service.getSnapshot()).toEqual(before)
    expect(double.edits).toHaveLength(0)
  })

  it('拒绝未知字段且不写配置', async () => {
    const { service, double } = createService()

    await expect(service.updateSearch({ fetch: true } as never)).rejects.toThrow(/字段|field|未知|unknown/i)

    expect(double.edits).toHaveLength(0)
  })

  it('写失败时保留旧快照并向上抛出', async () => {
    const { service, double } = createService()
    const before = service.getSnapshot()
    double.failNextWrite('profile is read-only')

    await expect(service.updateSearch({ enabled: true })).rejects.toThrow('profile is read-only')

    expect(service.getSnapshot()).toBe(before)
    expect(service.getSnapshot()).toEqual(DEFAULT_SEARCH_SETTINGS)
    expect(double.getState().search.enabled).toBe(false)
  })
})

describe('SettingsService.setCurrentAccount', () => {
  it('写入指定渠道的稳定账号 slug，其他渠道保持 null', async () => {
    const { service, double } = createService()

    const snapshot = await service.setCurrentAccount('buddy', 'account-1')

    expect(snapshot.buddy.currentAccountId).toBe('account-1')
    expect(snapshot.workbuddy.currentAccountId).toBeNull()
    expect(snapshot.qoder.currentAccountId).toBeNull()
    expect(snapshot.qodercn.currentAccountId).toBeNull()
    expect(double.getState().buddy.currentAccountId).toBe('account-1')
  })

  it('接受 null 清除当前账号', async () => {
    const double = createSettingsDouble({
      buddy: { currentAccountId: 'account-1' },
    })
    const service = new SettingsService({
      configEditor: double.editor,
      entry: { id: 'dsh-web-search-channels' },
      config: double.config,
    })

    const snapshot = await service.setCurrentAccount('buddy', null)

    expect(snapshot.buddy.currentAccountId).toBeNull()
    expect(double.getState().buddy.currentAccountId).toBeNull()
  })

  it('拒绝非法渠道且不写配置', async () => {
    const { service, double } = createService()

    await expect(service.setCurrentAccount('deepseek' as never, 'account-1')).rejects.toThrow(/渠道|channel/i)

    expect(double.edits).toHaveLength(0)
  })

  it('拒绝大写、下划线、空格、数字开头与空串 slug', async () => {
    const { service, double } = createService()

    for (const accountId of ['', 'Account-1', 'account_1', '1account', '-account', 'account 1']) {
      await expect(service.setCurrentAccount('buddy', accountId)).rejects.toThrow(/slug|账号|account/i)
    }

    expect(double.edits).toHaveLength(0)
    expect(service.getSnapshot().buddy.currentAccountId).toBeNull()
  })

  it('跨渠道隔离：写 buddy 不影响 qoder 的当前账号与端点偏好', async () => {
    const double = createSettingsDouble({
      qoder: { currentAccountId: 'qoder-account', endpointPreference: 'center' },
    })
    const service = new SettingsService({
      configEditor: double.editor,
      entry: { id: 'dsh-web-search-channels' },
      config: double.config,
    })

    await service.setCurrentAccount('buddy', 'buddy-account')

    expect(service.getSnapshot().buddy.currentAccountId).toBe('buddy-account')
    expect(service.getSnapshot().qoder).toEqual({
      currentAccountId: 'qoder-account',
      endpointPreference: 'center',
    })
    expect(service.getSnapshot().workbuddy.currentAccountId).toBeNull()
    expect(service.getSnapshot().qodercn.currentAccountId).toBeNull()
  })

  it('写失败时保留旧快照并向上抛出', async () => {
    const double = createSettingsDouble({
      buddy: { currentAccountId: 'old-account' },
    })
    const service = new SettingsService({
      configEditor: double.editor,
      entry: { id: 'dsh-web-search-channels' },
      config: double.config,
    })
    double.failNextWrite('profile is locked')

    await expect(service.setCurrentAccount('buddy', 'new-account')).rejects.toThrow('profile is locked')

    expect(service.getSnapshot().buddy.currentAccountId).toBe('old-account')
    expect(double.getState().buddy.currentAccountId).toBe('old-account')
  })

  it('已取消的信号在 configEditor 提交前拒绝写入', async () => {
    const { service, double } = createService()
    const controller = new AbortController()
    controller.abort()

    await expect(service.setCurrentAccount('buddy', 'new-account', controller.signal))
      .rejects.toBeInstanceOf(SettingsWriteCancelledError)
    expect(service.getSnapshot().buddy.currentAccountId).toBeNull()
    expect(double.edits).toHaveLength(0)
  })

  it('取消落在 configEditor 提交回调内时不写当前账号', async () => {
    const { service, double } = createService()
    const controller = new AbortController()
    const originalEdit = double.editor.edit.bind(double.editor)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    double.editor.edit = async (entry, change) => {
      await gate
      return await originalEdit(entry, change)
    }

    const writing = service.setCurrentAccount('buddy', 'new-account', controller.signal)
      .catch((error: unknown) => error)
    controller.abort()
    release()

    expect(await writing).toBeInstanceOf(SettingsWriteCancelledError)
    expect(service.getSnapshot().buddy.currentAccountId).toBeNull()
    expect(double.edits).toHaveLength(0)
  })
})
