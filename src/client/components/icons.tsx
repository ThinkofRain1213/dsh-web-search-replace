/** rc5 官方 SVG 的插件自有副本；不读取 Host sprite，也不导入 Host 图标包。 */
import * as React from 'react'

export interface IconProps {
  readonly className?: string | undefined
}

/** 与 rc5 check-outline regular 相同的 16 viewBox / 1px stroke。 */
export function CheckOutlineIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      data-icon="dsh-web-search-channels-check-outline"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      strokeWidth="1"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4"
        stroke="currentColor"
      />
    </svg>
  )
}

/** 与 rc5 chevron-down-outline regular 相同的 14px 图标。 */
export function ChevronRightOutlineIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg className={className} data-icon="dsh-web-search-channels-chevron-right-outline" width="14" height="14" viewBox="0 0 16 16" fill="none" strokeWidth="1" aria-hidden="true" focusable="false">
      <path d="M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4" stroke="currentColor" />
    </svg>
  )
}

export function ChevronLeftOutlineIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg className={className} data-icon="dsh-web-search-channels-chevron-left-outline" width="14" height="14" viewBox="0 0 16 16" fill="none" strokeWidth="1" aria-hidden="true" focusable="false">
      <path d="M10 4L6.70711 7.29289C6.31658 7.68342 6.31658 8.31658 6.70711 8.70711L10 12" stroke="currentColor" />
    </svg>
  )
}

export function ChevronDownOutlineIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      data-icon="dsh-web-search-channels-chevron-down-outline"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      strokeWidth="1"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6"
        stroke="currentColor"
      />
    </svg>
  )
}

export const IconCheckOutlineRegular = CheckOutlineIcon
export const IconChevronRightOutlineRegular = ChevronRightOutlineIcon
export const IconChevronLeftOutlineRegular = ChevronLeftOutlineIcon
export const IconChevronDownOutlineRegular = ChevronDownOutlineIcon
