/**
 * 中英文可见文案。
 *
 * 所有 label、说明、状态和错误都从这里读取；渠道名称也按渠道 id 分开，
 * 避免把共享注册表的 `displayName`（仅用于 Host/日志）当成 locale 文案。
 */
export const zh: Record<string, string> = {
  'settings.title': '网页搜索渠道',
  'settings.loading': '设置加载中',
  'settings.unavailable': '设置不可用',
  'settings.saveFailed': '保存失败，已恢复原设置',

  'search.enabled.label': '启用网页搜索',
  'search.enabled.description': '开启后使用所选渠道执行网页搜索。',
  'search.channel.label': '搜索渠道',
  'search.channel.description': '选择执行网页搜索的渠道。',
  'search.channel.lockedHint': '开启网页搜索后可切换渠道。',

  'channel.buddy.name': 'CodeBuddy',
  'channel.buddy.description': '通过 CodeBuddy 账号执行网页搜索。',
  'channel.workbuddy.name': 'WorkBuddy',
  'channel.workbuddy.description': '通过 WorkBuddy 账号执行网页搜索。',
  'channel.qoder.name': 'Qoder 国际版',
  'channel.qoder.description': '通过 Qoder 国际版账号执行网页搜索，仅支持搜索。',
  'channel.qodercn.name': 'Qoder 中国版',
  'channel.qodercn.description': '通过 Qoder 中国版账号执行网页搜索，仅支持搜索。',

  'channel.account.label': '账号',
  'channel.account.required': '需要账号：请先添加此渠道账号。',
  'channel.account.current': '当前账号',
}

export const en: Record<string, string> = {
  'settings.title': 'Web search channels',
  'settings.loading': 'Loading settings',
  'settings.unavailable': 'Settings are unavailable',
  'settings.saveFailed': 'Save failed; the previous settings were restored',

  'search.enabled.label': 'Enable web search',
  'search.enabled.description': 'Run web search with the selected channel.',
  'search.channel.label': 'Search channel',
  'search.channel.description': 'Choose the channel that runs web search.',
  'search.channel.lockedHint': 'Enable web search to change the channel.',

  'channel.buddy.name': 'CodeBuddy',
  'channel.buddy.description': 'Run web search with a CodeBuddy account.',
  'channel.workbuddy.name': 'WorkBuddy',
  'channel.workbuddy.description': 'Run web search with a WorkBuddy account.',
  'channel.qoder.name': 'Qoder International',
  'channel.qoder.description': 'Run web search with a Qoder international account; search only.',
  'channel.qodercn.name': 'Qoder China',
  'channel.qodercn.description': 'Run web search with a Qoder China account; search only.',

  'channel.account.label': 'Account',
  'channel.account.required': 'Account required: add an account for this channel before use.',
  'channel.account.current': 'Current account',
}
