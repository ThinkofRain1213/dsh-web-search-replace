// @vitest-environment jsdom
/** 官方完整 Menu 对照：fill、contextual/backing、disabledReason 与 submenu，禁止自造删减分支。 */
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Menu, MenuItemButton } from '../../src/client/components/Menu.tsx'
import {
  buttonByText,
  click,
  flush,
  keydown,
  mount,
  query,
  type MountedRoot,
} from './support/settings-harness.ts'

const mounted: MountedRoot[] = []

beforeEach(() => {
  class TestResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: true,
    media: '(any-hover: hover)',
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => true,
  })))
})

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type TestMenuProps = Parameters<typeof Menu>[0]

/** 挂载直接来自官方 API 形状的 Menu。 */
function renderMenu(props: TestMenuProps) {
  const root = mount(createElement(Menu, props))
  mounted.push(root)
  return root
}

/** 构造官方属性，允许 RED 在旧删减 API 上运行。 */
function menuProps(overrides: Record<string, unknown>): TestMenuProps {
  return {
    open: true,
    anchor: createElement('button', { type: 'button', id: 'official-parity-trigger' }, '打开'),
    items: [{ id: 'one', label: '第一项' }, { id: 'two', label: '第二项' }],
    selectedId: 'one',
    triggerId: 'official-parity-trigger',
    onSelect: vi.fn(),
    onClose: vi.fn(),
    autoFocus: true,
    ...overrides,
  } as TestMenuProps
}

describe('rc5 官方完整 Menu 对照（RED）', () => {
  it("selection='fill' 使用官方 selectedFill 而不是 check 分支", () => {
    renderMenu(menuProps({ selection: 'fill' }))
    const selected = query<HTMLElement>(document, '[role="menuitem"][aria-label="第一项"]')
    expect(selected.className).toContain('menuSelectedFill')
    expect(selected.querySelector('[data-icon]')).toBeNull()
  })

  it('contextual 同时标记 surface/backing 的 enter phase 与 context-menu', () => {
    renderMenu(menuProps({
      contextual: true,
      anchorPoint: { x: 20, y: 30 },
      autoFocus: false,
      returnFocus: () => document.getElementById('official-parity-trigger'),
    }))
    const menu = query<HTMLElement>(document, '[data-dropdown-menu]')
    expect(menu.hasAttribute('data-context-menu')).toBe(true)
    expect(menu.getAttribute('data-menu-phase')).toBe('enter')
    expect(query<HTMLElement>(document, '[data-menu-backing]').getAttribute('data-menu-phase')).toBe('enter')
  })

  it('disabledReason 保留可聚焦 aria-disabled、说明关系且绝不激活', async () => {
    const onSelect = vi.fn()
    renderMenu(menuProps({
      items: [{ id: 'enabled', label: '可用项' }],
      selectedId: 'enabled',
      onSelect,
      children: createElement(MenuItemButton, {
        children: '禁用项',
        disabled: true,
        disabledReason: '当前不可修改',
        onSelect,
      }),
    }))
    const blocked = buttonByText(document, '禁用项')
    expect(blocked.disabled).toBe(false)
    expect(blocked.getAttribute('aria-disabled')).toBe('true')
    const reasonId = blocked.getAttribute('aria-describedby')
    expect(reasonId).not.toBeNull()
    expect(document.getElementById(reasonId ?? '')?.textContent).toBe('当前不可修改')
    await click(blocked)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('ArrowRight 打开真实 submenu，Escape 先返回父菜单而不是关闭', async () => {
    const onClose = vi.fn()
    renderMenu(menuProps({
      items: [{
        id: 'parent', label: '父菜单', submenu: [{ id: 'child', label: '子选项' }],
      }],
      selectedId: 'parent',
      onClose,
    }))
    const parent = query<HTMLElement>(document, '[role="menuitem"][aria-label="父菜单"]')
    expect(parent.getAttribute('aria-haspopup')).toBe('menu')
    await keydown(parent, 'ArrowRight')
    await flush()
    const child = query<HTMLElement>(document, '[role="menuitem"][aria-label="子选项"]')
    expect(document.activeElement).toBe(child)

    await keydown(child, 'Escape')
    await flush()
    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('父菜单')
    expect(document.querySelector('[role="menuitem"][aria-label="子选项"]')).toBeNull()
  })
})
