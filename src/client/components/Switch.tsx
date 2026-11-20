/**
 * 自有 Switch：复制 rc3 primitives 的 markup、ARIA、几何与状态。
 *
 * 不导入任何 Harness Client 控件；类名由本插件 CSS Modules 隔离。
 */
import * as React from 'react'

import styles from '../styles/settings-card.module.css'

/** 受控开关属性。 */
export interface SwitchProps {
  /** 当前状态。 */
  readonly checked: boolean
  /** 只报告目标状态，由调用方决定是否写入。 */
  readonly onChange: (next: boolean) => void
  /** 必填的本地化无障碍名称。 */
  readonly label: string
  /** 是否拒绝输入；写入在飞时由调用方锁定。 */
  readonly disabled?: boolean
  /** 本地化悬停提示，通常解释锁定原因。 */
  readonly title?: string
  /** 额外布局类。 */
  readonly className?: string
}

/**
 * 渲染一个原生 button 语义的开关。
 * @param props - 受控状态、标签、禁用与回调。
 * @returns role=switch 的按钮。
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  title,
  className,
}: SwitchProps): React.ReactElement {
  const classes = className === undefined
    ? styles.switch
    : `${styles.switch} ${className}`
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      className={classes}
      data-control="switch"
      onClick={() => { onChange(!checked) }}
    >
      <span className={styles.thumb} aria-hidden="true" />
    </button>
  )
}
