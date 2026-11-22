// @vitest-environment jsdom
/**
 * R53：Qoder 端点不再是纵向全宽字段。最终 lib/client.js 必须证明：
 * - 端点标签与 Dropdown 位于同一横向 row；
 * - 官方 Menu 根不再附加 settings-card 的 menuRoot 类，也不再有 fieldControl；
 * - trigger 的 border:none / bg-module-platform 与官方 MenuSurface elevation 不变。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { SearchSettingsSnapshot } from '../../src/shared/contracts.ts'
import { routeAccounts } from './support/accounts-harness.ts'
import {
  createConfigFormsDouble,
  createConnectionDouble,
  flush,
  makeSnapshot,
  mount,
  query,
  translator,
  type MountedRoot,
} from './support/settings-harness.ts'

const ROOT = path.resolve(process.cwd())
const mounted: MountedRoot[] = []
let artifact = ''
let settingsClasses: Record<string, string> = {}
let menuClasses: Record<string, string> = {}
let builtComponent: React.ComponentType<Record<string, unknown>> | null = null

/** 从最终 Client 构建产物读取一张 CSS Module 的原始类→哈希类映射。 */
function readMapping(name: string): Record<string, string> {
  const match = artifact.match(new RegExp(`var ${name} = (\\{[^;]+\\});`))
  if (match === null) throw new Error(`最终 Client 产物缺少 CSS Module 映射 ${name}`)
  return JSON.parse(match[1]) as Record<string, string>
}

beforeAll(() => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-client.mjs')], {
    cwd: ROOT,
    stdio: 'ignore',
  })
  artifact = readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
  settingsClasses = readMapping('settings_card_default')
  menuClasses = readMapping('Menu_default')

  let factory: ((require: (specifier: string) => unknown) => {
    apply: (ctx: Record<string, unknown>) => void
  }) | undefined
  Object.assign(window, {
    __ModuleLoader__: {
      load: (record: { factory: typeof factory }) => { factory = record.factory },
    },
  })
  new Function('window', artifact)(window)
  if (factory === undefined) throw new Error('最终 Client 未注册 lazy factory')
  const client = factory(specifier => {
    if (specifier === 'react') return React
    if (specifier === 'react-dom') return ReactDOM
    throw new Error(`测试不允许最终 Client 的运行时依赖 ${specifier}`)
  })
  const t = translator('zh')
  const scope: Record<string, unknown> = {
    locale: {
      register: () => () => {},
      bind: () => t,
    },
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (_options: Record<string, unknown>, component: React.ComponentType<Record<string, unknown>>) => {
        builtComponent = component
        return () => {}
      },
    },
    effect: (callback: () => unknown) => callback(),
    inject: (_deps: readonly string[], callback: (scope: Record<string, unknown>) => void) => {
      callback(scope)
    },
  }
  client.apply(scope)
  if (builtComponent === null) throw new Error('最终 Client 未注册 SettingsCard')
})

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount()
  document.body.innerHTML = ''
  delete (window as { __ModuleLoader__?: unknown }).__ModuleLoader__
})

/** 用最终构建的 SettingsCard 和真实 Host 接缝挂载一个渠道。 */
function renderBuiltChannel(channel: SearchSettingsSnapshot['search']['channel']) {
  const snapshot = makeSnapshot({ enabled: true, channel })
  const forms = createConfigFormsDouble(snapshot)
  const rpc = createConnectionDouble(routeAccounts({}))
  const t = translator('zh')
  const root = mount(React.createElement(builtComponent as React.ComponentType<Record<string, unknown>>, {
    view: 'page',
    t,
    configForms: forms.configForms,
    connection: rpc.connection,
  }))
  mounted.push(root)
  return root
}

describe('Qoder 端点行不再使用纵向全宽接缝（R53）', () => {
  it('最终产物中 settings CSS 不再导出 fieldControl / menuRoot 全宽规则', () => {
    expect(settingsClasses.fieldControl).toBeUndefined()
    expect(settingsClasses.menuRoot).toBeUndefined()
    expect(artifact).not.toContain('> .menuRoot')
  })

  it('端点标签与 Dropdown 同处一个横向 row，官方 Menu 根不带 settings 附加类', async () => {
    const root = renderBuiltChannel('qoder')
    await flush()
    const row = query<HTMLElement>(root.container, '[data-qoder-endpoint-row]')
    const rowText = query<HTMLElement>(row, '[class*="rowText"]')
    const menuRoot = query<HTMLElement>(row, ':scope > [data-menu-root]')
    const trigger = query<HTMLButtonElement>(row, '[data-dropdown-trigger]')

    expect(row.className).toContain(settingsClasses.row)
    expect(rowText.textContent).toBe('搜索端点')
    expect(rowText.nextElementSibling).toBe(menuRoot)
    expect(row.querySelector('[class*="fieldControl"]')).toBeNull()
    expect(menuRoot.classList.contains(menuClasses.menuRoot)).toBe(true)
    expect(menuRoot.className.split(/\s+/)).toHaveLength(1)
    expect(trigger.parentElement).toBe(menuRoot)
    expect(trigger.classList.contains(settingsClasses.selector)).toBe(true)
  })

  it('trigger 使用 DPG/DAE 的 border:none 与 module-platform，MenuSurface elevation 不变', async () => {
    const root = renderBuiltChannel('qoder')
    await flush()
    const trigger = query<HTMLButtonElement>(root.container, '[data-qoder-endpoint-row] [data-dropdown-trigger]')
    expect(trigger.classList.contains(settingsClasses.selector)).toBe(true)
    expect(artifact).toMatch(new RegExp(`\\.${settingsClasses.selector}\\s*\\{[^}]*border:\\s*none;`))
    expect(artifact).toMatch(new RegExp(`\\.${settingsClasses.selector}\\s*\\{[^}]*background:\\s*var\\(--dsw-alias-bg-module-platform\\)`))
    expect(artifact).not.toMatch(new RegExp(`\\.${settingsClasses.selector}\\s*\\{[^}]*border-l4`))
    expect(artifact).not.toMatch(new RegExp(`\\.${settingsClasses.selector}\\s*\\{[^}]*bg-layer-3`))
    expect(artifact).toContain('box-shadow: var(--dsw-elevation-prominent)')
  })

  it('SearchSection 不传附加类，保持官方 Menu 根且不受 Qoder 行影响', async () => {
    const root = renderBuiltChannel('buddy')
    await flush()
    const menuRoot = query<HTMLElement>(root.container, '[data-search-section] [data-menu-root]')
    expect(menuRoot.classList.contains(menuClasses.menuRoot)).toBe(true)
    expect(menuRoot.parentElement?.classList.contains(settingsClasses.row)).toBe(true)
    expect(root.container.querySelector('[data-fixed-endpoint-row] [data-menu-root]')).toBeNull()
  })
})