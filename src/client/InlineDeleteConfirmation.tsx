/**
 * 删除账号的就地确认区（Task 14）。
 *
 * 删除当前账号时必须显式选择替代账号或“暂不指定”；默认“暂不指定”，
 * 由上层以 `replacementAccountId: null` 调用 Host，绝不自动递补。
 */
import * as React from 'react'

import type { AccountSummary } from '../shared/accounts.ts'
import styles from './styles/settings-card.module.css'

/** 删除确认区属性。 */
export interface InlineDeleteConfirmationProps {
  /** 要删除的账号。 */
  readonly account: AccountSummary
  /** 可显式选择的替代账号（不含被删除账号）。 */
  readonly alternatives: readonly AccountSummary[]
  /** 删除的是否为当前账号。 */
  readonly isCurrent: boolean
  /** 当前显式选择；null 表示“暂不指定”。 */
  readonly replacementAccountId: string | null
  /** 用户选择替代账号或“暂不指定”。 */
  readonly onSelectReplacement: (accountId: string | null) => void
  /** 用户确认删除。 */
  readonly onConfirm: () => void
  /** 用户取消删除。 */
  readonly onCancel: () => void
  /** 删除 RPC 在飞。 */
  readonly busy: boolean
  /** 删除操作已在顺序队列中等待。 */
  readonly queued?: boolean
  /** 搜索 OFF 等外部门控：锁确认与替代选择，取消仍可用。 */
  readonly locked?: boolean
  /** 翻译函数。 */
  readonly t: (key: string) => string
}

/**
 * 渲染删除确认区；不自动选择替代账号。
 * @param props - 目标账号、替代选项与回调。
 * @returns 就地确认区。
 */
export function InlineDeleteConfirmation({
  account,
  alternatives,
  isCurrent,
  replacementAccountId,
  onSelectReplacement,
  onConfirm,
  onCancel,
  busy,
  queued = false,
  locked = false,
  t,
}: InlineDeleteConfirmationProps): React.ReactElement {
  const groupName = `dsh-web-search-replace-${account.id}`
  return (
    <div
      className={styles.confirmBox}
      data-delete-confirmation=""
      role="group"
      aria-label={t('channel.accounts.deleteConfirmTitle')}
    >
      <span className={styles.confirmTitle}>
        {t('channel.accounts.deleteConfirmTitle')}
        {`: ${account.displayName}`}
      </span>
      <span className={styles.warning} data-delete-impact="">
        {isCurrent
          ? t('channel.accounts.deleteCurrentImpact')
          : t('channel.accounts.deleteOtherImpact')}
      </span>
      {isCurrent && (
        <div className={styles.choiceList} data-replacement-group="">
          <span className={styles.label}>{t('channel.accounts.replacementLabel')}</span>
          <label className={styles.choice}>
            <input
              type="radio"
              name={groupName}
              value=""
              data-replacement-option="none"
              checked={replacementAccountId === null}
              disabled={busy || locked}
              onChange={() => { onSelectReplacement(null) }}
            />
            <span>{t('channel.accounts.replacementNone')}</span>
          </label>
          {alternatives.map(alternative => (
            <label key={alternative.id} className={styles.choice}>
              <input
                type="radio"
                name={groupName}
                value={alternative.id}
                data-replacement-option={alternative.id}
                checked={replacementAccountId === alternative.id}
                disabled={busy || locked}
                onChange={() => { onSelectReplacement(alternative.id) }}
              />
              <span>{alternative.displayName}</span>
            </label>
          ))}
        </div>
      )}
      <div className={styles.confirmActions}>
        <button
          type="button"
          className={styles.dangerButton}
          data-action="confirm-delete"
          disabled={busy || queued || locked}
          onClick={onConfirm}
        >
          {t('channel.accounts.confirmDelete')}
        </button>
        <button
          type="button"
          className={styles.actionButton}
          data-action="cancel-delete"
          disabled={busy}
          onClick={onCancel}
        >
          {t('channel.accounts.cancel')}
        </button>
      </div>
    </div>
  )
}