/** rc5 MenuRow：label 在前，selected 只在 trailing 位置追加 SVG check。 */
import * as React from 'react'

import { CheckOutlineIcon } from './icons.tsx'
import styles from '../styles/settings-card.module.css'

export interface MenuRowProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  readonly children: React.ReactNode
  readonly selected?: boolean
}

/** 渲染一个原生 button[role=menuitem]，保持官方键盘走查与选择外观。 */
export function MenuRow({ children, selected = false, className, ...button }: MenuRowProps): React.ReactElement {
  const classes = [styles.menuItem, selected ? styles.menuSelected : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <div className={styles.menuItemWrap}>
      <button
        {...button}
        type="button"
        role="menuitem"
        className={classes}
        data-selected={selected ? 'true' : 'false'}
      >
        <span className={styles.menuItemLabel}>{children}</span>
        {selected && <CheckOutlineIcon className={styles.menuCheck} />}
      </button>
    </div>
  )
}
