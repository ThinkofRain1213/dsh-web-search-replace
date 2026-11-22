/**
 * 动态渠道配置宿主：同一时刻只渲染当前 search.channel 对应的一个配置区。
 * 保留 Qoder 端点、固定域、账号/授权/删除/清除的既有 IA 与 Host 注入边界。
 * OFF 时整段传入 gating：标题、说明、端点与账号区由各自组件灰化并禁用修改，
 * 但清除全部账号数据仍由 AccountChannelConfig 保留可用。
 */
import * as React from 'react'

import {
  CHANNELS,
  type ChannelId,
  type QoderEndpointPreference,
} from '../shared/channels.ts'
import { QoderEndpointRow } from './QoderEndpointRow.tsx'
import styles from './styles/settings-card.module.css'

export interface ChannelConfigHostProps {
  readonly channel: ChannelId
  readonly currentAccountId: string | null
  readonly t: (key: string) => string
  readonly children?: React.ReactNode
  /** 搜索 OFF 时整段灰化并禁用端点/账号修改；clear-all 由账号区自行保留。 */
  readonly gated?: boolean
  readonly endpointPreference?: QoderEndpointPreference
  readonly actualEndpointHost?: string | null
  readonly endpointBusy?: boolean
  readonly endpointWritable?: boolean
  readonly endpointError?: string | null
  readonly onEndpointPreferenceChange?: (next: QoderEndpointPreference) => void
}

/** 渲染当前渠道的配置 section；children 只替换账号区，不增加第二渠道选择器。 */
export function ChannelConfigHost({
  channel,
  currentAccountId,
  t,
  children,
  gated = false,
  endpointPreference = 'auto',
  actualEndpointHost = null,
  endpointBusy = false,
  endpointWritable = true,
  endpointError = null,
  onEndpointPreferenceChange,
}: ChannelConfigHostProps): React.ReactElement {
  const headingId = React.useId()
  const hasAccount = currentAccountId !== null
  const fieldClass = gated ? `${styles.field} ${styles.fieldGated}` : styles.field
  const hintRowClass = gated ? `${styles.hintRow} ${styles.fieldGated}` : styles.hintRow
  const offGated = gated ? 'true' : undefined
  return (
    <section
      className={`${styles.section}${gated ? ` ${styles.channelGated}` : ''}`}
      aria-labelledby={headingId}
      data-channel-config-host=""
      data-channel={channel}
      data-off-gated={offGated}
    >
      <h3 id={headingId} className={styles.heading}>{t(`channel.${channel}.name`)}</h3>

      <div className={styles.row} data-channel-description="">
        <div className={styles.rowText}>
          <span className={styles.rowDescription}>{t(`channel.${channel}.description`)}</span>
        </div>
      </div>

      {channel === 'qoder'
        ? (
          <div className={styles.fieldSlot} data-qoder-endpoint-slot="">
            <QoderEndpointRow
              preference={endpointPreference}
              actualHost={actualEndpointHost}
              onChange={(next) => { onEndpointPreferenceChange?.(next) }}
              t={t}
              busy={endpointBusy}
              writable={endpointWritable}
              gated={gated}
              error={endpointError}
            />
          </div>
        )
        : (
          <div className={styles.fieldSlot} data-fixed-endpoint-slot="">
            <div className={fieldClass} data-field="endpoint" data-off-gated={offGated}>
              <div className={styles.head} data-field-head="">
                <div className={styles.labelGroup} data-label-group="">
                  <span className={styles.label} data-field-label="">{t('channel.endpoint.label')}</span>
                </div>
              </div>
              <span className={styles.fieldValue} data-fixed-endpoint="">
                {CHANNELS[channel].hosts[0]}
              </span>
              <p className={styles.hint}>{t('channel.endpoint.fixedDescription')}</p>
            </div>
          </div>
        )}

      <div className={styles.fieldSlot} data-account-config-slot="">
        {children ?? (
          <>
            <div className={fieldClass} data-field="" data-off-gated={offGated}>
              <div className={styles.head} data-field-head="">
                <div className={styles.labelGroup} data-label-group="">
                  <span className={styles.label} data-field-label="">{t('channel.account.label')}</span>
                </div>
              </div>
            </div>
            <div className={hintRowClass} data-hint-row="" data-off-gated={offGated}>
              <span
                className={styles.hintText}
                data-account-state={hasAccount ? 'selected' : 'required'}
              >
                {hasAccount
                  ? `${t('channel.account.current')}: ${currentAccountId}`
                  : t('channel.account.required')}
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
