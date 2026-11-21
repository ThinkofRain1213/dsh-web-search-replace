// @vitest-environment jsdom
/**
 * rc5 Dropdown/Menu 同构契约：真实锚点、MenuSurface、MenuRow、CSS anchor、
 * trailing SVG check、disabled 跳过、键盘和焦点。只用真实组件与 DOM，不用 mock 菜单。
 */
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Dropdown, type DropdownOption } from '../../src/client/components/Dropdown.tsx'
import {
  click,
  keydown,
  mount,
  pointerdown,
  query,
  type MountedRoot,
} from './support/settings-harness.ts'

const mounted: MountedRoot[] = []

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

const ITEMS: readonly DropdownOption[] = [
  { id: 'one', label: '第一项' },
  { id: 'two', label: '第二项（禁用）', disabled: true },
  { id: 'three', label: '第三项' },
]

/** 挂载一个真实 Dropdown。 */
function renderDropdown(options: { selectedId?: string; onSelect?: (id: string) => void } = {}) {
  const onSelect = options.onSelect ?? vi.fn()
  const root = mount(createElement(Dropdown, {
    items: ITEMS,
    selectedId: options.selectedId ?? 'one',
    valueLabel: '第一项',
    onSelect,
    label: '测试下拉',
    id: 'rc5-test-dropdown',
  }))
  mounted.push(root)
  const trigger = query<HTMLButtonElement>(root.container, '[data-dropdown-trigger]')
  return { ...root, trigger, onSelect }
}

describe('Dropdown rc5 MenuSurface / MenuRow（真实 DOM）', () => {
  it('使用 anchor-name/positionAnchor 和官方 surface/viewport/backing，不手写矩形坐标', async () => {
    const { container, trigger, unmount } = renderDropdown()
    await click(trigger)

    expect(trigger.lastElementChild?.getAttribute('data-icon')).toBe('dsh-web-search-channels-chevron-down-outline')
    expect(trigger.lastElementChild?.getAttribute('width')).toBe('14')
    const root = query<HTMLElement>(container, '[data-menu-root]')
    const menu = query<HTMLElement>(document, '[data-dropdown-menu]')
    const anchorName = root.style.getPropertyValue('anchor-name')
    expect(anchorName).toContain('--dsh-web-search-channels-menu-trigger-')
    expect(menu.style.getPropertyValue('position-anchor')).toBe(anchorName)
    expect(menu.hasAttribute('data-match-anchor-width')).toBe(true)
    expect(menu.getAttribute('data-anchor-side')).toBe('bottom')
    expect(menu.getAttribute('data-anchor-align')).toBe('start')
    expect(menu.style.left).toBe('')
    expect(menu.style.top).toBe('')
    expect(menu.style.minWidth).toBe('')
    expect(menu.getAttribute('data-menu-material')).toBe('translucent')
    expect(query(menu, '[data-menu-viewport]').getAttribute('role')).toBe('presentation')
    expect(menu.querySelector('[data-menu-material-layer]')).not.toBeNull()
    expect(document.body.querySelector('[data-menu-backing]')).not.toBeNull()
    expect(container.contains(menu)).toBe(false)
    expect(document.body.contains(menu)).toBe(true)

    unmount()
    expect(document.querySelector('[data-menu-backing]')).toBeNull()
  })

  it('MenuRow  label 在前，selected 仅追加 trailing SVG check，且没有文本勾', async () => {
    const { trigger } = renderDropdown({ selectedId: 'one' })
    await click(trigger)
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[data-dropdown-menu] [role="menuitem"]')]
    const selected = rows[0]
    expect(selected).toBeDefined()
    expect(selected?.className).toContain('menuSelected')
    expect(selected?.getAttribute('data-selected')).toBe('true')
    expect(selected?.textContent).toBe('第一项')
    expect(selected?.textContent).not.toContain('✓')
    expect(selected?.firstElementChild?.className).toContain('menuItemLabel')
    const check = selected?.lastElementChild
    expect(check?.tagName).toBe('svg')
    expect(check?.getAttribute('data-icon')).toBe('dsh-web-search-channels-check-outline')
    expect(check?.getAttribute('aria-hidden')).toBe('true')
    expect(check?.classList.toString()).toContain('menuCheck')
    expect(check?.querySelector('path')?.getAttribute('d')).toBe(
      'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4',
    )
    expect(rows[1]?.querySelector('[data-icon]')).toBeNull()
    expect(rows[2]?.querySelector('[data-icon]')).toBeNull()
  })

  it('autoFocus 与方向键/Home/End 正确跳过 disabled，disabled 不触发选择', async () => {
    const { trigger, onSelect } = renderDropdown()
    await keydown(trigger, 'Enter')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('第一项')

    await keydown(document.activeElement as Element, 'ArrowDown')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('第三项')
    await keydown(document.activeElement as Element, 'ArrowDown')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('第一项')
    await keydown(document.activeElement as Element, 'End')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('第三项')
    await keydown(document.activeElement as Element, 'Home')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('第一项')

    const disabled = query<HTMLButtonElement>(document, '[role="menuitem"][aria-label="第二项（禁用）"]')
    expect(disabled.disabled).toBe(true)
    await click(disabled)
    expect(onSelect).not.toHaveBeenCalled()
    expect(document.querySelector('[data-dropdown-menu]')).not.toBeNull()
  })

  it('trigger 上普通 Tab 进入首个 enabled row；row 上 Tab 走同一选择路径并回焦', async () => {
    const { trigger, onSelect } = renderDropdown()
    await keydown(trigger, 'Enter')
    trigger.focus()
    const enterList = await keydown(trigger, 'Tab')
    expect(enterList.defaultPrevented).toBe(true)
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('第一项')
    expect(onSelect).not.toHaveBeenCalled()
    expect(document.querySelector('[data-dropdown-menu]')).not.toBeNull()

    await keydown(document.activeElement as Element, 'ArrowDown')
    const select = await keydown(document.activeElement as Element, 'Tab')
    expect(select.defaultPrevented).toBe(true)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('three')
    expect(document.querySelector('[data-dropdown-menu]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('autoFocus 使用自动焦点标记，方向导航时释放以恢复焦点呈现', async () => {
    const { trigger } = renderDropdown()
    await keydown(trigger, 'Enter')
    const first = query<HTMLElement>(document, '[role="menuitem"][aria-label="第一项"]')
    expect(first.getAttribute('data-dsh-automatic-focus')).toBe('')
    await keydown(first, 'ArrowDown')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('第三项')
    expect(first.hasAttribute('data-dsh-automatic-focus')).toBe(false)
  })

  it('IME composition 与 compositionend 后未 keyup 时不执行菜单方向键', async () => {
    const { trigger } = renderDropdown()
    await keydown(trigger, 'Enter')
    const first = query<HTMLElement>(document, '[role="menuitem"][aria-label="第一项"]')
    await act(async () => {
      document.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    })
    const during = await keydown(first, 'ArrowDown')
    expect(during.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(first)

    await act(async () => {
      document.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    const closing = await keydown(first, 'ArrowDown')
    expect(closing.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(first)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }))
    })
    await keydown(first, 'ArrowDown')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('第三项')
  })

  it('Escape、Shift+Tab 回焦 trigger，outside pointer 只关闭且当前值选择不重复上报', async () => {
    const { trigger, onSelect } = renderDropdown()
    await click(trigger)
    await keydown(document.activeElement as Element, 'Escape')
    expect(document.querySelector('[data-dropdown-menu]')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    await click(trigger)
    await keydown(document.activeElement as Element, 'Tab', { shiftKey: true })
    expect(document.querySelector('[data-dropdown-menu]')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    await click(trigger)
    await click(query(document, '[role="menuitem"][aria-label="第一项"]'))
    expect(onSelect).not.toHaveBeenCalled()
    expect(document.querySelector('[data-dropdown-menu]')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    await click(trigger)
    await pointerdown(document.body)
    expect(document.querySelector('[data-dropdown-menu]')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
  })
})
