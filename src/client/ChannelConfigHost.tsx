/**
 * 动态渠道配置宿主：同一时刻只渲染当前 search.channel 对应的一个配置区。
 * 保留 Qoder 端点、固定域、账号/授权/删除/清除的既有 IA 与 Host 注入边界。
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
  endpointPreference = 'auto',
  actualEndpointHost = null,
  endpointBusy = false,
  endpointWritable = true,
  endpointError = null,
  onEndpointPreferenceChange,
}: ChannelConfigHostProps): React.ReactElement {
  const headingId = React.useId()
  const hasAccount = currentAccountId !== null
  return (
    <section
      className={styles.section}
      aria-labelledby={headingId}
      data-channel-config-host=""
      data-channel={channel}
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
              error={endpointError}
            />
          </div>
        )
        : (
          <div className={styles.fieldSlot} data-fixed-endpoint-slot="">
            <div className={styles.field} data-field="endpoint">
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
            <div className={styles.field} data-field="">
              <div className={styles.head} data-field-head="">
                <div className={styles.labelGroup} data-label-group="">
                  <span className={styles.label} data-field-label="">{t('channel.account.label')}</span>
                </div>
              </div>
            </div>
            <div className={styles.hintRow} data-hint-row="">
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
