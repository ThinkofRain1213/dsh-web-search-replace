import * as React from 'react'
/** Shared menu material and the macOS backing that lets Chromium blur transparent windows. */
import { forwardRef, useId, useLayoutEffect, useRef, type ComponentPropsWithoutRef, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import clsx from './clsx.ts'
import css from './MenuSurface.module.css'

/** Context-menu transition durations in milliseconds, shared with its lifecycle owner. */
export const MENU_TRANSITION_MS = Object.freeze({ enter: 40, dismiss: 80, replace: 10, prepare: 20 })

/** Menu containers preserve native div props and refs. */
export interface MenuSurfaceProps extends ComponentPropsWithoutRef<'div'> {
  /** Match the shared compact menu's smaller outer radius. */
  compact?: boolean
  /** Fade direct content, material, and native backing without isolating the material's backdrop. */
  phase?: 'enter' | 'dismiss' | 'replace' | undefined
}

/**
 * Paint a menu and, on macOS, an opaque backing behind the page content within its bounds.
 * CSS anchors keep each backing aligned during placement, resizing, and nested-menu movement.
 * @param props - Div content and placement, and compact geometry.
 * @param ref - The visible menu div, excluding the non-interactive backing.
 * @returns Menu content plus a backing portal removed with the menu.
 */
export const MenuSurface = forwardRef<HTMLDivElement, MenuSurfaceProps>(function MenuSurface({
  compact = false, phase, className, style, children, ...props
}, ref) {
  const id = useId()
  const backingRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    // Nested React portals can insert the backing before its anchor. CSS anchor
    // positioning requires the anchor to precede the positioned element.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- The portal ref is attached before layout effects run.
    document.body.appendChild(backingRef.current!)
  }, [])
  const anchorStyle: CSSProperties & Record<`--dsh-web-search-replace-menu-${string}`, string> = {
    '--dsh-web-search-replace-menu-anchor': `--dsh-web-search-replace-menu-${id.replaceAll(':', '')}`,
    '--dsh-web-search-replace-menu-enter': `${MENU_TRANSITION_MS.enter}ms`,
    '--dsh-web-search-replace-menu-dismiss': `${MENU_TRANSITION_MS.dismiss}ms`,
    '--dsh-web-search-replace-menu-replace': `${MENU_TRANSITION_MS.replace}ms`,
  }
  return <>
    <div {...props} ref={ref} data-menu-material="translucent" data-menu-phase={phase}
      className={clsx(css.menuSurface, compact && css.menuCompact, className)} style={{ ...style, ...anchorStyle }}>
      <div aria-hidden="true" className={css.menuMaterial} data-menu-material-layer="" />
      {children}
    </div>
    {createPortal(
      <div ref={backingRef} aria-hidden="true" data-menu-backing="" data-menu-phase={phase} className={clsx(css.menuBacking, compact && css.menuCompact)}
        style={{ ...anchorStyle, visibility: style?.visibility }} />,
      document.body,
    )}
  </>
})
