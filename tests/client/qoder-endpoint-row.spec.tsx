// @vitest-environment jsdom
/**
 * Task 14 Qoder 国际版端点行：只有 auto/center/api2，自动模式显示实际观测，
 * 无观测时不得把默认 center 冒充实际成功域；固定模式显示用户选择域。
 *
 * 同时覆盖设置卡中的非乐观保存：pending 保持旧值，Host 成功快照后才更新，
 * 失败回滚并只把错误显示在端点行；OFF 时下方配置区整体灰化且仅清除全部账号
 * 数据可用，端点编辑只在 ON 时允许。
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { QoderEndpointRow } from '../../src/client/QoderEndpointRow.tsx'
import { SettingsCard } from '../../src/client/SettingsCard.tsx'
import type { QoderEndpointPreference } from '../../src/shared/channels.ts'
import type { SearchSettingsSnapshot } from '../../src/shared/contracts.ts'
import type { RpcResult } from '../../src/shared/rpc.ts'
import { routeAccounts } from './support/accounts-harness.ts'
import {
  buttonByText,
  click,
  createConfigFormsDouble,
  createConnectionDouble,
  deferred,
  flush,
  makeSnapshot,
  mount,
  query,
  translator,
  type MountedRoot,
  type RpcResponder,
  type TestLocale,
} from './support/settings-harness.ts'

const mounted: MountedRoot[] = []
const failure = {
  ok: false as const,
  error: { code: 'settings/internal', message: 'settings operation failed', details: {} },
}

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

interface RowOptions {
  readonly preference?: QoderEndpointPreference
  readonly actualHost?: string | null
  readonly locale?: TestLocale
  readonly busy?: boolean
  readonly writable?: boolean
  readonly gated?: boolean
  readonly error?: string | null
}

/**
 * 挂载真实的 QoderEndpointRow。
 * @param options - 偏好、实际观测与锁定状态。
 * @returns 容器、行元素、翻译与变更 spy。
 */
function renderRow(options: RowOptions = {}) {
  const t = translator(options.locale ?? 'zh')
  const onChange = vi.fn()
  const root = mount(createElement(QoderEndpointRow, {
    preference: options.preference ?? 'auto',
    actualHost: options.actualHost ?? null,
    onChange,
    t,
    busy: options.busy ?? false,
    writable: options.writable ?? true,
    gated: options.gated ?? false,
    error: options.error ?? null,
  }))
  mounted.push(root)
  return {
    ...root,
    t,
    onChange,
    row: query<HTMLElement>(root.container, '[data-qoder-endpoint-row]'),
  }
}

/**
 * 挂载带账号默认路由的设置卡。
 * @param snapshot - 初始设置快照。
 * @param settingsResponder - 非账号 RPC 的响应。
 * @param locale - 中文或英文。
 * @returns 容器、调用记录、翻译与表单替身。
 */
function renderCard(
  snapshot: SearchSettingsSnapshot,
  settingsResponder: RpcResponder,
  locale: TestLocale = 'zh',
) {
  const t = translator(locale)
  const forms = createConfigFormsDouble(snapshot)
  const accounts = routeAccounts({})
  const routed: RpcResponder = call => (
    call.method.startsWith('accounts.') || call.method.startsWith('auth.')
      ? accounts(call)
      : settingsResponder(call)
  )
  const rpc = createConnectionDouble(routed)
  const root = mount(createElement(SettingsCard, {
    view: 'page',
    t,
    configForms: forms.configForms,
    connection: rpc.connection,
  }))
  mounted.push(root)
  return { ...forms, ...rpc, t, ...root }
}

describe('QoderEndpointRow（真实 DOM）', () => {
  it('自动模式无实际观测时只显示“尚无运行观测”，不把默认 center 冒充成功域', () => {
    const { row, t } = renderRow({ preference: 'auto', actualHost: null })

    const trigger = query<HTMLButtonElement>(row, '[data-dropdown-trigger]')
    expect(trigger.textContent).toContain(t('channel.endpoint.auto'))
    expect(row.querySelector('[data-actual-host]')).toBeNull()
    const status = query<HTMLElement>(row, '[data-endpoint-status]')
    expect(status.textContent).toContain(t('channel.endpoint.noObservation'))
    expect(status.textContent).not.toContain('center.qoder.sh')
    expect(status.textContent).not.toContain('api2.qoder.sh')
    expect(row.textContent).not.toContain('gateway.qoder.com.cn')
  })

  it('自动模式收到实际观测后显示它，但不改写 preference 也不触发 onChange', async () => {
    const { row, t, onChange } = renderRow({
      preference: 'auto',
      actualHost: 'api2.qoder.sh',
    })

    const trigger = query<HTMLButtonElement>(row, '[data-dropdown-trigger]')
    expect(trigger.textContent).toContain(t('channel.endpoint.auto'))
    const status = query<HTMLElement>(row, '[data-actual-host]')
    expect(status.textContent).toBe(`${t('channel.endpoint.actual')}api2.qoder.sh`)
    expect(status.children).toHaveLength(0)
    expect(status.querySelector('code')).toBeNull()
    expect(query<HTMLElement>(row, '[data-endpoint-status]').textContent)
      .toContain(t('channel.endpoint.actual'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('固定 center/api2 只显示所选域，实际观测不同也不改写用户偏好', () => {
    const center = renderRow({ preference: 'center', actualHost: 'api2.qoder.sh' })
    expect(query<HTMLButtonElement>(center.row, '[data-dropdown-trigger]').textContent)
      .toContain('center.qoder.sh')
    const centerStatus = query<HTMLElement>(center.row, '[data-selected-host]')
    expect(centerStatus.textContent).toBe(`${center.t('channel.endpoint.fixed')}center.qoder.sh`)
    expect(centerStatus.children).toHaveLength(0)
    expect(centerStatus.querySelector('code')).toBeNull()
    expect(center.row.querySelector('[data-actual-host]')).toBeNull()
    expect(center.row.textContent).not.toContain('api2.qoder.sh')

    const api2 = renderRow({ preference: 'api2', actualHost: 'center.qoder.sh' })
    expect(query<HTMLButtonElement>(api2.row, '[data-dropdown-trigger]').textContent)
      .toContain('api2.qoder.sh')
    const api2Status = query<HTMLElement>(api2.row, '[data-selected-host]')
    expect(api2Status.textContent).toBe(`${api2.t('channel.endpoint.fixed')}api2.qoder.sh`)
    expect(api2Status.children).toHaveLength(0)
    expect(api2Status.querySelector('code')).toBeNull()
    expect(api2.row.textContent).not.toContain('center.qoder.sh')
  })

  it('下拉恰好只有自动/center/api2，选择后回传新偏好，不出现 gateway 或第四项', async () => {
    const { row, t, onChange } = renderRow({ preference: 'auto' })
    const trigger = query<HTMLButtonElement>(row, '[data-dropdown-trigger]')

    await click(trigger)
    const menu = query<HTMLElement>(document, '[data-dropdown-menu]')
    const labels = [...menu.querySelectorAll('[role="menuitem"]')]
      .map(item => item.getAttribute('aria-label'))
    expect(labels).toEqual([
      t('channel.endpoint.auto'),
      'center.qoder.sh',
      'api2.qoder.sh',
    ])
    expect(labels.join(' ')).not.toContain('gateway')

    await click(buttonByText(menu, 'api2.qoder.sh'))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('api2')
    expect(document.querySelector('[data-dropdown-menu]')).toBeNull()

    await click(trigger)
    const sameMenu = query<HTMLElement>(document, '[data-dropdown-menu]')
    const selectedItem = sameMenu.querySelector<HTMLButtonElement>(
      `[role="menuitem"][aria-label="${t('channel.endpoint.auto')}"]`,
    )
    expect(selectedItem).not.toBeNull()
    await click(selectedItem as HTMLButtonElement)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('busy/只读时拒绝打开，错误红字保持 class=error 与 role=alert', () => {
    const busy = renderRow({ busy: true })
    expect(query<HTMLButtonElement>(busy.row, '[data-dropdown-trigger]').disabled).toBe(true)

    const readOnly = renderRow({ writable: false })
    expect(query<HTMLButtonElement>(readOnly.row, '[data-dropdown-trigger]').disabled).toBe(true)

    const failing = renderRow({ error: 'settings.saveFailed' })
    const alert = query<HTMLElement>(failing.row, '[data-endpoint-error]')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.className).toContain('error')
    expect(alert.textContent).toContain('保存失败')
    expect(alert.closest('[aria-disabled="true"], [inert]')).toBeNull()
  })

  it('OFF gating 时端点下拉禁用并整体灰化，不触发变更', async () => {
    const { row, t, onChange } = renderRow({ gated: true })
    expect(row.getAttribute('data-off-gated')).toBe('true')
    expect(row.className).toContain('fieldGated')
    const trigger = query<HTMLButtonElement>(row, '[data-dropdown-trigger]')
    expect(trigger.disabled).toBe(true)
    expect(row.textContent).toContain(t('channel.endpoint.description'))
    expect(row.textContent).toContain(t('channel.endpoint.noObservation'))
    await click(trigger)
    expect(document.querySelector('[data-dropdown-menu]')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('ON 时端点行没有 OFF gating 标记', () => {
    const { row } = renderRow({ gated: false })
    expect(row.hasAttribute('data-off-gated')).toBe(false)
    expect(row.className).not.toContain('fieldGated')
    expect(query<HTMLButtonElement>(row, '[data-dropdown-trigger]').disabled).toBe(false)
  })

  it('字段使用 rc5 head>labelGroup、独立 p.hint 与完整 aria-describedby 关系', () => {
    const { row } = renderRow({ error: 'settings.saveFailed' })
    const labelGroup = query<HTMLElement>(row, '[data-field-head] > [data-label-group]')
    const label = query<HTMLLabelElement>(labelGroup, 'label')
    const trigger = query<HTMLButtonElement>(row, '[data-dropdown-trigger]')
    expect(label.htmlFor).toBe(trigger.id)
    expect(label.textContent).toBe('搜索端点')
    expect(labelGroup.querySelector('[data-field-actions]')).toBeNull()

    const status = query<HTMLElement>(row, '[data-endpoint-status]')
    expect(status.tagName).toBe('P')
    expect(status.id).not.toBe('')
    const description = query<HTMLElement>(row, '[data-endpoint-description]')
    expect(description.tagName).toBe('P')
    const error = query<HTMLElement>(row, '[data-endpoint-error]')
    expect(error.tagName).toBe('P')
    const describedBy = trigger.getAttribute('aria-describedby')?.split(' ') ?? []
    expect(describedBy).toEqual(expect.arrayContaining([status.id, description.id, error.id]))
    for (const hint of row.querySelectorAll('p[class*="hint"]')) {
      expect(hint.children, '字段 hint 必须是纯字符串，不允许嵌入 code 等元素').toHaveLength(0)
    }
  })

  it('英文文案覆盖端点行，自动无观测不会出现中文', () => {
    const { row } = renderRow({ preference: 'auto', actualHost: null, locale: 'en' })
    expect(query<HTMLButtonElement>(row, '[data-dropdown-trigger]').textContent).toContain('Auto')
    expect(row.textContent).toContain('No runtime observation')
    expect(row.textContent).toContain('Search endpoint')
    expect(row.textContent).not.toMatch(/[\u4e00-\u9fff]/)
  })
})

describe('设置卡中的端点行与固定域', () => {
  it('只有 Qoder 国际版出现端点下拉；其他三渠道只显示固定域文本', async () => {
    const cases = [
      { channel: 'buddy' as const, host: 'copilot.tencent.com', endpoint: false },
      { channel: 'workbuddy' as const, host: 'www.workbuddy.ai', endpoint: false },
      { channel: 'qoder' as const, host: null, endpoint: true },
      { channel: 'qodercn' as const, host: 'gateway.qoder.com.cn', endpoint: false },
    ]

    for (const testCase of cases) {
      const { container } = renderCard(
        makeSnapshot({ enabled: false, channel: testCase.channel }),
        call => ({ ok: true, value: makeSnapshot({ enabled: false, channel: testCase.channel }) }),
      )
      await flush()
      const host = query<HTMLElement>(container, '[data-channel-config-host]')
      expect(host.querySelector('[data-qoder-endpoint-slot]') === null)
        .toBe(testCase.channel !== 'qoder')
      expect(host.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(
        testCase.channel === 'qoder' ? 1 : 0,
      )
      if (testCase.host === null) {
        const row = query<HTMLElement>(host, '[data-qoder-endpoint-row]')
        expect(row.textContent).not.toContain('gateway.qoder.com.cn')
        expect(query<HTMLElement>(row, '[data-endpoint-status]').textContent)
          .toContain('尚无运行观测')
      } else {
        const fixed = query<HTMLElement>(host, '[data-fixed-endpoint]')
        expect(fixed.textContent).toBe(testCase.host)
        expect(fixed.closest('[data-fixed-endpoint-slot]')).not.toBeNull()
        expect(fixed.closest('[data-fixed-endpoint-slot]')?.querySelector('button')).toBeNull()
      }

      for (const root of mounted.splice(0)) root.unmount()
      document.body.innerHTML = ''
    }
  })

  it('ON 时端点保存非乐观：pending 保持自动与旧状态，成功后才显示 api2，失败回滚并只在端点行报错', async () => {
    const before = makeSnapshot({ enabled: true, channel: 'qoder', endpointPreference: 'auto' })
    const after = makeSnapshot({ enabled: true, channel: 'qoder', endpointPreference: 'api2' })
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container, calls } = renderCard(before, (call) => {
      if (call.method === 'settings.update') return response.promise
      return { ok: true, value: before }
    })
    await flush()

    const row = query<HTMLElement>(container, '[data-qoder-endpoint-row]')
    const trigger = query<HTMLButtonElement>(row, '[data-dropdown-trigger]')
    expect(trigger.disabled).toBe(false)
    expect(trigger.textContent).toContain('自动')

    await click(trigger)
    await click(buttonByText(query(document, '[data-dropdown-menu]'), 'api2.qoder.sh'))
    await flush()

    expect(trigger.disabled).toBe(true)
    expect(trigger.textContent).toContain('自动')
    expect(row.textContent).toContain('尚无运行观测')
    expect(calls.filter(call => call.method === 'settings.update')).toEqual([{
      method: 'settings.update',
      payload: { patch: { endpointPreference: 'api2' } },
    }])
    expect(container.querySelector('[role="alert"]')).toBeNull()

    response.resolve({ ok: true, value: after })
    await flush()
    expect(trigger.disabled).toBe(false)
    expect(trigger.textContent).toContain('api2.qoder.sh')
    expect(row.textContent).toContain('固定使用')
    expect(row.textContent).toContain('api2.qoder.sh')
  })

  it('ON 时端点保存失败回滚到旧偏好，错误只出现在端点行，不污染渠道行', async () => {
    const before = makeSnapshot({ enabled: true, channel: 'qoder', endpointPreference: 'auto' })
    const response = deferred<RpcResult<SearchSettingsSnapshot>>()
    const { container } = renderCard(before, (call) => {
      if (call.method === 'settings.update') return response.promise
      return { ok: true, value: before }
    })
    await flush()

    const row = query<HTMLElement>(container, '[data-qoder-endpoint-row]')
    const trigger = query<HTMLButtonElement>(row, '[data-dropdown-trigger]')
    await click(trigger)
    await click(buttonByText(query(document, '[data-dropdown-menu]'), 'center.qoder.sh'))
    await flush()

    expect(trigger.textContent).toContain('自动')
    response.resolve(failure)
    await flush()

    expect(trigger.textContent).toContain('自动')
    expect(trigger.disabled).toBe(false)
    expect(row.textContent).toContain('尚无运行观测')
    const alert = query<HTMLElement>(row, '[data-endpoint-error]')
    expect(alert.textContent).toContain('保存失败')
    expect(alert.className).toContain('error')
    expect(container.querySelector('[data-row="channel"] [role="alert"]')).toBeNull()
    expect(container.querySelector('[data-channel-config-host]')?.getAttribute('data-channel'))
      .toBe('qoder')
  })
})