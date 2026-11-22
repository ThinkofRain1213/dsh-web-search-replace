/**
 * Qoder 国际版端点偏好字段。保留 auto/center/api2、实际观测与保存语义。
 *
 * R53：标签与 Dropdown 位于同一个横向 row（左侧搜索端点、右侧下拉），不再使用
 * 纵向全宽 field/fieldControl，也不再为全宽给 Menu 根传 settings menuRoot 类。
 * 状态与说明放在紧随其后的 hintRow，二者都是纯字符串 p；错误单独一行。
 * 搜索 OFF 时 gated 禁用下拉并灰化 row/hintRow，但不改变已持久化的 preference。
 */
import * as React from 'react'

import {
  CHANNELS,
  QODER_ENDPOINT_PREFERENCES,
  type QoderEndpointPreference,
} from '../shared/channels.ts'
import { Dropdown } from './components/Dropdown.tsx'
import styles from './styles/settings-card.module.css'

export interface QoderEndpointRowProps {
  readonly preference: QoderEndpointPreference
  readonly actualHost: string | null | undefined
  readonly onChange: (next: QoderEndpointPreference) => void
  readonly t: (key: string) => string
  readonly busy?: boolean
  readonly writable?: boolean
  /** 搜索 OFF 时只读灰化；与 busy/writable 一样只禁用控件。 */
  readonly gated?: boolean
  readonly error?: string | null
}

const ENDPOINT_HOSTS = CHANNELS.qoder.endpointPreference?.hosts ?? {
  auto: 'center.qoder.sh',
  center: 'center.qoder.sh',
  api2: 'api2.qoder.sh',
}

/** 渲染 Qoder 端点行；auto 的默认 center 不冒充实际观测。 */
export function QoderEndpointRow({
  preference,
  actualHost,
  onChange,
  t,
  busy = false,
  writable = true,
  gated = false,
  error = null,
}: QoderEndpointRowProps): React.ReactElement {
  const labelId = React.useId()
  const triggerId = `${labelId}-control`
  const statusId = `${labelId}-status`
  const descriptionId = `${labelId}-description`
  const errorId = `${labelId}-error`
  const observedHost = typeof actualHost === 'string' && actualHost !== '' ? actualHost : null
  const items = QODER_ENDPOINT_PREFERENCES.map((id) => ({
    id,
    label: id === 'auto' ? t('channel.endpoint.auto') : ENDPOINT_HOSTS[id],
  }))
  const selectedLabel = preference === 'auto'
    ? t('channel.endpoint.auto')
    : ENDPOINT_HOSTS[preference]
  const describedBy = [statusId, descriptionId, error === null ? '' : errorId].filter(Boolean).join(' ')
  const statusText = preference === 'auto'
    ? observedHost === null
      ? t('channel.endpoint.noObservation')
      : `${t('channel.endpoint.actual')}${observedHost}`
    : `${t('channel.endpoint.fixed')}${ENDPOINT_HOSTS[preference]}`
  const rowClass = gated ? `${styles.row} ${styles.rowGated}` : styles.row
  const hintRowClass = gated ? `${styles.hintRow} ${styles.rowGated}` : styles.hintRow
  const offGated = gated ? 'true' : undefined

  return (
    <>
      <div
        className={rowClass}
        data-qoder-endpoint-row=""
        data-preference={preference}
        data-off-gated={offGated}
      >
        <div className={styles.rowText}>
          <label id={labelId} htmlFor={triggerId} className={styles.rowTitle} data-field-label="">
            {t('channel.endpoint.label')}
          </label>
        </div>
        <Dropdown
          id={triggerId}
          items={items}
          selectedId={preference}
          valueLabel={selectedLabel}
          onSelect={(id) => { onChange(id as QoderEndpointPreference) }}
          disabled={busy || !writable || gated}
          labelledBy={labelId}
          label={t('channel.endpoint.label')}
          describedBy={describedBy}
        />
      </div>
      <div className={hintRowClass} data-hint-row="" data-off-gated={offGated}>
        <p
          id={statusId}
          className={styles.hint}
          data-endpoint-status=""
          data-state={preference === 'auto' ? (observedHost === null ? 'unobserved' : 'observed') : 'fixed'}
          data-actual-host={preference === 'auto' && observedHost !== null ? '' : undefined}
          data-selected-host={preference === 'auto' ? undefined : ''}
        >
          {statusText}
        </p>
        <p id={descriptionId} className={styles.hint} data-endpoint-description="">
          {t('channel.endpoint.description')}
        </p>
      </div>
      {error !== null && (
        <p id={errorId} className={styles.error} role="alert" data-endpoint-error="">
          {t(error)}
        </p>
      )}
    </>
  )
}
