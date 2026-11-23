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
import { AccountsController, type AccountsState } from './controllers/accounts.ts'
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
  /** 搜索 OFF 时账号区灰化并禁用添加/设当前/重登/删除；清除全部仍可用。 */
  readonly gated?: boolean
  /** 兼容旧名；现在同样报告统一 interaction busy。 */
  readonly onAuthBusyChange?: ((busy: boolean) => void) | undefined
  /** 确认、授权/刷新、已接受队列/执行中的统一交互锁。 */
  readonly onInteractionBusyChange?: ((busy: boolean, channel: ChannelId) => void) | undefined
  /** 同渠道账号只读快照；仅供父级推导 §5.5，不复制为第二真源。 */
  readonly onAccountsStateChange?: ((state: AccountsState | null, channel: ChannelId) => void) | undefined
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
  gated = false,
  onAuthBusyChange,
  onInteractionBusyChange,
  onAccountsStateChange,
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

  const interactionBusy = state.authBusy
    || state.refreshBusy
    || state.busyAccountId !== null
    || state.clearBusy
    || state.queue.length > 0
    || deletingAccountId !== null
    || confirmingClear

  React.useEffect(() => {
    onInteractionBusyChange?.(interactionBusy, channel)
    onAuthBusyChange?.(interactionBusy)
  }, [channel, interactionBusy, onAuthBusyChange, onInteractionBusyChange])

  React.useEffect(() => {
    onAccountsStateChange?.(state, channel)
  }, [channel, onAccountsStateChange, state])

  React.useEffect(() => () => {
    onInteractionBusyChange?.(false, channel)
    onAuthBusyChange?.(false)
    onAccountsStateChange?.(null, channel)
    controller.dispose()
  }, [channel, controller, onAccountsStateChange, onAuthBusyChange, onInteractionBusyChange])

  const deletingAccount = deletingAccountId === null
    ? null
    : state.accounts.find(account => account.id === deletingAccountId) ?? null
  const reauthAccount = state.auth.targetAccountId === null
    ? null
    : state.accounts.find(account => account.id === state.auth.targetAccountId) ?? null
  // gated 只锁账号管理写操作；clear-all 与清除确认保持可用（R52）。
  const lockWithoutGate = !writable
    || state.authBusy
    || state.refreshBusy
    || state.busyAccountId !== null
    || state.clearBusy
    || state.queue.length > 0
    || deletingAccountId !== null
    || confirmingClear
  const actionLocked = lockWithoutGate || gated
  const clearLocked = lockWithoutGate

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
  // R53 收尾（用户视觉复核）：「当前账号」是账号字段头这一行的说明，不是列表上方
  // 的另一条 row。loading/required/selected/no-current 直接成为字段头的
  // rowDescription；error 只把状态放在字段头上，错误红字仍由 errorRow 承载。
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
  // 账号字段头本身是一条 row：rowTitle=账号，rowDescription=当前账号/状态说明，
  // 添加账号在右侧 badges。字段包装不再重复 field 的上下 12px，而是让字段头 row
  // 的 padding-top 12 接端点说明、padding-bottom 12 接首个账号行的 padding-top
  // 12，分别形成 24px。账号列表内部行结构完全交给 AccountList 原样渲染。
  const accountsFieldClass = gated
    ? `${styles.accountField} ${styles.fieldGated}`
    : styles.accountField
  const headRowClass = gated ? `${styles.row} ${styles.rowGated}` : styles.row
  const listRegionClass = gated
    ? `${styles.accountListRegion} ${styles.rowGated}`
    : styles.accountListRegion
  const offGated = gated ? 'true' : undefined

  return (
    <div className={styles.accountConfig} data-account-config="" data-channel={channel}>
      <div
        className={accountsFieldClass}
        data-field="accounts"
        data-off-gated={gated ? 'true' : undefined}
      >
        <div
          className={headRowClass}
          data-field-head=""
          data-account-state={hintState}
          data-off-gated={offGated}
        >
          <div className={styles.rowText}>
            <span className={styles.rowTitle} data-field-label="">{t('channel.account.label')}</span>
            {hintText !== '' && (
              <span className={styles.rowDescription} data-account-hint="">{hintText}</span>
            )}
          </div>
          <div className={styles.badges} data-field-actions="">
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
        </div>

        {state.error !== null && (
          <div className={styles.errorRow}>
            <p className={styles.error} role="alert" data-account-error="">
              {t(state.error)}
            </p>
            {state.status === 'error' && (
              <button
                type="button"
                className={styles.actionButton}
                data-action="retry-accounts"
                disabled={gated}
                onClick={() => { void controller.reload() }}
              >
                {t('channel.accounts.retry')}
              </button>
            )}
          </div>
        )}

        {state.notice !== null && (
          <p className={styles.hint} data-account-notice="">
            {t(state.notice)}
          </p>
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
      </div>

      {(state.accounts.length > 0 || deletingAccount !== null) && (
        <div
          className={listRegionClass}
          data-account-list-region=""
          data-off-gated={offGated}
        >
          {state.accounts.length > 0 && (
            <AccountList
              accounts={state.accounts}
              current={state.current}
              busyAccountId={state.busyAccountId}
              busyAction={state.busyAction}
              queue={state.queue}
              locked={state.status !== 'ready'
                || state.authBusy
                || state.refreshBusy
                || deletingAccountId !== null
                || confirmingClear
                || state.clearBusy
                || gated}
              writable={writable}
              t={t}
              onSetCurrent={(accountId) => { void controller.setCurrent(accountId) }}
              onReauth={handleReauth}
              onTest={(accountId) => { void controller.testAccount(accountId) }}
              onCancelTest={(accountId) => { controller.cancelTest(accountId) }}
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
              locked={gated}
              t={t}
            />
          )}
        </div>
      )}

      <div className={styles.field} data-field="clear-accounts">
        <div className={styles.head} data-field-head="">
          <div className={styles.labelGroup} data-label-group="">
            <span className={styles.label} data-field-label="">{t('channel.accounts.clearAll')}</span>
          </div>
          <div className={styles.badges} data-field-actions="">
            <button
              type="button"
              className={`${styles.actionButton} ${styles.dangerButton}`}
              data-action="clear-all"
              disabled={clearLocked || state.status !== 'ready'}
              onClick={() => {
                setDeletingAccountId(null)
                setReplacementAccountId(null)
                setConfirmingClear(true)
              }}
            >
              {t('channel.accounts.clearAll')}
            </button>
          </div>
        </div>
        {confirmingClear && (
          <div
            className={styles.confirmBox}
            data-clear-confirmation=""
            role="group"
            aria-label={t('channel.accounts.clearTitle')}
          >
            <span className={styles.confirmTitle}>{t('channel.accounts.clearTitle')}</span>
            <span className={styles.warning} data-clear-impact="">
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