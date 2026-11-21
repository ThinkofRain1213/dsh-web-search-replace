/** rc5 MenuSurface 的插件自有同构实现：material、隔离层与 macOS backing。 */
import * as React from 'react'
import { createPortal } from 'react-dom'

import styles from '../styles/settings-card.module.css'

export type MenuSurfaceProps = React.ComponentPropsWithoutRef<'div'>

type MenuSurfaceStyle = React.CSSProperties & Record<`--dsh-web-search-channels-menu-${string}`, string>

/** 绘制菜单材质，并把 macOS 所需 backing 作为独立 body portal 对齐。 */
export const MenuSurface = React.forwardRef<HTMLDivElement, MenuSurfaceProps>(function MenuSurface({
  className,
  style,
  children,
  ...props
}, ref) {
  const id = React.useId()
  const backingRef = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    // CSS anchor 要求 anchor 先于 positioned element；提交后将 backing 移到 body 末尾。
    const backing = backingRef.current
    if (backing !== null) document.body.appendChild(backing)
  }, [])
  const anchorStyle: MenuSurfaceStyle = {
    '--dsh-web-search-channels-menu-anchor': `--dsh-web-search-channels-menu-${id.replaceAll(':', '')}`,
  }
  const classes = [styles.menuSurface, className].filter(Boolean).join(' ')
  return (
    <>
      <div
        {...props}
        ref={ref}
        data-menu-material="translucent"
        className={classes}
        style={{ ...style, ...anchorStyle }}
      >
        <div aria-hidden="true" className={styles.menuMaterial} data-menu-material-layer="" />
        {children}
      </div>
      {createPortal(
        <div
          ref={backingRef}
          aria-hidden="true"
          data-menu-backing=""
          className={styles.menuBacking}
          style={{ ...anchorStyle, visibility: style?.visibility }}
        />,
        document.body,
      )}
    </>
  )
})
