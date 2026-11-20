/**
 * Qoder 国际版端点偏好行（Task 14）。
 *
 * 下拉恰好三项：自动 / center.qoder.sh / api2.qoder.sh。`actualHost` 只来自
 * Host 脱敏运行观测，Client 当前没有对应 RPC，因此允许 null/undefined 并显示
 * 本地化“尚无运行观测”；绝不把自动模式的默认 center 冒充实际成功域，也不因
 * 实际观测改写用户 preference。固定 center/api2 只显示用户选择的域。
 */
import * as React from 'react'

import {
  CHANNELS,
  QODER_ENDPOINT_PREFERENCES,
  type QoderEndpointPreference,
} from '../shared/channels.ts'
import { Dropdown } from './components/Dropdown.tsx'
import styles from './styles/settings-card.module.css'

/** Qoder 国际版端点行属性。 */
export interface QoderEndpointRowProps {
  /** 用户保存的端点偏好。 */
  readonly preference: QoderEndpointPreference
  /** Host 脱敏运行观测的实际 host；没有观测时为 null/undefined。 */
  readonly actualHost: string | null | undefined
  /** 用户选择新偏好；保存由上层设置控制器执行。 */
  readonly onChange: (next: QoderEndpointPreference) => void
  /** 翻译函数。 */
  readonly t: (key: string) => string
  /** 设置写入在飞时禁用下拉。 */
  readonly busy?: boolean
  /** Host 是否允许写入。 */
  readonly writable?: boolean
  /** 翻译后的保存错误；只显示在端点行。 */
  readonly error?: string | null
}

/** 读取共享定义里的固定域映射；auto 的默认 center 不用于“实际观测”。 */
const ENDPOINT_HOSTS = CHANNELS.qoder.endpointPreference?.hosts ?? {
  auto: 'center.qoder.sh',
  center: 'center.qoder.sh',
  api2: 'api2.qoder.sh',
}

/**
 * 渲染 Qoder 国际版端点偏好与状态。
 * @param props - 偏好、实际观测、回调、翻译与锁定状态。
 * @returns 端点行；不包含网关域名或第二渠道选择器。
 */
export function QoderEndpointRow({
  preference,
  actualHost,
  onChange,
  t,
  busy = false,
  writable = true,
  error = null,
}: QoderEndpointRowProps): React.ReactElement {
  const labelId = React.useId()
  const observedHost = typeof actualHost === 'string' && actualHost !== '' ? actualHost : null
  const items = QODER_ENDPOINT_PREFERENCES.map((id) => ({
    id,
    label: id === 'auto' ? t('channel.endpoint.auto') : ENDPOINT_HOSTS[id],
  }))
  const selectedLabel = preference === 'auto'
    ? t('channel.endpoint.auto')
    : ENDPOINT_HOSTS[preference]

  return (
    <div className={styles.field} data-qoder-endpoint-row="" data-preference={preference}>
      <div className={styles.fieldHead}>
        <span id={labelId} className={styles.fieldLabel}>{t('channel.endpoint.label')}</span>
      </div>
      <div className={styles.fieldControl}>
        <Dropdown
          items={items}
          selectedId={preference}
          valueLabel={selectedLabel}
          onSelect={(id) => { onChange(id as QoderEndpointPreference) }}
          disabled={busy || !writable}
          labelledBy={labelId}
          label={t('channel.endpoint.label')}
        />
      </div>
      <span
        className={styles.hintText}
        data-endpoint-status=""
        data-state={preference === 'auto' ? (observedHost === null ? 'unobserved' : 'observed') : 'fixed'}
      >
        {preference === 'auto'
          ? observedHost === null
            ? t('channel.endpoint.noObservation')
            : (
              <>
                {t('channel.endpoint.actual')}
                <code data-actual-host="">{observedHost}</code>
              </>
            )
          : (
            <>
              {t('channel.endpoint.fixed')}
              <code data-selected-host="">{ENDPOINT_HOSTS[preference]}</code>
            </>
          )}
      </span>
      <span className={styles.hintText}>{t('channel.endpoint.description')}</span>
      {error !== null && (
        <span className={styles.error} role="alert" data-endpoint-error="">
          {t(error)}
        </span>
      )}
    </div>
  )
}