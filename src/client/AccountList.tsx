/**
 * 当前渠道的账号列表（Task 14）。
 *
 * 只渲染传给它的六字段 `AccountSummary`；当前账号与备选账号都带状态与脱敏标识。
 * 账号操作只锁相关行：授权/重登在飞或只读时全部锁定，单个行操作只禁用该行。
 */
import * as React from 'react'

import type { AccountSummary } from '../shared/accounts.ts'
import type { AccountsQueuedOperation } from './controllers/accounts.ts'
import styles from './styles/settings-card.module.css'

/** 账号列表属性。 */
export interface AccountListProps {
  /** 当前渠道账号；调用方已经过滤跨渠道记录。 */
  readonly accounts: readonly AccountSummary[]
  /** 当前使用账号；null 表示未指定。 */
  readonly current: AccountSummary | null
  /** 正在执行行操作的账号。 */
  readonly busyAccountId: string | null
  /** 已接受但尚未开始的行操作；用于显示“排队中”。 */
  readonly queue: readonly AccountsQueuedOperation[]
  /** 授权/重登或确认区在飞时锁定所有行。 */
  readonly locked: boolean
  /** Host 是否允许写入。 */
  readonly writable: boolean
  /** 翻译函数。 */
  readonly t: (key: string) => string
  /** 请求把某账号设为当前。 */
  readonly onSetCurrent: (accountId: string) => void
  /** 请求重新登录某账号。 */
  readonly onReauth: (accountId: string) => void
  /** 请求删除某账号（先展开确认）。 */
  readonly onDelete: (accountId: string) => void
}

/**
 * 渲染当前渠道的账号列表。
 * @param props - 账号、当前选择、锁定状态与操作回调。
 * @returns 账号行列表。
 */
export function AccountList({
  accounts,
  current,
  busyAccountId,
  queue,
  locked,
  writable,
  t,
  onSetCurrent,
  onReauth,
  onDelete,
}: AccountListProps): React.ReactElement {
  return (
    <div className={styles.accountList} data-account-list="">
      {accounts.map((account) => {
        const isCurrent = current?.id === account.id
        const queued = queue.some(operation => operation.accountId === account.id)
        const working = busyAccountId === account.id
        const rowLocked = locked || !writable || working || queued
        return (
          <div
            key={account.id}
            className={styles.accountRow}
            data-account-row=""
            data-account-id={account.id}
            data-current={isCurrent ? 'true' : 'false'}
            data-row-busy={working ? 'true' : undefined}
            data-row-queued={queued ? 'true' : undefined}
          >
            <div className={styles.accountRowText}>
              <div className={styles.accountRowHead}>
                <span className={styles.accountBadge}>
                  {isCurrent
                    ? t('channel.accounts.currentBadge')
                    : t('channel.accounts.alternativeBadge')}
                </span>
                <span className={styles.accountName} data-account-name="">
                  {account.displayName}
                </span>
                <span className={styles.accountMasked} data-account-masked="">
                  {account.maskedIdentifier}
                </span>
              </div>
              <div className={styles.accountStatusLine}>
                <span
                  className={styles.accountStatus}
                  data-account-status={account.status}
                >
                  {t(`channel.accounts.status.${account.status}`)}
                </span>
                {queued && (
                  <span className={styles.accountQueued} data-account-queued="">
                    {t('channel.accounts.queued')}
                  </span>
                )}
                {working && (
                  <span className={styles.accountQueued} data-account-busy="">
                    {t('channel.accounts.working')}
                  </span>
                )}
              </div>
            </div>
            <div className={styles.accountActions}>
              {!isCurrent && (
                <button
                  type="button"
                  className={styles.actionButton}
                  data-action="set-current"
                  data-account-id={account.id}
                  disabled={rowLocked}
                  onClick={() => { onSetCurrent(account.id) }}
                >
                  {t('channel.accounts.setCurrent')}
                </button>
              )}
              <button
                type="button"
                className={styles.actionButton}
                data-action="reauth-account"
                data-account-id={account.id}
                disabled={rowLocked}
                onClick={() => { onReauth(account.id) }}
              >
                {t('channel.accounts.reauth')}
              </button>
              <button
                type="button"
                className={`${styles.actionButton} ${styles.dangerButton}`}
                data-action="delete"
                data-account-id={account.id}
                disabled={rowLocked}
                onClick={() => { onDelete(account.id) }}
              >
                {t('channel.accounts.delete')}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}