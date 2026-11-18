/**
 * 「网页搜索渠道」设置卡的 0.1.0 骨架。
 *
 * 只渲染标题与「设置加载中」两行；`summary` 视图返回 null，因为 bundle 详情页
 * 的一行摘要由 locale 的 `meta.description` 负责，这里不重复。搜索开关、渠道
 * 下拉与账号区属于后续任务，骨架阶段不伪造。
 */

import * as React from 'react'

import styles from './styles/settings-card.module.css'

/** 设置卡收到的视图与翻译函数。 */
export interface SettingsCardProps {
  /** `summary` 只出现在官方插件卡片；bundle 配置只渲染 `page`。 */
  readonly view: 'summary' | 'page'
  /** 当前 locale 命名空间绑定出的翻译函数。 */
  readonly t: (key: string) => string
}

/**
 * @param props - 视图与翻译函数。
 * @returns 设置卡骨架，或 `summary` 视图下的 null。
 */
export function SettingsCard({ view, t }: SettingsCardProps): React.ReactElement | null {
  if (view !== 'page') return null

  return (
    <div className={styles.stack} data-dsh-web-search-channels="settings-card">
      <p className={styles.title}>{t('settings.title')}</p>
      <p className={styles.hint}>{t('settings.loading')}</p>
    </div>
  )
}
