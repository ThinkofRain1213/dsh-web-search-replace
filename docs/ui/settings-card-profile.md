# 0.1.0 设置卡完整剖面（SearchSection / ChannelConfigHost / 账号 / 端点行）

> 目标与源码证据：DSH `0.2.2-rc.5`。
> 本文件直接依据完整 UI 规范与 rc5 官方源码审计维护，不使用二手摘要。
> 当前自动化证据是静态源码与 jsdom 真实 React DOM 测试；**不宣称真实浏览器计算样式、明暗主题、live Inspect 或实际 portal 位置已验收**。

## 1. 唯一真源与不可变业务 IA

设置卡只认一个 `search.channel`：下拉值、配置区标题、账号区与端点行都由它派生；同一时刻只渲染一个 `ChannelConfigHost`，不存在第二渠道查看选择器。`OFF` 时渠道下拉用 `lockedHint` 替换原说明（不追加第三行）并整行灰化；下方 `ChannelConfigHost` 得到 `gated`，标题、说明、固定端点、Qoder 端点偏好与账号区整体灰化只读，添加/设当前/重登/删除/重试与端点修改都禁用；仅「清除全部账号数据」及其就地确认保留可用。OFF 不取消已经开始的授权/RPC 请求。

页面结构保持 `SearchSection + 独立 rule + 单一 ChannelConfigHost`。`AccountChannelConfig（Task 14）` 通过 children 进入唯一账号 slot；`QoderEndpointRow（Task 14）` 只在 qoder 出现。不得新增第二渠道选择器，不改变 controllers、RPC、凭据、保存、账号安全与 Host 服务注入。

## 2. 完整剖面（从 `.stack` 顶到底，一张图）

```text
╔══════════════════════════════════════════════════════════════════════════════╗
║ div.stack[data-dsh-web-search-channels="settings-card"] padding:0 gap:0     ║
╚══════════════════════════════════════════════════════════════════════════════╝
┌─ 互斥分支 state.status="loading"：section.section padding:16px 0 ──────────┐
│ ┆ .section ▸ padding-top ··········································· 16px │
│ h3.heading「网页搜索渠道」 margin: 0 font:13/600 line-height:1.5             │
│ ┆ .row[data-settings-status="loading"] ▸ padding-top ··············· 12px │
│ div.rowText padding-right:48px gap:6 › p.hint「设置加载中」 margin: 0       │
│ ┆ .row ▸ padding-bottom ··········································· 12px │
│ ┆ .section > .row:last-child ▸ margin-bottom ······················ −12px │
│ ┆ .section ▸ padding-bottom ······································· 16px │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ 互斥分支 state.status="unavailable"：section.section padding:16px 0 ──────┐
│ ┆ .section ▸ padding-top ··········································· 16px │
│ h3.heading「网页搜索渠道」 margin: 0 font:13/600 line-height:1.5             │
│ ┆ .row[data-settings-status="unavailable"] ▸ padding-top ··········· 12px │
│ div.rowText padding-right:48px gap:6 › p.error[role=alert] margin: 0        │
│ ┆ .row ▸ padding-bottom ··········································· 12px │
│ ┆ .section > .row:last-child ▸ margin-bottom ······················ −12px │
│ ┆ .section ▸ padding-bottom ······································· 16px │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ 互斥分支 state.status="ready"：section[data-search-section] padding:16px 0 ┐
│ ┆ .section ▸ padding-top ··········································· 16px │
│ h3.heading「网页搜索渠道」 margin: 0 font:13/600 line-height:1.5             │
│ ┆ .heading ▸ margin-bottom ········································· 0px │
│ ┆ .row[data-search-status] ▸ padding-top ··························· 12px │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ div.rowText flex:1 padding-right:48px gap:6                             │ │
│ │ span.rowDescription「搜索运行状态」 font:12/400 line-height:18px        │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ ┆ 上一 row padding-bottom 12px ＋ 下一 row padding-top 12px ········ 24px │
│ ┌─ div.row[data-row="enabled"] padding:12px 0 gap:8 ─────────────────────┐ │
│ │ div.rowText flex:1 padding-right:48px gap:6                             │ │
│ │ span.rowTitle「启用网页搜索」 13/500/19.5                              │ │
│ │ span.rowDescription「开启后使用所选渠道执行网页搜索。」 12/400/18       │ │
│ │ button[role=switch] 36 × 20 padding:2 border-radius:999                  │ │
│ │ span.thumb 16×16 translateX(16px) transition:transform 120ms ease      │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ ┆ 上一 row padding-bottom 12px ＋ 下一 row padding-top 12px ········ 24px │
│ ┌─ div.row[data-row="channel"] padding:12px 0 gap:8 ─────────────────────┐ │
│ │ div.rowText flex:1 padding-right:48px gap:6                             │ │
│ │ span.rowTitle「搜索渠道」 13/500/19.5                                  │ │
│ │ span.rowDescription「搜索渠道说明」 12/400/18                           │ │
│ │ span.rowDescription 条件 OFF：lockedHint 替换原说明，不追加第三行      │ │
│ │ 条件 interactionBusy：span.rowDescription「请先完成或取消当前操作。」  │ │
│ │ 条件 settings error：span.error[role=alert] margin: 0，红色不灰化        │ │
│ │ span.menuRoot padding:0 anchor-name:--dsh-web-search-channels-menu-trigger-*               │ │
│ │ button.selector height:34px padding:0 12px gap:12 radius-md border:none bg-module-platform │ │
│ │ span.selectorLabel → svg.chevron 14px aria-hidden                      │ │
│ │ 条件 open：body 下 portal A = div.menuSurface，逻辑归属 trigger，不占 stack │ │
│ │   padding:4 border:0 radius-lg elevation-prominent z-index:1100        │ │
│ │   min-width:min(144px,100vw-24px) max-width:min(360px,100vw-24px)      │ │
│ │   width:max-content positionAnchor 与 trigger anchor-name 相同         │ │
│ │   data-match-anchor-width min-width:min(anchor-size(width),100vw-24px) │ │
│ │   position-try-fallbacks + viewport overflow-y:auto                    │ │
│ │   div.menuMaterial padding:0 → div.menuViewport padding:0 → MenuRow    │ │
│ │   button.menuItem min-height:34px padding:6px 8px gap:6 font:13/20     │ │
│ │   span.menuItemLabel flex:1 → 仅 selected+check 时 trailing svg.menuCheck 14×14 │ │
│ │   selected+check background:transparent；selection=fill 才用 selectedFill │ │
│ │   focus-visible background hover + outline:none；disabled opacity:.4   │ │
│ │ 条件 open：body 下独立 portal B = div.menuBacking[data-menu-backing]   │ │
│ │   padding:0 radius-lg，与 surface 同 anchor/phase；非 darwin display:none │ │
│ │   darwin 才固定定位绘制 bg-base；不进 stack，也不是 surface 的 border  │ │
│ │ 条件 contextual：surface+backing data-menu-phase=enter/dismiss/replace │ │
│ │   reduced-motion 时 phase animation-duration:0ms；标准 Dropdown 无 phase │ │
│ │ 条件 entry.submenu：独立 menuSubmenu portal，side/page 只选一种布局    │ │
│ │   ArrowRight 进入、Escape/ArrowLeft 先回父菜单，第二次 Escape 才关闭   │ │
│ │ 条件 anchor 祖先 inert/hidden 或 trigger 失联：MutationObserver 关闭   │ │
│ │ 条件 Host modal 在前台：isBehindModal 阻止幕后方向键/Tab/Escape       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ ┆ .row[data-row="channel"] ▸ padding-bottom ······················· 12px │
│ ┆ .section > .row:last-child ▸ margin-bottom ······················ −12px │
│ ┆ .section ▸ padding-bottom ······································· 16px │
└─────────────────────────────────────────────────────────────────────────────┘
                              ┆ 内容到线 = 12 − 12 + 16 = 16px
 ═════════════════════════════ div.rule[role="separator"] border-top:0.5px margin: 0
                              ┆ 线到下一标题 = 16 + 0 = 16px
┌─ section[data-channel-config-host][data-channel=唯一 search.channel] padding:16px 0 ┐
│ 条件 OFF：section 挂 .channelGated + data-off-gated=true；下方配置区整体灰化只读 │
│ ┆ .section ▸ padding-top ··········································· 16px │
│ h3.heading「当前渠道名」 margin: 0 font:13/600 line-height:1.5              │
│ ┆ .heading ▸ margin-bottom ········································· 0px │
│ ┌─ div.row[data-channel-description] padding:12px 0 gap:8 ────────────────┐ │
│ │ div.rowText flex:1 padding-right:48px gap:6                             │ │
│ │ span.rowDescription「当前渠道说明」 12/400/18                           │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ ┆ .row[data-channel-description] ▸ padding-bottom ················· 12px │
│ ┄ 条件 channel="qoder"：div.fieldSlot[data-qoder-endpoint-slot] ▸ padding · 0px ┄
│ 条件 OFF：QoderEndpointRow 挂 .fieldGated + data-off-gated=true；下拉禁用，hint 灰化 │
│ ┌─ QoderEndpointRow（Task 14）div.field ▸ padding · 12px 0；gap:6px ────────────┐ │
│ │ ┆ .field ▸ padding-top ········································· 12px │
│ │ div.head padding:0 gap:8                                                │ │
│ │   div.labelGroup flex:1 min-width:0 padding:0 gap:4                     │ │
│ │   label.label[for=qoder endpoint trigger] flex:0 1 auto 13/500/1.5      │ │
│ │ ┆ .field ▸ gap ················································· 6px │
│ │ div.fieldControl padding:0 › span.menuRoot padding:0；同时持有官方与 settings 类 │ │
│ │ button.selector 34px / 0 12px border:none bg-module-platform；仅 auto/center/api2 │ │
│ │ .fieldControl > .menuRoot 与 width:100% 命中同一最终 DOM；SearchSection 不附加该类 │ │
│ │ 条件 open：body 下 portal menuSurface，结构与搜索渠道菜单完全相同       │ │
│ │ ┆ .field ▸ gap ················································· 6px │
│ │ p.hint[data-endpoint-status] margin: 0 font:12/400 line-height:1.5       │ │
│ │ 条件 auto 且无观测：尚无运行观测；auto 有观测：实际 host；fixed：所选域 │ │
│ │ 所有分支 statusText 均为纯字符串；data-actual/selected-host 在 p 上，无 code │ │
│ │ ┆ .field ▸ gap ················································· 6px │
│ │ p.hint「仅支持搜索，不支持服务端网页抓取。」 margin: 0                  │ │
│ │ 条件 endpoint error：p.error[data-endpoint-error][role=alert] margin: 0 │ │
│ │ ┆ .field ▸ padding-bottom ······································· 12px │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ ┄ 条件 channel≠"qoder"：div.fieldSlot[data-fixed-endpoint-slot] ▸ padding · 0px ┄
│ ┌─ div.field[data-field="endpoint"] padding:12px 0 gap:6 ────────────────┐ │
│ │ 条件 OFF：.fieldGated + data-off-gated=true；固定域与 hint 灰化，无控件 │ │
│ │ ┆ .field ▸ padding-top ········································· 12px │
│ │ div.head padding:0 gap:8 › div.labelGroup flex:1 padding:0 gap:4        │ │
│ │ span.label「搜索端点」 13/500/1.5；无按钮、无下拉                       │ │
│ │ ┆ .field ▸ gap ················································· 6px │
│ │ span.fieldValue[data-fixed-endpoint] 13/400/1.5 overflow-wrap:anywhere │ │
│ │ ┆ .field ▸ gap ················································· 6px │
│ │ p.hint「此渠道固定使用该域名，没有端点下拉。」 margin: 0                │ │
│ │ ┆ .field ▸ padding-bottom ······································· 12px │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ ┆ 端点 field padding-bottom 12 ＋ 账号 field padding-top 12 ········ 24px │
│ ┄ div.fieldSlot ▸ padding · 0px；[data-account-config-slot] ┄                       │
│ ┌─ 条件传入真实 children：div.accountConfig[AccountChannelConfig（Task 14）] padding:0 gap:0 ┐ │
│ │ ┌─ div.field[data-field="accounts"] padding:12px 0 gap:6 ─────────────┐ │
│ │ │ 条件 OFF：.fieldGated + data-off-gated=true；添加/设当前/重登/删除/重试禁用 │ │
│ │ │ ┆ .field ▸ padding-top ······································ 12px │ │
│ │ │ div.head padding:0 gap:8 › div.labelGroup flex:1 padding:0 gap:4     │ │
│ │ │ span.label「账号」 13/500/1.5                                        │ │
│ │ │ div.badges padding:0 gap:8 › button.small.outline[添加账号] 28px     │ │
│ │ │ ┆ .field ▸ gap ············································· 6px │ │
│ │ │ 条件 account error：div.errorRow padding:0 gap:8                    │ │
│ │ │   p.error[role=alert] flex:1 + 条件读取失败时 button[重试]       │ │
│ │ │ ┆ .field ▸ gap ············································· 6px │ │
│ │ │ p.hint[data-account-state] margin: 0；loading/required/selected/     │ │
│ │ │ no-current/error 各状态不伪造 ready                                  │ │
│ │ │ 条件 notice：p.hint[data-account-notice] margin: 0                    │ │
│ │ │ ┆ .field ▸ gap ············································· 6px │ │
│ │ │ 条件 auth.phase≠idle：div.authFlow padding:0 gap:6                  │ │
│ │ │   span.label「添加账号/重新登录账号」 13/500/1.5                    │ │
│ │ │   p.hint 或 p.error[data-auth-status] margin: 0                      │ │
│ │ │   条件 pending+authUrl：p.hint[data-auth-instruction] margin: 0      │ │
│ │ │   code.authUrl display:block padding:12px border:0.5px solid l2     │ │
│ │ │     radius-lg bg-base code-font 12/18 pre-wrap anywhere             │ │
│ │ │   p.hint[data-copy-state] margin: 0 font:12/400/18                     │ │
│ │ │   div.confirmActions padding:0 gap:8 [复制/取消/关闭]               │ │
│ │ │ ┆ .field ▸ gap ············································· 6px │ │
│ │ │ 条件 accounts.length>0：div.accountList padding:0 gap:0             │ │
│ │ │ ┆ 前一 field 孩子与 accountList 的父 field gap ··············· 6px │ │
│ │ │   首 div.accountRow:first-child padding-top:0，不再形成 6+12=18px  │ │
│ │ │   每个账号 div.accountRow 基础 padding:12px 0 gap:8                │ │
│ │ │     div.accountRowText flex:1 padding:0 gap:6                       │ │
│ │ │       div.accountRowHead padding:0 gap:8 + Tag + 显示名 + 脱敏标识  │ │
│ │ │       div.accountStatusLine padding:0 gap:8 + 状态/排队/处理中      │ │
│ │ │     div.accountActions flex:none padding:0 gap:8                    │ │
│ │ │       [设为当前使用] 仅备选 + [重新登录] + [删除]                   │ │
│ │ │   相邻账号间：.accountRow + .accountRow border-top:0.5px margin:0  │ │
│ │ │   相邻账号内容间距 = 前行 padding-bottom 12 + 后行 padding-top 12 = 24px │ │
│ │ │   末 div.accountRow:last-child padding-bottom:0，不再形成 12+12+12=36px │ │
│ │ │ 条件 deletingAccount：div.confirmBox padding:0 gap:6                │ │
│ │ │   span.confirmTitle「确认删除账号」 13/500/19.5                     │ │
│ │ │   span.warning[data-delete-impact] state-warn-primary 12/400/18     │ │
│ │ │   条件 isCurrent：div.choiceList padding:0 gap:6                    │ │
│ │ │     label.choice gap:6 radio + 替代账号；默认“暂不指定”             │ │
│ │ │   div.confirmActions padding:0 gap:8 [确认删除/取消]                │ │
│ │ │ ┆ .field[data-field="accounts"] ▸ padding-bottom ············· 12px │ │
│ │ └─────────────────────────────────────────────────────────────────────┘ │
│ │ ┆ 账号 field padding-bottom 12 ＋ 清除 field padding-top 12 ····· 24px │
│ │ ┌─ div.field[data-field="clear-accounts"] padding:12px 0 gap:6 ───────┐ │
│ │ │ 条件 OFF：不挂 .fieldGated；清除全部账号数据与确认/取消仍可用、可辨识 │ │
│ │ │ ┆ .field ▸ padding-top ······································ 12px │ │
│ │ │ div.head padding:0 gap:8 › div.labelGroup flex:1 padding:0 gap:4     │ │
│ │ │ span.label「清除全部账号数据」 + div.badges padding:0 [清除按钮]    │ │
│ │ │ 条件 confirmingClear：div.confirmBox padding:0 gap:6                │ │
│ │ │   span.confirmTitle「确认清除全部账号数据」                         │ │
│ │ │   span.warning[data-clear-impact] state-warn-primary，列出四渠道    │ │
│ │ │   div.confirmActions padding:0 gap:8 [确认清除/取消]                │ │
│ │ │ ┆ .field[data-field="clear-accounts"] ▸ padding-bottom ········ 12px │ │
│ │ └─────────────────────────────────────────────────────────────────────┘ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ ┄ 条件未传 children 的缺省 fallback：div.field[data-field] padding:12px 0 ┄
│ │ div.head padding:0 › div.labelGroup flex:1 padding:0 › span.label「账号」│
│ │ ┆ .field ▸ padding-bottom ······································· 12px │
│ ┆ div.fieldSlot 内 div.hintRow ▸ margin-top ········· −6px；[data-hint-row] │
│ span.hintText[data-account-state]「需要账号/当前账号」 12/400/18           │
│ ┆ .hintRow ▸ margin-bottom ········································· 12px │
│ ┆（section ▸ 末块补偿）.fieldSlot:last-child ▸ margin-bottom ······· −12px │
│ ┆ .section ▸ padding-bottom ······································· 16px │
└─────────────────────────────────────────────────────────────────────────────┘
                              ┆ 卡片底 = 12 − 12 + 16 = 16px
```

四渠道共用上面同一个 `data-channel-config-host` 段，差别只在标题、说明、端点行条件与账号区内容；`buddy`、`workbuddy`、`qoder`、`qodercn` 各自拥有独立 `currentAccountId`、账号列表和授权流程，不会串用。只有 `qoder` 渲染 `data-qoder-endpoint-slot` 与端点下拉；其他三个渠道渲染固定域文本，没有端点下拉、不可点击。

## 3. 空白归属与 hintRow 选择器

| 位置 | 空白持有者 | 生效规则 |
|---|---|---|
| section 顶 / 底 | `.section` 的 `padding:16px 0` | `.heading` 永不命中首/末补偿 |
| h3 → 第一行 | 第一行 `padding-top:12px` | `.heading { margin: 0 }` |
| 行 → 行 / 相邻 field | 前块 12 + 后块 12 | 24px |
| 跨线内容 → 内容 | 上 section 16 + 下 section 16 | 32px；rule margin 0 |
| 首块为 row/fieldSlot/group | 首块自身或内部 field 的 padding-top | `.section > .row:first-child` / `.section > .fieldSlot:first-child` / `.section > .group:first-child` 的 `margin-top:−12px` |
| 末块为 row/fieldSlot/group | 末块自身或内部 field 的 padding-bottom | `.section > .row:last-child` / `.section > .fieldSlot:last-child` / `.section > .group:last-child` 的 `margin-bottom:−12px` |
| hintRow 在 fieldSlot 内部且 fieldSlot 是 section 直接末孩子 | 内部 hintRow 的 `margin-bottom:12px` | 由 `.section > .fieldSlot:last-child` 承担；`.section > .hintRow:last-child` 不命中 |
| hintRow 是 section 直接末孩子 | hintRow 自身 `margin-bottom:12px` | `.section > .hintRow:last-child` 承担 |
| 字段 → 外置 hint | field `padding-bottom:12px` 与 hintRow `margin-top:−6px` | 先 12 再 −6，净 6px；仅 field 仍复制 `padding:12px 0` 时成立 |
| 包装层 | stack/fieldSlot/accountConfig/accountList/authFlow/confirmBox/fieldControl/menuRoot/viewport | `padding:0`；不得再加纵向 12px |

## 4. 控件契约

| 控件 | rc5 值 / 行为 |
|---|---|
| Switch | 原生 `button type=button`，`role=switch` / `aria-checked` / 必填 `aria-label`；轨道 36 × 20、padding 2、thumb 16、translateX(16px)、transform 120ms ease、disabled opacity .5、focus-visible ring、reduced-motion 关闭动画 |
| Dropdown 锚点 | height 34px / padding `0 12px` / border `none` / radius-md / bg-module-platform；disabled 只改 label-tertiary 与 cursor；focus 改 business border且 outline none |
| MenuSurface / MenuRow | surface padding 4、border 0、radius-lg、elevation-prominent、min 144 / max 360 / width max-content / z1100；item min-height 34、padding `6px 8px`、gap 6、13/20；label 在前，仅 selected 追加 trailing 14px SVG check；selected transparent，focus 背景且 outline none |
| Menu 定位 | portal 到 body；trigger `anchor-name` 与 surface `positionAnchor` 对应；`data-match-anchor-width` 以 `anchor-size(width)` 提供最小宽度；完整 `position-try-fallbacks`；viewport 独立滚动，不手写 left/top rect |
| Dropdown 键盘 / 焦点 | autoFocus；方向键/Home/End 跳过 disabled；Escape、Shift+Tab、普通 Tab、outside pointer 按 rc5；选择后回 trigger；保留慢保存最终回焦 R30，用户竞争焦点时不抢 |
| 字段 | `.field` gap 6 / padding `12px 0`；`head > labelGroup`，labelGroup flex 1，组内 label flex `0 1 auto`；hint 为独立 p，错误与警告 token 分离；fieldSlot padding 0 |
| 账号 / 操作 | 账号 head 的 labelGroup flex 1，右侧 badges/accountActions 自然靠右，不用外层 justify 补偿；账号行基础 padding `12px 0`，首行 top 0、末行 bottom 0，行间 hairline 0.5px；按钮复制 rc5 small outline，Tag 复制官方几何/tone |
| OFF gating | `ChannelConfigHost` 接收 `gated`，section 加 `.channelGated` / `data-off-gated`；`QoderEndpointRow` 与账号 `field[data-field="accounts"]` 再加 `.fieldGated`。添加账号、设当前、重登、删除、重试、端点下拉全部 `disabled`；账号文本与 hint 用 `label-dimmed`；清除全部 field 不挂 gated；OFF 不取消在飞授权/RPC |
| 展示框 | 授权 URL padding 12、0.5px border-l2、radius-lg、bg-base、code font、12/18、pre-wrap/anywhere；只读，不自动打开、不持久化 |
| 状态与警告 | OFF 时渠道说明由 `lockedHint` 替换且下拉保值；下方配置区 `.channelGated` / `.fieldGated` 用 `label-dimmed` 灰化纯文本，控件沿用各自 `:disabled`；清除全部账号数据与清除确认不在 gated field 内，保持可用；普通错误 `state-error-primary`，删除/清除危险影响 `state-warn-primary`；红字不被 gated 覆盖 |
| 业务边界 | 不提前实现真实 external-open；删除当前账号默认“暂不指定”替代；清除全部必须就地二次确认；不改变 settings.update、accounts/auth RPC 或 generation/queue 语义 |

### Trigger 外观补充

DPG `settings-card.module.css:122-137` 与 DAE `settings-card.module.css:91-106` 的 trigger 均为 `border:none` + `var(--dsw-alias-bg-module-platform)`。按用户对本页视觉验收的明确要求，本卡采用这一实际插件先例，不再以 WebSearch 的 border-l4 作为保留额外边框的理由。仅 trigger 外观改变；rc5 的 34px / `0 12px` / gap 12 / radius-md、键盘、焦点、disabled、Qoder 全宽与 MenuSurface/elevation 均不变。

## 5. 证据边界

当前只以静态源码、构建产物与 jsdom 验证真实 React DOM、事件、焦点、portal 结构、授权轮询/generation 与 RPC 调用形状。主会话随后仅在独立 `DSH_HOME` 中验收：

- 真实计算样式（首末 −12px、hintRow −6px、34px、36 × 20、账号行基础 12px 与首末 0、行间 hairline、独立 backing portal 等）、明暗主题与窄宽度；
- CSS anchor positioning 在滚动详情列中的实际位置、`position-try` fallback 与 portal 不裁剪；
- zh/en 切换不重挂载、live slot key、Theme token、控制台无 slot entry crash；
- 真实 Host configForms、实际运行观测 host、四渠道真实账号授权/搜索；
- 与同级插件全部最终样式表的类名交集和双向反向对照由本实现的静态脚本执行，真实安装页再复核无跨插件污染。
