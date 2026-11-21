/**
 * rc5 标准 Dropdown Menu 的插件自有实现。
 *
 * 保留本场景使用的官方行为：portal + CSS anchor、autoFocus、minWidthFromAnchor、
 * outside dismissal、方向键/Home/End、Escape、Shift+Tab、普通 Tab、选择后回焦、
 * 输入法保护与监听器清理。当前选项没有 submenu/contextual/footer，故不引入这些业务外分支。
 */
import * as React from 'react'
import { createPortal } from 'react-dom'

import { focusWithoutRing } from './focus.ts'
import { observeComposition } from './keyboard-composition.ts'
import { MenuRow } from './MenuRow.tsx'
import { MenuSurface } from './MenuSurface.tsx'
import styles from '../styles/settings-card.module.css'

export interface MenuItem {
  readonly id: string
  readonly label: string
  readonly disabled?: boolean
}

export interface MenuProps {
  readonly open: boolean
  readonly anchor: React.ReactNode
  readonly items: readonly MenuItem[]
  readonly selectedId: string
  readonly triggerId: string
  readonly onSelect: (id: string) => void
  readonly onClose: () => void
  readonly returnFocus?: (() => HTMLElement | null) | undefined
  readonly autoFocus?: boolean
  readonly minWidthFromAnchor?: boolean
  readonly initialFocus?: 'first' | 'last'
}

type AnchorStyle = React.CSSProperties & {
  anchorName?: string
  positionAnchor?: string
}

/** 渲染锚点、body portal surface 与键盘走查。 */
export function Menu({
  open,
  anchor,
  items,
  selectedId,
  triggerId,
  onSelect,
  onClose,
  returnFocus,
  autoFocus = true,
  minWidthFromAnchor = true,
  initialFocus = 'first',
}: MenuProps): React.ReactElement {
  const rootRef = React.useRef<HTMLSpanElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const menuId = React.useId()
  const walkIndex = React.useRef<number | null>(null)
  const triggerRef = React.useRef<HTMLElement | null>(null)
  const selectingWithTab = React.useRef(false)
  const openRef = React.useRef(open)
  const closeRef = React.useRef(onClose)
  openRef.current = open
  closeRef.current = onClose
  const anchorName = `--dsh-web-search-channels-menu-trigger-${menuId.replaceAll(':', '')}`

  const refocusAnchor = (navigation = false): void => {
    const remembered = triggerRef.current
    const trigger = returnFocus?.() ?? (remembered?.isConnected ? remembered : null)
    const target = trigger !== null && trigger !== undefined && document.contains(trigger)
      && !(trigger as HTMLButtonElement).disabled
      ? trigger
      : rootRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    if (target == null) return
    if (navigation) target.focus()
    else focusWithoutRing(target)
  }

  const refocusAfterSelection = (): void => {
    const navigation = selectingWithTab.current
    queueMicrotask(() => {
      if (openRef.current) return
      const active = document.activeElement
      if (active === null || active === document.body || listRef.current?.contains(active) === true) {
        refocusAnchor(navigation)
      }
    })
  }

  // 必须先捕获打开者，再让 autoFocus 把焦点送入菜单。
  React.useEffect(() => {
    if (!open) return
    const active = document.activeElement
    triggerRef.current = active instanceof HTMLElement && active !== document.body
      && rootRef.current?.contains(active) === true
      ? active
      : null
  }, [open])

  React.useEffect(() => {
    if (!open || !autoFocus || listRef.current?.contains(document.activeElement)) return
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    const index = initialFocus === 'last' ? buttons.length - 1 : 0
    const target = buttons[index]
    walkIndex.current = target === undefined ? null : index
    if (target !== undefined) focusWithoutRing(target)
  }, [open, autoFocus, items.length, initialFocus])

  React.useEffect(() => {
    if (!open) {
      walkIndex.current = null
      return
    }
    const composition = observeComposition(document)
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (rootRef.current?.contains(event.target) === true || listRef.current?.contains(event.target) === true) return
      closeRef.current()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (composition.guards(event) || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return
      const focused = document.activeElement
      const insideList = listRef.current?.contains(focused) === true
      const anchored = focused === returnFocus?.() || rootRef.current?.contains(focused) === true || insideList
      if (event.key === 'Escape' && !event.shiftKey) {
        event.preventDefault()
        if (event.repeat) return
        closeRef.current()
        if (anchored || autoFocus) refocusAnchor()
        return
      }
      if (event.key === 'Tab') {
        const list = listRef.current
        if (list === null || !anchored) return
        if (event.shiftKey) {
          event.preventDefault()
          closeRef.current()
          refocusAnchor(true)
          return
        }
        if (insideList) {
          if (focused instanceof Element && focused.getAttribute('role') === 'menuitem') {
            event.preventDefault()
            selectingWithTab.current = true
            try { (focused as HTMLElement).click() }
            finally { selectingWithTab.current = false }
          }
          return
        }
        const row = list.querySelector<HTMLButtonElement>('button:not(:disabled)')
        if (row === null) return
        event.preventDefault()
        row.focus()
        walkIndex.current = 0
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const list = listRef.current
      if (list === null || !anchored) return
      const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      if (buttons.length === 0) return
      const index = buttons.indexOf(focused as HTMLButtonElement)
      const from = index >= 0 ? index : walkIndex.current
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : from === null
            ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
            : (from + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      event.preventDefault()
      walkIndex.current = next
      buttons[next]?.focus()
    }
    const onWindowBlur = (): void => {
      if (document.activeElement instanceof HTMLIFrameElement) closeRef.current()
    }
    document.addEventListener('pointerdown', onPointerDown)
    const onEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') onKeyDown(event) }
    const onOtherKey = (event: KeyboardEvent): void => { if (event.key !== 'Escape') onKeyDown(event) }
    document.addEventListener('keydown', onOtherKey)
    document.addEventListener('keydown', onEscape, true)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      composition.dispose()
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onOtherKey)
      document.removeEventListener('keydown', onEscape, true)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [open, autoFocus, returnFocus])

  const list = open
    ? (
      <MenuSurface
        ref={listRef}
        id={`${triggerId}-menu`}
        role="menu"
        aria-labelledby={triggerId}
        className={`${styles.menu} ${styles.menuPortal} ${styles.menuScrollable}`}
        style={{ positionAnchor: anchorName } as AnchorStyle}
        data-dropdown-menu=""
        data-anchor-side="bottom"
        data-anchor-align="start"
        data-match-anchor-width={minWidthFromAnchor ? '' : undefined}
        onClick={(event) => {
          event.stopPropagation()
          const row = event.target instanceof Element ? event.target.closest('button[role="menuitem"]') : null
          if (row !== null) refocusAfterSelection()
        }}
      >
        <div className={styles.menuViewport} role="presentation" data-menu-viewport="">
          {items.map(item => (
            <MenuRow
              key={item.id}
              selected={item.id === selectedId}
              aria-label={item.label}
              disabled={item.disabled}
              onClick={() => { onSelect(item.id) }}
            >
              {item.label}
            </MenuRow>
          ))}
        </div>
      </MenuSurface>
    )
    : false

  return (
    <span
      ref={rootRef}
      className={styles.menuRoot}
      data-menu-root=""
      style={{ anchorName } as AnchorStyle}
    >
      {anchor}
      {list !== false && createPortal(list, document.body)}
    </span>
  )
}
