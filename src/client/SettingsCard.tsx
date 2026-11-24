/**
 * 「Web Search Replacement」bundle 设置卡（`plugins.bundle.config`，key = 包名）。
 *
 * rc5 的 bundle 配置 slot 只传 `view: 'page'`，不传 `form`；因此这里通过
 * `configForms.get('dsh-web-search-replace')` 读取/订阅唯一设置快照，保存
 * 只走插件自己的 `settings.update` RPC。`summary` 视图返回 null，摘要由
 * locale 的 `meta.description` 负责。
 */
import * as React from 'react'

import { AccountChannelConfig } from './AccountChannelConfig.tsx'
import { ChannelConfigHost } from './ChannelConfigHost.tsx'
import { SearchSection } from './SearchSection.tsx'
import {
  SettingsController,
  type ConfigFormsLike,
} from './controllers/settings.ts'
import type { ManagementRpcConnection } from '../shared/rpc.ts'
import type { ChannelId } from '../shared/channels.ts'
import styles from './styles/settings-card.module.css'

/** 设置卡收到的视图、翻译函数与 Host 服务接缝。 */
export interface SettingsCardProps {
  /** `summary` 只出现在官方插件卡片；bundle 配置只渲染 `page`。 */
  readonly view: 'summary' | 'page'
  /** 当前 locale 命名空间绑定出的翻译函数。 */
  readonly t: (key: string) => string
  /** Host 的 configForms 服务；bundle slot 不提供 form，必须自己读取。 */
  readonly configForms?: ConfigFormsLike | undefined
  /** Connection 的共享 RPC 通道，用于 settings.update。 */
  readonly connection?: ManagementRpcConnection | undefined
}

/**
 * @param props - 视图、翻译函数与 Host 服务。
 * @returns 设置卡，或 `summary` 视图下的 null。
 */
export function SettingsCard({
  view,
  t,
  configForms,
  connection,
}: SettingsCardProps): React.ReactElement | null {
  const [controller] = React.useState(
    () => new SettingsController({ configForms, connection }),
  )
  const [interaction, setInteraction] = React.useState<{ readonly channel: ChannelId; readonly busy: boolean } | null>(null)
  React.useEffect(() => { controller.setView(view) }, [controller, view])
  React.useEffect(() => () => { controller.dispose() }, [controller])
  const state = React.useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  const onInteractionBusyChange = React.useCallback((busy: boolean, channel: ChannelId) => {
    setInteraction((previous) => {
      if (!busy && previous?.channel !== channel) return previous
      return { channel, busy }
    })
  }, [])
  const interactionBusy = interaction?.channel === state.channel && interaction.busy

  if (view !== 'page') return null

  const body = state.status === 'ready' && state.settings !== null
    ? (
      <>
        <SearchSection
          enabled={state.enabled}
          channel={state.channel}
          busy={state.busy || interactionBusy}
          interactionBusy={interactionBusy}
          writable={state.writable}
          error={state.errorScope === 'endpoint' ? null : state.error}
          t={t}
          onToggle={(next) => { void controller.setEnabled(next) }}
          onSelectChannel={(next) => { void controller.selectChannel(next) }}
        />
        <div className={styles.rule} role="separator" aria-orientation="horizontal" />
        <ChannelConfigHost
          channel={state.viewChannel}
          currentAccountId={state.settings[state.viewChannel].currentAccountId}
          t={t}
          gated={!state.enabled}
          endpointPreference={state.settings.qoder.endpointPreference}
          actualEndpointHost={state.actualEndpointHost}
          endpointBusy={state.busy}
          endpointWritable={state.writable}
          endpointError={state.errorScope === 'endpoint' ? state.error : null}
          onEndpointPreferenceChange={(next) => { void controller.setEndpointPreference(next) }}
        >
          <AccountChannelConfig
            key={state.viewChannel}
            channel={state.viewChannel}
            connection={connection}
            t={t}
            writable={state.writable}
            gated={!state.enabled}
            onInteractionBusyChange={onInteractionBusyChange}
          />
        </ChannelConfigHost>
      </>
    )
    : state.status === 'unavailable'
      ? (
        <section className={styles.section} data-settings-status="unavailable">
          <h3 className={styles.heading}>{t('settings.title')}</h3>
          <div className={styles.row} data-settings-status="unavailable">
            <div className={styles.rowText}>
              <p className={styles.error} role="alert">{t('settings.unavailable')}</p>
            </div>
          </div>
        </section>
      )
      : (
        <section className={styles.section} data-settings-status="loading">
          <h3 className={styles.heading}>{t('settings.title')}</h3>
          <div className={styles.row} data-settings-status="loading">
            <div className={styles.rowText}>
              <p className={styles.hint}>{t('settings.loading')}</p>
            </div>
          </div>
        </section>
      )

  return (
    <div
      className={styles.stack}
      data-dsh-web-search-replace="settings-card"
      data-settings-status={state.status}
      aria-busy={state.busy || undefined}
    >
      {body}
    </div>
  )
}
