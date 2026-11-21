/**
 * rc5 WebSearch 同场景 Dropdown：34px / 0 12px trigger + 自有 Menu。
 * 选择保存导致 trigger 原生 disabled 跨帧失焦时，保留 R30 最终补偿回焦。
 */
import * as React from 'react'

import { ChevronDownOutlineIcon } from './icons.tsx'
import { Menu, type MenuItem } from './Menu.tsx'
import styles from '../styles/settings-card.module.css'

export type DropdownOption = MenuItem

export interface DropdownProps {
  readonly items: readonly DropdownOption[]
  readonly selectedId: string
  readonly valueLabel: string
  /** 选择当前值只关闭，不重复调用。 */
  readonly onSelect: (id: string) => void
  readonly disabled?: boolean
  readonly labelledBy?: string
  readonly label?: string
  readonly describedBy?: string
  readonly id?: string
  /** 透传到 Menu 根的可选附加类，用于跨 CSS Module 的布局接缝。 */
  readonly className?: string
}

/** 渲染受控锚点与 rc5 Menu；保存与渠道切换仍由调用方负责。 */
export function Dropdown({
  items,
  selectedId,
  valueLabel,
  onSelect,
  disabled = false,
  labelledBy,
  label,
  describedBy,
  id,
  className,
}: DropdownProps): React.ReactElement {
  const generatedId = React.useId().replaceAll(':', '')
  const triggerId = id ?? `dsh-web-search-channels-dropdown-${generatedId}`
  const valueId = `${triggerId}-value`
  const [open, setOpen] = React.useState(false)
  const [initialFocus, setInitialFocus] = React.useState<'first' | 'last'>('first')
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const restoreFocusIntent = React.useRef(false)
  const sawDisabled = React.useRef(false)
  const shown = open && !disabled

  const openMenu = React.useCallback((from: 'first' | 'last'): void => {
    if (disabled) return
    setInitialFocus(from)
    setOpen(true)
  }, [disabled])

  const closeMenu = React.useCallback((): void => { setOpen(false) }, [])
  const returnFocus = React.useCallback((): HTMLButtonElement | null => triggerRef.current, [])

  React.useEffect(() => {
    if (disabled && open) setOpen(false)
  }, [disabled, open])

  // R30：只补偿本次选择且经过 disabled 的失焦；用户已聚焦其它控件时不抢焦点。
  React.useEffect(() => {
    if (!restoreFocusIntent.current) return
    if (disabled) {
      sawDisabled.current = true
      return
    }
    if (sawDisabled.current) {
      sawDisabled.current = false
      restoreFocusIntent.current = false
      const active = document.activeElement
      if (active === null || active === document.body || active === document.documentElement) {
        triggerRef.current?.focus({ preventScroll: true })
      }
      return
    }
    if (!open) restoreFocusIntent.current = false
  }, [disabled, open])

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault()
      openMenu('first')
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu('last')
    }
  }

  const select = (idValue: string): void => {
    const changes = idValue !== selectedId
    if (changes) {
      restoreFocusIntent.current = true
      sawDisabled.current = false
    }
    triggerRef.current?.focus({ preventScroll: true })
    setOpen(false)
    if (changes) onSelect(idValue)
  }

  const anchor = (
    <button
      ref={triggerRef}
      id={triggerId}
      type="button"
      className={styles.selector}
      aria-haspopup="menu"
      aria-expanded={shown}
      aria-controls={shown ? `${triggerId}-menu` : undefined}
      aria-describedby={describedBy}
      {...(labelledBy === undefined
        ? { 'aria-label': label ?? valueLabel }
        : { 'aria-labelledby': `${labelledBy} ${valueId}` })}
      disabled={disabled}
      data-dropdown-trigger=""
      onClick={() => {
        if (disabled) return
        if (shown) closeMenu()
        else openMenu('first')
      }}
      onKeyDown={onTriggerKeyDown}
    >
      <span id={valueId} className={styles.selectorLabel}>{valueLabel}</span>
      <ChevronDownOutlineIcon className={styles.chevron} />
    </button>
  )

  return (
    <Menu
      open={shown}
      anchor={anchor}
      items={items}
      selectedId={selectedId}
      triggerId={triggerId}
      onSelect={select}
      onClose={closeMenu}
      returnFocus={returnFocus}
      className={className}
      portal
      autoFocus
      minWidthFromAnchor
      initialFocus={initialFocus}
    />
  )
}
