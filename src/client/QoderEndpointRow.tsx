/**
 * Qoder 国际版端点偏好字段。保留 auto/center/api2、实际观测与保存语义；
 * 外观复制 rc5 field/head/labelGroup，hint/error 通过 aria-describedby 关联 trigger。
 * 搜索 OFF 时 gated 禁用下拉并灰化字段，但不改变已持久化的 preference。
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

/** 渲染 Qoder 端点字段；auto 的默认 center 不冒充实际观测。 */
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

  return (
    <div
      className={`${styles.field}${gated ? ` ${styles.fieldGated}` : ''}`}
      data-qoder-endpoint-row=""
      data-preference={preference}
      data-off-gated={gated ? 'true' : undefined}
    >
      <div className={styles.head} data-field-head="">
        <div className={styles.labelGroup} data-label-group="">
          <label id={labelId} htmlFor={triggerId} className={styles.label} data-field-label="">
            {t('channel.endpoint.label')}
          </label>
        </div>
      </div>
      <div className={styles.fieldControl}>
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
          className={styles.menuRoot}
        />
      </div>
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
      {error !== null && (
        <p id={errorId} className={styles.error} role="alert" data-endpoint-error="">
          {t(error)}
        </p>
      )}
    </div>
  )
}
