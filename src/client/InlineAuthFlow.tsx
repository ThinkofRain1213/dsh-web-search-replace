/**
 * 内联授权流程（Task 14）。
 *
 * 状态与错误只按固定 phase/errorCode 从 locale 映射，绝不直接渲染 Host 可能只有
 * 一种语言的 `displayHint`。授权链接只做只读展示与复制，不自动打开、不持久化；
 * 复制不可用时降级为选中链接文本，由用户手动复制。
 */
import * as React from 'react'

import type { AccountsAuthView, AccountsAuthPhase } from './controllers/accounts.ts'
import styles from './styles/settings-card.module.css'

/** 授权状态文案映射的键。 */
type AuthStatusKey =
  | 'channel.auth.starting'
  | 'channel.auth.waiting'
  | 'channel.auth.cancelling'
  | 'channel.auth.completed'
  | 'channel.auth.failed'
  | 'channel.auth.cancelled'
  | 'channel.auth.timedOut'

/** 复制反馈状态。 */
type CopyState = 'idle' | 'copied' | 'failed'

/** 内联授权流程属性。 */
export interface InlineAuthFlowProps {
  /** 当前授权流程的脱敏视图。 */
  readonly auth: AccountsAuthView
  /** 重登目标账号显示名；添加账号时为 null。 */
  readonly accountName: string | null
  /** 翻译函数。 */
  readonly t: (key: string) => string
  /** 用户取消等待中的授权。 */
  readonly onCancel: () => void
  /** 用户关闭终态授权提示。 */
  readonly onDismiss: () => void
}

/**
 * 把失败状态映射为固定错误码文案；未知码回退到通用失败文案。
 * @param auth - 授权视图。
 * @param t - 翻译函数。
 * @returns 本地化状态文本。
 */
function authStatusText(auth: AccountsAuthView, t: (key: string) => string): string {
  if (auth.phase === 'idle') return ''
  if (auth.phase === 'failed') {
    if (auth.errorCode !== null) {
      const key = `channel.auth.error.${auth.errorCode}`
      const translated = t(key)
      return translated === key ? t('channel.auth.failed') : translated
    }
    return t('channel.auth.failed')
  }
  const keys: Record<Exclude<AccountsAuthPhase, 'idle' | 'failed'>, AuthStatusKey> = {
    starting: 'channel.auth.starting',
    pending: 'channel.auth.waiting',
    cancelling: 'channel.auth.cancelling',
    completed: 'channel.auth.completed',
    cancelled: 'channel.auth.cancelled',
    timed_out: 'channel.auth.timedOut',
  }
  return t(keys[auth.phase])
}

/**
 * 渲染内联授权状态、只读授权链接与复制/取消/关闭操作。
 * @param props - 授权视图、重登账号显示名、翻译与回调。
 * @returns 位于当前渠道区内的授权流程区。
 */
export function InlineAuthFlow({
  auth,
  accountName,
  t,
  onCancel,
  onDismiss,
}: InlineAuthFlowProps): React.ReactElement {
  const failed = auth.phase === 'failed' || auth.phase === 'timed_out'
  const statusText = authStatusText(auth, t)
  const urlRef = React.useRef<HTMLElement>(null)
  const [copyState, setCopyState] = React.useState<CopyState>('idle')

  // 链接变化或流程进入终态时重置复制反馈，避免旧提示挂在新流程上。
  React.useEffect(() => {
    setCopyState('idle')
  }, [auth.authUrl])

  /** 复制链接；剪贴板不可用时选中链接文本作为降级。 */
  const handleCopy = async (): Promise<void> => {
    const url = auth.authUrl
    if (url === null) return
    try {
      if (navigator.clipboard === undefined
        || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('clipboard unavailable')
      }
      await navigator.clipboard.writeText(url)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
      try {
        const node = urlRef.current
        const selection = window.getSelection()
        if (node !== null && selection !== null) selection.selectAllChildren(node)
      } catch {
        // 选择文本只是降级辅助；失败仍保留只读链接供手动复制。
      }
    }
  }

  const terminal = auth.phase === 'completed'
    || auth.phase === 'failed'
    || auth.phase === 'cancelled'
    || auth.phase === 'timed_out'

  return (
    <div
      className={styles.authFlow}
      data-inline-auth=""
      data-auth-phase={auth.phase}
      aria-live="polite"
    >
      <span className={styles.fieldLabel}>
        {auth.targetAccountId === null
          ? t('channel.auth.addTitle')
          : t('channel.auth.reauthTitle')}
        {accountName === null ? null : `: ${accountName}`}
      </span>
      <span
        className={failed ? styles.error : styles.hintText}
        role={failed ? 'alert' : undefined}
        data-auth-status=""
      >
        {statusText}
      </span>
      {auth.phase === 'pending' && auth.authUrl !== null && (
        <>
          <span className={styles.hintText} data-auth-instruction="">
            {t('channel.auth.instruction')}
          </span>
          <code ref={urlRef} className={styles.authUrl} data-auth-url="">{auth.authUrl}</code>
          <span className={styles.hintText} data-copy-state={copyState}>
            {copyState === 'copied'
              ? t('channel.auth.copied')
              : copyState === 'failed'
                ? t('channel.auth.copyFailed')
                : ''}
          </span>
        </>
      )}
      <div className={styles.confirmActions}>
        {auth.phase === 'pending' && auth.authUrl !== null && (
          <button
            type="button"
            className={styles.actionButton}
            data-action="copy-auth"
            onClick={() => { void handleCopy() }}
          >
            {t('channel.auth.copy')}
          </button>
        )}
        {(auth.phase === 'starting' || auth.phase === 'pending' || auth.phase === 'cancelling') && (
          <button
            type="button"
            className={styles.actionButton}
            data-action="cancel-auth"
            disabled={auth.phase !== 'pending'}
            onClick={onCancel}
          >
            {t('channel.auth.cancel')}
          </button>
        )}
        {terminal && (
          <button
            type="button"
            className={styles.actionButton}
            data-action="dismiss-auth"
            onClick={onDismiss}
          >
            {t('channel.auth.dismiss')}
          </button>
        )}
      </div>
    </div>
  )
}