/**
 * 动态渠道配置宿主：只渲染当前 `search.channel` 对应的配置区。
 *
 * 账号列表、内联授权/删除与 Qoder 端点编辑属于 Task 14；本任务只提供准确的
 * DOM 宿主与 padding 结构。`children` 是 Task 14 的 `AccountChannelConfig` 接缝，
 * 现在缺省时只显示“需要账号/当前账号”状态，不伪造 ready。
 */
import * as React from 'react'

import type { ChannelId } from '../shared/channels.ts'
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
}

/**
 * 渲染当前渠道的配置 section。
 * @param props - 渠道、账号状态、翻译与 Task 14 账号区接缝。
 * @returns 动态渠道配置区。
 */
export function ChannelConfigHost({
  channel,
  currentAccountId,
  t,
  children,
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

      {channel === 'qoder' && (
        <div
          className={styles.fieldSlot}
          data-qoder-endpoint-slot=""
          data-reserved-for="task-14"
        />
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
