/**
 * 自有 Dropdown/Menu：复制 rc3 WebSearch 同场景的锚点与 Menu 行为。
 *
 * 锚点 34px / `0 12px`，Menu 4px padding / item 34px / `6px 8px` / gap 6 /
 * 13px·20px。列表 portal 到 document.body，打开时自动聚焦首项，方向键巡回，
 * Escape 与 Shift+Tab 关闭并把焦点还给 trigger，外部 pointerdown 只关闭菜单。
 * 不导入任何 Harness Client 控件；portal 样式在同名 CSS Modules 产物里。
 */
import * as React from 'react'
import { createPortal } from 'react-dom'

import styles from '../styles/settings-card.module.css'

/** 下拉选项。 */
export interface DropdownOption {
  readonly id: string
  readonly label: string
  readonly disabled?: boolean
}

/** 受控下拉属性。 */
export interface DropdownProps {
  /** 全部选项；顺序即菜单顺序。 */
  readonly items: readonly DropdownOption[]
  /** 当前值 id。 */
  readonly selectedId: string
  /** trigger 上显示的当前值文本。 */
  readonly valueLabel: string
  /** 选择新值；选择当前值不会调用。 */
  readonly onSelect: (id: string) => void
  /** 是否拒绝打开与选择。 */
  readonly disabled?: boolean
  /** 外部 label 元素 id；与当前值一起构成 trigger 的无障碍名称。 */
  readonly labelledBy?: string
  /** 没有外部 label 时的无障碍名称。 */
  readonly label?: string
  /** 稳定 trigger id，便于宿主与测试引用。 */
  readonly id?: string
}

/** 菜单打开后用于定位的矩形。 */
interface MenuPosition {
  readonly left: number
  readonly top: number
  readonly minWidth?: number
}

/**
 * 渲染锚点按钮与 portal 菜单。
 * @param props - 选项、当前值、回调与锁定状态。
 * @returns 锚点与打开时的门户菜单。
 */
export function Dropdown({
  items,
  selectedId,
  valueLabel,
  onSelect,
  disabled = false,
  labelledBy,
  label,
  id,
}: DropdownProps): React.ReactElement {
  const generatedId = React.useId().replaceAll(':', '')
  const triggerId = id ?? `dsh-web-search-dropdown-${generatedId}`
  const valueId = `${triggerId}-value`
  const menuId = `${triggerId}-menu`
  const [open, setOpen] = React.useState(false)
  const [position, setPosition] = React.useState<MenuPosition | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([])
  const initialFocus = React.useRef(0)
  const shown = open && !disabled

  /** 打开菜单并记录初始焦点索引。 */
  const openMenu = React.useCallback((focusIndex: number): void => {
    if (disabled) return
    initialFocus.current = focusIndex
    setOpen(true)
  }, [disabled])

  /** 关闭菜单，可选把焦点还给 trigger。 */
  const closeMenu = React.useCallback((refocus: boolean): void => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus({ preventScroll: true })
  }, [])

  // 锚点被上层锁定时，已经打开的菜单也要收起。
  React.useEffect(() => {
    if (disabled && open) setOpen(false)
  }, [disabled, open])

  // Portal 菜单定位与 minWidthFromAnchor：锚点宽度作为最小宽度。
  React.useLayoutEffect(() => {
    if (!shown) {
      setPosition(null)
      return
    }
    const rect = triggerRef.current?.getBoundingClientRect()
    setPosition({
      left: rect?.left ?? 0,
      top: (rect?.bottom ?? 0) + 4,
      ...(rect === undefined || rect.width <= 0 ? {} : { minWidth: rect.width }),
    })
  }, [shown])

  // autoFocus：打开后聚焦首项；ArrowUp 打开时聚焦末项。
  React.useEffect(() => {
    if (!shown) return
    const target = itemRefs.current[initialFocus.current]
      ?? itemRefs.current.find(item => item !== null && !item.disabled)
      ?? null
    target?.focus({ preventScroll: true })
  }, [shown, items.length])

  // 键盘走查与外部 pointerdown 关闭。
  React.useEffect(() => {
    if (!shown) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) === true) return
      if (menuRef.current?.contains(target) === true) return
      closeMenu(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu(true)
        return
      }
      if (event.key === 'Tab' && event.shiftKey) {
        event.preventDefault()
        closeMenu(true)
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      ) ?? [])]
      if (buttons.length === 0) return
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : index < 0
            ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      event.preventDefault()
      buttons[next]?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [shown, closeMenu])

  /** trigger 键盘打开：Enter/Space/ArrowDown 首项，ArrowUp 末项。 */
  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault()
      openMenu(0)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu(Math.max(0, items.length - 1))
    }
  }

  /** 选择一项：先还焦点给 trigger，再关闭并报告不同于当前值的选项。 */
  const select = (idValue: string): void => {
    triggerRef.current?.focus({ preventScroll: true })
    setOpen(false)
    if (idValue !== selectedId) onSelect(idValue)
  }

  const trigger = (
    <button
      ref={triggerRef}
      id={triggerId}
      type="button"
      className={styles.selector}
      aria-haspopup="menu"
      aria-expanded={shown}
      aria-controls={shown ? menuId : undefined}
      {...(labelledBy === undefined
        ? { 'aria-label': label ?? valueLabel }
        : { 'aria-labelledby': `${labelledBy} ${valueId}` })}
      disabled={disabled}
      data-dropdown-trigger=""
      onClick={() => {
        if (disabled) return
        if (shown) setOpen(false)
        else openMenu(0)
      }}
      onKeyDown={onTriggerKeyDown}
    >
      <span id={valueId} className={styles.selectorLabel}>{valueLabel}</span>
      <svg
        className={styles.chevron}
        viewBox="0 0 16 16"
        width="16"
        height="16"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M4 6l4 4 4-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )

  const menu = shown
    ? createPortal(
      <div
        ref={menuRef}
        id={menuId}
        role="menu"
        aria-labelledby={triggerId}
        className={styles.menu}
        data-dropdown-menu=""
        data-min-width-from-anchor={position?.minWidth === undefined ? undefined : ''}
        style={position === null ? undefined : {
          left: position.left,
          top: position.top,
          ...(position.minWidth === undefined ? {} : { minWidth: position.minWidth }),
        }}
      >
        {items.map((item, index) => {
          const selected = item.id === selectedId
          return (
            <button
              key={item.id}
              ref={(element) => { itemRefs.current[index] = element }}
              type="button"
              role="menuitem"
              aria-label={item.label}
              className={styles.menuItem}
              data-selected={selected ? 'true' : 'false'}
              aria-current={selected ? 'true' : undefined}
              disabled={item.disabled}
              onClick={() => { select(item.id) }}
            >
              <span className={styles.menuCheck} aria-hidden="true">{selected ? '✓' : ''}</span>
              <span className={styles.menuItemLabel}>{item.label}</span>
            </button>
          )
        })}
      </div>,
      document.body,
    )
    : null

  return (
    <>
      {trigger}
      {menu}
    </>
  )
}
