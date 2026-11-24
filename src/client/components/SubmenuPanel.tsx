import * as React from 'react'
/** Portaled child menu presentation; interaction state belongs to useMenuSubmenu. */
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from './clsx.ts'
import { menuHoverAllowed, type useMenuSubmenu } from './useMenuSubmenu.ts'
import { menuIconColumns, MenuRow, renderMenuDecoration } from './MenuRow.tsx'
import { IconChevronLeftOutlineRegular } from './icons.tsx'
import { MenuSurface } from './MenuSurface.tsx'
import css from './Menu.module.css'

/** Name the parent card anchor, and hide the child card until its layout is known. */
function anchors(submenu: ReturnType<typeof useMenuSubmenu>, hidden: boolean): CSSProperties & Record<`--dsh-web-search-replace-submenu-${string}`, string> {
  return { '--dsh-web-search-replace-submenu-parent': submenu.parentAnchor, ...hidden ? { visibility: 'hidden' } : {} }
}

/** Render one child list with a non-selecting back row in single-page placement.
 * @param props - active entry, submenu operations, and shared row presentation options.
 * @returns a body portal that preserves child DOM identity across placement changes.
 */
export function SubmenuPanel({ entry, submenu, compact, dense, contextual, backLabel, onSelect, onClose, afterSelection }: {
  entry: NonNullable<ReturnType<typeof useMenuSubmenu>['entry']>
  submenu: ReturnType<typeof useMenuSubmenu>
  compact: boolean
  dense: boolean
  contextual: boolean
  backLabel: ReactNode
  onSelect: ((id: string) => void) | undefined
  onClose: () => void
  afterSelection: () => void
}) {
  const columns = menuIconColumns(entry.submenu, contextual)
  return createPortal(<MenuSurface ref={submenu.panelRef} compact={compact}
    className={clsx(css.menuSubmenu, css.menuScrollable, dense && css.menuDenseList, compact && css.menuCompactList)}
    style={anchors(submenu, submenu.hidden)}
    data-submenu-layout={submenu.measured ? submenu.page ? 'page' : 'side' : undefined}
    data-contextual={contextual ? '' : undefined} role="menu" onPointerEnter={submenu.cancelClose}
    onPointerLeave={(event) => { if (menuHoverAllowed(event)) submenu.leave() }}
    onContextMenu={contextual ? (event) => { event.preventDefault(); event.stopPropagation(); onClose() } : undefined}
    onClick={(event) => { event.stopPropagation(); afterSelection() }}>
    {submenu.page && <>
      <MenuRow data-menu-back="" icon={<IconChevronLeftOutlineRegular className={css.menuCheck} />}
        onClick={submenu.returnToParent}>{backLabel}</MenuRow>
      <div className={css.menuSeparator} role="separator" />
    </>}
    <div className={css.menuViewport} role="presentation">
      {entry.submenu.map(sub => 'type' in sub ? renderMenuDecoration(sub)
        : <MenuRow key={sub.id} icon={sub.icon} reserveIcon={columns.has(sub)} disabled={sub.disabled}
          aria-label={typeof sub.label === 'string' ? sub.label : undefined}
          danger={sub.danger} shortcut={sub.shortcut} onClick={() => { onSelect?.(sub.id) }}>{sub.label}</MenuRow>)}
    </div>
  </MenuSurface>, document.body)
}
