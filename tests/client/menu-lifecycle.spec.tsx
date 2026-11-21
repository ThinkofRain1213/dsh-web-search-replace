// @vitest-environment jsdom
/** I-2：rc5 Menu 锚点失联/inert/hidden 与幕后 modal 键盘生命周期。 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Dropdown } from '../../src/client/components/Dropdown.tsx'
import {
  click,
  flush,
  keydown,
  mount,
  query,
  type MountedRoot,
} from './support/settings-harness.ts'

const mounted: MountedRoot[] = []

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

/** 挂载真实 Dropdown 并打开菜单。 */
async function renderOpenMenu() {
  const onSelect = vi.fn()
  const root = mount(createElement(Dropdown, {
    items: [
      { id: 'one', label: '第一项' },
      { id: 'two', label: '第二项' },
      { id: 'three', label: '第三项' },
    ],
    selectedId: 'one', valueLabel: '第一项', onSelect, label: '生命周期菜单', id: 'lifecycle-menu',
  }))
  mounted.push(root)
  const trigger = query<HTMLButtonElement>(root.container, '[data-dropdown-trigger]')
  await click(trigger)
  return { ...root, trigger, onSelect }
}

describe('Menu 锚点与 modal 生命周期（I-2 RED）', () => {
  it('祖先变为 inert 时关闭 portal 并断开 observer', async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const { container } = await renderOpenMenu()
    expect(document.querySelector('[data-dropdown-menu]')).not.toBeNull()
    container.setAttribute('inert', '')
    await flush()
    expect(document.querySelector('[data-dropdown-menu]')).toBeNull()
    expect(disconnect).toHaveBeenCalled()
  })

  it('祖先变为 hidden 时关闭 portal', async () => {
    const { container } = await renderOpenMenu()
    container.setAttribute('hidden', '')
    await flush()
    expect(document.querySelector('[data-dropdown-menu]')).toBeNull()
  })

  it('trigger 从 document 失联时关闭 portal，不要求 React 先卸载', async () => {
    const { trigger, container } = await renderOpenMenu()
    expect(container.isConnected).toBe(true)
    trigger.remove()
    await flush()
    expect(document.querySelector('[data-dropdown-menu]')).toBeNull()
  })

  it('Host modal 位于菜单上方时，方向键和 Escape 不由幕后 Menu 处理', async () => {
    const { onSelect } = await renderOpenMenu()
    const first = query<HTMLElement>(document, '[role="menuitem"][aria-label="第一项"]')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-label', 'Host modal')
    document.body.append(dialog)

    const arrow = await keydown(first, 'ArrowDown')
    expect(arrow.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(first)
    expect(onSelect).not.toHaveBeenCalled()
    expect(document.querySelector('[data-dropdown-menu]')).not.toBeNull()

    const escape = await keydown(first, 'Escape')
    expect(escape.defaultPrevented).toBe(false)
    expect(document.querySelector('[data-dropdown-menu]')).not.toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
    dialog.remove()
  })
})
