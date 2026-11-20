/**
 * 搜索设置区：启用开关与渠道下拉。
 *
 * 开关与下拉都从同一 `search.enabled/channel` 状态派生；OFF 时渠道下拉
 * 禁用并灰化但保留当前值，配置区不受这里门控。渠道选项顺序来自共享
 * `CHANNEL_IDS`，可见名称来自 locale。
 */
import * as React from 'react'

import { CHANNEL_IDS, type ChannelId } from '../shared/channels.ts'
import type { SettingsErrorKey } from './controllers/settings.ts'
import type { SearchStatusView } from './search-status.ts'
import { Dropdown } from './components/Dropdown.tsx'
import { Switch } from './components/Switch.tsx'
import styles from './styles/settings-card.module.css'

/** 搜索区属性。 */
export interface SearchSectionProps {
  /** 当前搜索开关。 */
  readonly enabled: boolean
  /** 当前渠道，也是唯一配置区真源。 */
  readonly channel: ChannelId
  /** 是否有写入在飞或账号交互锁定。 */
  readonly busy: boolean
  /** 删除确认、授权/刷新或已接受队列等统一交互锁。 */
  readonly interactionBusy: boolean
  /** 同渠道 settings + account/status 推导出的 §5.5 状态。 */
  readonly status: SearchStatusView
  /** Host 是否允许写入。 */
  readonly writable: boolean
  /** 最近一次保存失败的本地化键。 */
  readonly error: SettingsErrorKey | null
  /** 翻译函数。 */
  readonly t: (key: string) => string
  /** 请求切换搜索开关。 */
  readonly onToggle: (next: boolean) => void
  /** 请求切换渠道。 */
  readonly onSelectChannel: (next: ChannelId) => void
}

/**
 * 渲染搜索 section。
 * @param props - 状态、翻译与回调。
 * @returns 搜索标题、开关行与渠道行。
 */
export function SearchSection({
  enabled,
  channel,
  busy,
  interactionBusy,
  status,
  writable,
  error,
  t,
  onToggle,
  onSelectChannel,
}: SearchSectionProps): React.ReactElement {
  const headingId = React.useId()
  const channelLabelId = React.useId()
  const gated = !enabled
  const locked = !writable || busy
  const channelLocked = gated || locked
  const label = t('search.enabled.label')
  const items = CHANNEL_IDS.map(id => ({ id, label: t(`channel.${id}.name`) }))
  const selectedLabel = t(`channel.${channel}.name`)
  const statusText = status.kind === 'ready' && status.account !== undefined
    ? `${t('search.status.ready')}：${selectedLabel} / ${status.account.displayName}`
      + `（${status.account.maskedIdentifier} · ${t(`channel.accounts.status.${status.account.status}`)}）`
    : t(`search.status.${status.kind}`)

  return (
    <section
      className={styles.section}
      aria-labelledby={headingId}
      aria-busy={busy || undefined}
      data-search-section=""
      data-enabled={enabled ? 'true' : 'false'}
    >
      <h3 id={headingId} className={styles.heading}>{t('settings.title')}</h3>

      <div className={styles.row} data-search-status={status.kind} aria-live="polite">
        <div className={styles.rowText}>
          <span className={styles.rowDescription}>{statusText}</span>
        </div>
      </div>

      <div className={styles.row} data-row="enabled">
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>{label}</span>
          <span className={styles.rowDescription}>{t('search.enabled.description')}</span>
        </div>
        <Switch
          checked={enabled}
          onChange={(next) => { onToggle(next) }}
          label={label}
          disabled={locked}
        />
      </div>

      <div
        className={`${styles.row}${gated ? ` ${styles.rowGated}` : ''}`}
        data-row="channel"
        data-gated={gated ? 'true' : undefined}
      >
        <div className={styles.rowText}>
          <span id={channelLabelId} className={styles.rowTitle}>{t('search.channel.label')}</span>
          <span className={styles.rowDescription}>{t('search.channel.description')}</span>
          {gated && (
            <span className={styles.rowDescription}>{t('search.channel.lockedHint')}</span>
          )}
          {interactionBusy && (
            <span className={styles.rowDescription} data-interaction-busy-hint="">
              {t('search.channel.interactionLockedHint')}
            </span>
          )}
          {error !== null && (
            <span className={styles.error} role="alert" data-error="settings-save-failed">
              {t(error)}
            </span>
          )}
        </div>
        <Dropdown
          items={items}
          selectedId={channel}
          valueLabel={selectedLabel}
          onSelect={(id) => { onSelectChannel(id as ChannelId) }}
          disabled={channelLocked}
          labelledBy={channelLabelId}
          label={t('search.channel.label')}
        />
      </div>
    </section>
  )
}
