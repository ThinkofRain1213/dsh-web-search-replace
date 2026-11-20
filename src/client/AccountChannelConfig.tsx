/**
 * 单一账号配置区（Task 14）：四渠道共用外壳，但每次只读取当前渠道。
 *
 * 所有操作（添加、重新登录、取消、删除确认、清除全部数据）都在渠道配置区内
 * 就地完成，不使用 Modal 或二级路由。控制器带 generation；组件卸载或正常渠道
 * 切换会 dispose 旧实例并停止本实例轮询。
 */
import * as React from 'react'

import type { ChannelId } from '../shared/channels.ts'
import { CHANNEL_IDS } from '../shared/channels.ts'
import type { ManagementRpcConnection } from '../shared/rpc.ts'
import { AccountList } from './AccountList.tsx'
import { InlineAuthFlow } from './InlineAuthFlow.tsx'
import { InlineDeleteConfirmation } from './InlineDeleteConfirmation.tsx'
import { AccountsController } from './controllers/accounts.ts'
import styles from './styles/settings-card.module.css'

/** 账号配置区属性。 */
export interface AccountChannelConfigProps {
  /** 当前 search.channel；同一时刻只服务一个渠道。 */
  readonly channel: ChannelId
  /** Connection 的共享 RPC 通道。 */
  readonly connection?: ManagementRpcConnection | undefined
  /** 翻译函数。 */
  readonly t: (key: string) => string
  /** Host 是否允许写入。 */
  readonly writable: boolean
  /** 授权 busy 变化通知；设置卡据此锁定主渠道下拉。 */
  readonly onAuthBusyChange?: ((busy: boolean) => void) | undefined
  /** 授权轮询间隔；测试可注入。 */
  readonly pollIntervalMs?: number | undefined
}

/**
 * 渲染当前渠道账号区。
 * @param props - 渠道、Connection、翻译、可写性与 busy 通知。
 * @returns 账号列表、内联授权/删除与清除全部入口。
 */
export function AccountChannelConfig({
  channel,
  connection,
  t,
  writable,
  onAuthBusyChange,
  pollIntervalMs,
}: AccountChannelConfigProps): React.ReactElement {
  const [controller] = React.useState(() => new AccountsController({
    channel,
    connection,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
  }))
  const state = React.useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  const [deletingAccountId, setDeletingAccountId] = React.useState<string | null>(null)
  const [replacementAccountId, setReplacementAccountId] = React.useState<string | null>(null)
  const [confirmingClear, setConfirmingClear] = React.useState(false)

  React.useEffect(() => {
    void controller.reload()
  }, [controller])

  React.useEffect(() => {
    onAuthBusyChange?.(state.authBusy)
  }, [onAuthBusyChange, state.authBusy])

  React.useEffect(() => () => {
    onAuthBusyChange?.(false)
    controller.dispose()
  }, [controller, onAuthBusyChange])

  const deletingAccount = deletingAccountId === null
    ? null
    : state.accounts.find(account => account.id === deletingAccountId) ?? null
  const reauthAccount = state.auth.targetAccountId === null
    ? null
    : state.accounts.find(account => account.id === state.auth.targetAccountId) ?? null
  const actionLocked = !writable
    || state.authBusy
    || state.refreshBusy
    || state.busyAccountId !== null
    || state.clearBusy
    || state.queue.length > 0
    || deletingAccountId !== null
    || confirmingClear

  const handleAdd = (): void => {
    setDeletingAccountId(null)
    setReplacementAccountId(null)
    setConfirmingClear(false)
    void controller.startAuth()
  }

  const handleReauth = (accountId: string): void => {
    setDeletingAccountId(null)
    setReplacementAccountId(null)
    setConfirmingClear(false)
    void controller.startAuth(accountId)
  }

  const handleDeleteRequest = (accountId: string): void => {
    setReplacementAccountId(null)
    setDeletingAccountId(accountId)
    setConfirmingClear(false)
  }

  const handleConfirmDelete = async (): Promise<void> => {
    if (deletingAccountId === null) return
    await controller.deleteAccount(deletingAccountId, replacementAccountId)
    const snapshot = controller.getSnapshot()
    if (snapshot.error === null && snapshot.busyAccountId === null) {
      setDeletingAccountId(null)
      setReplacementAccountId(null)
    }
  }

  const handleCancelDelete = (): void => {
    if (deletingAccountId === null) return
    if (controller.getSnapshot().busyAccountId === deletingAccountId) return
    controller.cancelQueuedDelete(deletingAccountId)
    setDeletingAccountId(null)
    setReplacementAccountId(null)
  }

  const handleConfirmClear = async (): Promise<void> => {
    await controller.clearAll()
    if (controller.getSnapshot().error === null) setConfirmingClear(false)
  }

  const hintState = state.status === 'loading'
    ? 'loading'
    : state.status === 'error'
      ? 'error'
      : state.current === null
        ? 'required'
        : 'selected'
  const hintText = state.status === 'loading'
    ? t('channel.accounts.loading')
    : state.status === 'error'
      ? ''
      : state.current !== null
        ? `${t('channel.account.current')}: ${state.current.displayName}`
        : state.accounts.length === 0
          ? t('channel.account.required')
          : t('channel.accounts.noCurrent')

  const channelNames = CHANNEL_IDS.map(id => t(`channel.${id}.name`)).join(
    t('channel.accounts.listSeparator'),
  )

  return (
    <div className={styles.accountConfig} data-account-config="" data-channel={channel}>
      <div className={styles.field} data-field="accounts">
        <div className={styles.fieldHead}>
          <span className={styles.fieldLabel}>{t('channel.account.label')}</span>
          <button
            type="button"
            className={styles.actionButton}
            data-action="add-account"
            disabled={actionLocked || state.status !== 'ready'}
            onClick={handleAdd}
          >
            {t('channel.accounts.add')}
          </button>
        </div>

        {state.error !== null && (
          <div className={styles.errorRow}>
            <span className={styles.error} role="alert" data-account-error="">
              {t(state.error)}
            </span>
            {state.status === 'error' && (
              <button
                type="button"
                className={styles.actionButton}
                data-action="retry-accounts"
                onClick={() => { void controller.reload() }}
              >
                {t('channel.accounts.retry')}
              </button>
            )}
          </div>
        )}

        <span className={styles.hintText} data-account-state={hintState}>
          {hintText}
        </span>

        {state.notice !== null && (
          <span className={styles.hintText} data-account-notice="">
            {t(state.notice)}
          </span>
        )}

        {state.auth.phase !== 'idle' && (
          <InlineAuthFlow
            auth={state.auth}
            accountName={reauthAccount?.displayName ?? null}
            t={t}
            onCancel={() => { void controller.cancelAuth() }}
            onDismiss={() => { controller.dismissAuth() }}
          />
        )}

        {state.accounts.length > 0 && (
          <AccountList
            accounts={state.accounts}
            current={state.current}
            busyAccountId={state.busyAccountId}
            queue={state.queue}
            locked={state.status !== 'ready'
              || state.authBusy
              || state.refreshBusy
              || deletingAccountId !== null
              || confirmingClear
              || state.clearBusy}
            writable={writable}
            t={t}
            onSetCurrent={(accountId) => { void controller.setCurrent(accountId) }}
            onReauth={handleReauth}
            onDelete={handleDeleteRequest}
          />
        )}

        {deletingAccount !== null && (
          <InlineDeleteConfirmation
            account={deletingAccount}
            alternatives={state.accounts.filter(account => account.id !== deletingAccount.id)}
            isCurrent={state.current?.id === deletingAccount.id}
            replacementAccountId={replacementAccountId}
            onSelectReplacement={setReplacementAccountId}
            onConfirm={() => { void handleConfirmDelete() }}
            onCancel={handleCancelDelete}
            busy={state.busyAccountId === deletingAccount.id}
            queued={state.status !== 'ready'
              || state.queue.some(operation => operation.accountId === deletingAccount.id)}
            t={t}
          />
        )}
      </div>

      <div className={styles.field} data-field="clear-accounts">
        <div className={styles.fieldHead}>
          <span className={styles.fieldLabel}>{t('channel.accounts.clearAll')}</span>
          <button
            type="button"
            className={`${styles.actionButton} ${styles.dangerButton}`}
            data-action="clear-all"
            disabled={actionLocked || state.status !== 'ready'}
            onClick={() => {
              setDeletingAccountId(null)
              setReplacementAccountId(null)
              setConfirmingClear(true)
            }}
          >
            {t('channel.accounts.clearAll')}
          </button>
        </div>
        {confirmingClear && (
          <div
            className={styles.confirmBox}
            data-clear-confirmation=""
            role="group"
            aria-label={t('channel.accounts.clearTitle')}
          >
            <span className={styles.confirmTitle}>{t('channel.accounts.clearTitle')}</span>
            <span className={styles.hintText} data-clear-impact="">
              {t('channel.accounts.clearImpactPrefix')}
              {channelNames}
              {t('channel.accounts.clearImpactSuffix')}
            </span>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.dangerButton}
                data-action="confirm-clear-all"
                disabled={state.clearBusy}
                onClick={() => { void handleConfirmClear() }}
              >
                {t('channel.accounts.confirmClear')}
              </button>
              <button
                type="button"
                className={styles.actionButton}
                data-action="cancel-clear-all"
                disabled={state.clearBusy}
                onClick={() => { setConfirmingClear(false) }}
              >
                {t('channel.accounts.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}