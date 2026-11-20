/**
 * 动态渠道配置宿主：只渲染当前 `search.channel` 对应的配置区。
 *
 * Qoder 国际版拥有端点偏好下拉（`QoderEndpointRow`）；其他三渠道只显示固定
 * 域名文本，没有端点下拉。账号列表、内联授权/删除由 `AccountChannelConfig`
 * 通过 `children` 挂到账号区；缺省时仍渲染“需要账号/当前账号”状态占位。
 */
import * as React from 'react'

import {
  CHANNELS,
  type ChannelId,
  type QoderEndpointPreference,
} from '../shared/channels.ts'
import { QoderEndpointRow } from './QoderEndpointRow.tsx'
import styles from './styles/settings-card.module.css'

/** 渠道配置宿主属性。 */
export interface ChannelConfigHostProps {
  /** 当前 search.channel；同一时刻只有一个。 */
  readonly channel: ChannelId
  /** 该渠道的用户当前账号意图；null 表示尚未配置。 */
  readonly currentAccountId: string | null
  /** 翻译函数。 */
  readonly t: (key: string) => string
  /** Task 14 的账号配置区；未提供时渲染状态占位。 */
  readonly children?: React.ReactNode
  /** Qoder 国际版端点偏好；其他渠道忽略。 */
  readonly endpointPreference?: QoderEndpointPreference
  /** Host 脱敏运行观测的实际 host；没有观测时为 null。 */
  readonly actualEndpointHost?: string | null
  /** 端点设置写入在飞。 */
  readonly endpointBusy?: boolean
  /** 端点下拉是否可写。 */
  readonly endpointWritable?: boolean
  /** 已翻译的端点保存错误。 */
  readonly endpointError?: string | null
  /** 请求保存 Qoder 国际版端点偏好。 */
  readonly onEndpointPreferenceChange?: (next: QoderEndpointPreference) => void
}

/**
 * 渲染当前渠道的配置 section。
 * @param props - 渠道、账号状态、端点行、翻译与 Task 14 账号区接缝。
 * @returns 动态渠道配置区。
 */
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
              <div className={styles.fieldHead}>
                <span className={styles.fieldLabel}>{t('channel.endpoint.label')}</span>
              </div>
              <span className={styles.fieldValue} data-fixed-endpoint="">
                {CHANNELS[channel].hosts[0]}
              </span>
              <span className={styles.hintText}>{t('channel.endpoint.fixedDescription')}</span>
            </div>
          </div>
        )}

      <div className={styles.fieldSlot} data-account-config-slot="">
        {children ?? (
          <>
            <div className={styles.field} data-field="">
              <div className={styles.fieldHead}>
                <span className={styles.fieldLabel}>{t('channel.account.label')}</span>
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