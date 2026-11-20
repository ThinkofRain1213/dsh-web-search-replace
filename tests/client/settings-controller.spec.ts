/**
 * Task 13 设置控制器：读取 configForms 快照、经 Task 2 settings RPC 写入、
 * 成功后才切换配置视图，失败保持旧值并锁住在飞写入。
 */
import { describe, expect, it } from 'vitest'

import { SettingsController } from '../../src/client/controllers/settings.ts'
import {
  createConfigFormsDouble,
  createConnectionDouble,
  deferred,
  makeSnapshot,
} from './support/settings-harness.ts'

const PACKAGE_NAME = 'dsh-web-search-channels'
const failure = {
  ok: false as const,
  error: { code: 'settings/internal', message: 'settings operation failed', details: {} },
}

describe('SettingsController', () => {
  it('通过 configForms.get(包名) 读取并订阅唯一设置快照', () => {
    const snapshot = makeSnapshot({ enabled: true, channel: 'qoder' })
    const { configForms, form, getCalls } = createConfigFormsDouble(snapshot)
    const { connection } = createConnectionDouble(() => ({ ok: true, value: snapshot }))
    const controller = new SettingsController({ configForms, connection })

    expect(getCalls).toEqual([PACKAGE_NAME])
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      enabled: true,
      channel: 'qoder',
      viewChannel: 'qoder',
      busy: false,
      writable: true,
      error: null,
    })

    let notifications = 0
    const unsubscribe = controller.subscribe(() => { notifications += 1 })
    form.push({ value: makeSnapshot({ enabled: false, channel: 'workbuddy' }) })
    expect(notifications).toBe(1)
    expect(controller.getSnapshot()).toMatchObject({
      enabled: false,
      channel: 'workbuddy',
      viewChannel: 'workbuddy',
    })

    unsubscribe()
    form.push({ value: makeSnapshot({ enabled: true, channel: 'buddy' }) })
    expect(notifications).toBe(1)
    controller.dispose()
  })

  it('渠道写入成功后才以 Host 返回快照原子切换下拉值与 viewChannel', async () => {
    const before = makeSnapshot({ enabled: true, channel: 'buddy' })
    const after = makeSnapshot({ enabled: true, channel: 'qoder' })
    const { configForms } = createConfigFormsDouble(before)
    const response = deferred<{ ok: true; value: typeof after }>()
    const { connection, calls } = createConnectionDouble(() => response.promise)
    const controller = new SettingsController({ configForms, connection })

    const pending = controller.selectChannel('qoder')
    expect(controller.getSnapshot()).toMatchObject({
      enabled: true,
      channel: 'buddy',
      viewChannel: 'buddy',
      busy: true,
      error: null,
    })

    response.resolve({ ok: true, value: after })
    await pending

    expect(calls).toEqual([{
      method: 'settings.update',
      payload: { patch: { channel: 'qoder' } },
    }])
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      channel: 'qoder',
      viewChannel: 'qoder',
      busy: false,
      error: null,
    })
    expect(controller.getSnapshot().settings).toEqual(after)
  })

  it('开关保存失败时保持旧值并显示错误', async () => {
    const before = makeSnapshot({ enabled: false, channel: 'buddy' })
    const { configForms } = createConfigFormsDouble(before)
    const response = deferred<{ ok: false; error: typeof failure.error }>()
    const { connection } = createConnectionDouble(() => response.promise)
    const controller = new SettingsController({ configForms, connection })

    const pending = controller.setEnabled(true)
    expect(controller.getSnapshot()).toMatchObject({
      enabled: false,
      channel: 'buddy',
      viewChannel: 'buddy',
      busy: true,
      error: null,
    })

    response.resolve(failure)
    await pending

    expect(controller.getSnapshot()).toMatchObject({
      enabled: false,
      channel: 'buddy',
      viewChannel: 'buddy',
      busy: false,
      error: 'settings.saveFailed',
    })
  })

  it('在飞写入锁住后续写入，不发出第二个 RPC', async () => {
    const before = makeSnapshot({ enabled: false, channel: 'buddy' })
    const after = makeSnapshot({ enabled: true, channel: 'buddy' })
    const { configForms } = createConfigFormsDouble(before)
    const response = deferred<{ ok: true; value: typeof after }>()
    const { connection, calls } = createConnectionDouble(() => response.promise)
    const controller = new SettingsController({ configForms, connection })

    const first = controller.setEnabled(true)
    const second = controller.setEnabled(false)
    expect(calls).toHaveLength(1)
    expect(controller.getSnapshot()).toMatchObject({
      enabled: false,
      channel: 'buddy',
      viewChannel: 'buddy',
      busy: true,
    })

    response.resolve({ ok: true, value: after })
    await Promise.all([first, second])

    expect(calls).toHaveLength(1)
    expect(controller.getSnapshot()).toMatchObject({ enabled: true, busy: false })
  })

  it('渠道保存失败时保持旧值且配置视图不切换', async () => {
    const before = makeSnapshot({ enabled: true, channel: 'buddy' })
    const { configForms } = createConfigFormsDouble(before)
    const response = deferred<{ ok: false; error: typeof failure.error }>()
    const { connection } = createConnectionDouble(() => response.promise)
    const controller = new SettingsController({ configForms, connection })

    const pending = controller.selectChannel('qoder')
    expect(controller.getSnapshot()).toMatchObject({
      channel: 'buddy',
      viewChannel: 'buddy',
      busy: true,
      error: null,
    })

    response.resolve(failure)
    await pending

    expect(controller.getSnapshot()).toMatchObject({
      channel: 'buddy',
      viewChannel: 'buddy',
      error: 'settings.saveFailed',
      busy: false,
    })
  })

  it('卸载/释放后丢弃迟到响应且不再通知', async () => {
    const before = makeSnapshot({ enabled: false, channel: 'buddy' })
    const after = makeSnapshot({ enabled: true, channel: 'buddy' })
    const { configForms, form } = createConfigFormsDouble(before)
    const response = deferred<{ ok: true; value: typeof after }>()
    const { connection } = createConnectionDouble(() => response.promise)
    const controller = new SettingsController({ configForms, connection })

    let notifications = 0
    controller.subscribe(() => { notifications += 1 })
    const pending = controller.setEnabled(true)
    const afterPending = notifications
    expect(controller.getSnapshot()).toMatchObject({ enabled: false, busy: true })

    controller.dispose()
    expect(form.listenerCount()).toBe(0)

    response.resolve({ ok: true, value: after })
    await pending

    expect(notifications).toBe(afterPending)
    expect(controller.getSnapshot().viewChannel).toBe('buddy')
  })

  it('只读设置拒绝写入且保持原值', async () => {
    const before = makeSnapshot({ enabled: false, channel: 'buddy' })
    const { configForms } = createConfigFormsDouble(before, { writable: false })
    const { connection, calls } = createConnectionDouble(() => ({ ok: true, value: before }))
    const controller = new SettingsController({ configForms, connection })

    await controller.setEnabled(true)
    await controller.selectChannel('qoder')

    expect(calls).toEqual([])
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      enabled: false,
      channel: 'buddy',
      writable: false,
    })
  })

  it('configForms 尚未就绪或未暴露命名空间时保持不可写状态', () => {
    const { configForms, form } = createConfigFormsDouble(undefined, { status: 'loading' })
    const { connection } = createConnectionDouble(() => ({ ok: true, value: makeSnapshot() }))
    const controller = new SettingsController({ configForms, connection })

    expect(controller.getSnapshot().status).toBe('loading')
    expect(controller.getSnapshot().busy).toBe(false)

    form.push({ status: 'unavailable' })
    expect(controller.getSnapshot().status).toBe('unavailable')
    expect(controller.getSnapshot().writable).toBe(false)
  })
})
