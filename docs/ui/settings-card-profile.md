# 0.1.0 设置卡完整剖面（SearchSection / ChannelConfigHost / rc3 控件）

> 目标：DSH `0.2.2-rc.3`；当前证据是静态源码与 jsdom DOM 测试。
> **本文件不宣称真实浏览器计算样式、主题或 CSS 隔离已验收**；这些由 Task 16 在真实
> Desktop 中量取。本任务只固化 DOM 结构、空白归属与控件行为契约。

## 1. 唯一真源

设置卡只认一个 `search.channel`：下拉值、配置区标题、账号状态与未来端点行都由它
派生；同一时刻只渲染一个 `ChannelConfigHost`，不存在第二渠道查看选择器。`OFF` 只
禁用并灰化渠道下拉，保留渠道值；当前渠道配置区仍可管理。

## 2. 完整剖面（从 `.stack` 顶到底，一张图）

```text
╔═══════════════════════════════════════════════════════════════════╗
║ div.stack                                     display: flex  gap:0 ║
║ data-dsh-web-search-channels="settings-card"                     ║
╚═══════════════════════════════════════════════════════════════════╝

┌─ section.section[data-search-section]   padding: 16px 0 ──────────┐
│   ┆ .section ▸ padding-top ································· 16px   │
│   h3.heading「网页搜索渠道」          margin: 0  font: 13/600  lh:1.5 │
│   ┆ .row[data-row="enabled"] ▸ padding-top ··············· 12px   │
│   ┌───────────────────────────────────────────────────────────┐   │
│   │ 启用网页搜索 / 行说明                       [ ●──── ]      │   │
│   │ Switch：36 × 20，thumb 16，translateX(16px)，120ms         │   │
│   └───────────────────────────────────────────────────────────┘   │
│   ┆ .row ▸ padding-bottom 12 ＋ .row ▸ padding-top 12 = 24px       │
│   ┌───────────────────────────────────────────────────────────┐   │
│   │ 搜索渠道 / 行说明                         [ CodeBuddy ▾ ] │   │
│   │ Dropdown 锚点：height 34px / padding 0 12px               │   │
│   └───────────────────────────────────────────────────────────┘   │
│   ┆ .row[data-row="channel"] ▸ padding-bottom ············· 12px   │
│   ┆ .section > .row:last-child ▸ margin-bottom ·········· −12px   │
│   ┆ .section ▸ padding-bottom ····························· 16px   │
└───────────────────────────────────────────────────────────────────┘
                              ┆        ← 组边界 16px
 ═════════════════════════════ div.rule[role="separator"] ▸ border-top: 0.5px solid border-l2  margin: 0
                              ┆        ← 组边界 16px
┌─ section.section[data-channel-config-host][data-channel=当前 search.channel]  padding: 16px 0 ┐
│   ┆ .section ▸ padding-top ································· 16px   │
│   h3.heading「CodeBuddy / WorkBuddy / Qoder 国际版 / Qoder 中国版」 margin: 0 │
│   ┆ .row[data-channel-description] ▸ padding-top ········· 12px   │
│   [ 当前渠道说明；只来自当前 search.channel ]                     │
│   ┆ .row ▸ padding-bottom ································· 12px   │
│   ┄ 以下 div.fieldSlot[data-qoder-endpoint-slot] 仅 qoder 渠道渲染 ┄
│   ┆ div.fieldSlot[data-qoder-endpoint-slot] ▸ padding ····· 0px   │
│   ┆ div.fieldSlot ▸ padding ····························· 0px（包装层不持有空白）│
│   ┌─ QoderEndpointRow（Task 14） 未来层；本任务只留空宿主 ───────┐  │
│   │  ┆ div.row ▸ padding ································· 12px 0 │  │
│   │  端点偏好：auto / center / api2                  [ 自动 ▾ ]  │  │
│   │  ┆ div.row ▸ padding-bottom ··························· 12px  │  │
│   └───────────────────────────────────────────────────────────┘  │
│   ┄ 以下账号区始终渲染；不是第二渠道选择器 ┄                       │
│   ┆ div.fieldSlot[data-account-config-slot] ▸ padding ····· 0px   │
│   ┌─ AccountChannelConfig（Task 14） 未来层；本任务只渲染状态占位 ┐ │
│   │  ┆ div.field ▸ padding ··························· 12px 0    │ │
│   │  ┆ .field ▸ padding-top ······························ 12px  │ │
│   │  账号（本任务占位 label；未来为账号列表/内联流程）            │ │
│   │  ┆ .field ▸ gap ········································ 6px │ │
│   │  ┆ .field ▸ padding-bottom ·························· 12px  │ │
│   │  ┆ div.hintRow ▸ margin-top ························· −6px  │ │
│   │  需要账号：添加并授权此渠道账号后才能使用。                    │ │
│   │  ┆ .hintRow ▸ margin-bottom ························ 12px  │ │
│   │  ┆（section ▸ 末块补偿）.fieldSlot:last-child ▸ margin-bottom · −12px │ │
│   └───────────────────────────────────────────────────────────┘ │
│   ┆ .section ▸ padding-bottom ····························· 16px   │
└───────────────────────────────────────────────────────────────────┘
                              ┆        ← 卡片底 16px
```

四渠道共用上面同一个 `data-channel-config-host` 段，差别只在标题、说明和账号/端点
内容；`buddy`、`workbuddy`、`qoder`、`qodercn` 各自拥有独立 `currentAccountId`，
不会串用。`qoder` 多一个 `QoderEndpointRow（Task 14）` 宿主；其他三个渠道没有
`data-qoder-endpoint-slot`。

## 3. Task 14 接缝与边界

- `ChannelConfigHost` 的 `children` 是 `AccountChannelConfig（Task 14）` 的接缝；
  本任务在缺省时只渲染账号 label + 状态 hintRow，**不提前实现账号列表、内联授权/
  删除或另一套实际端点编辑**。
- `data-qoder-endpoint-slot` 是 `QoderEndpointRow（Task 14）` 的宿主；本任务只保留
  空的 `.fieldSlot`（`padding: 0`），不放第二个下拉，也不添加第二渠道查看选择器。
- 账号状态只显示“需要账号”或“当前账号：<id>”，不伪造 ready；Task 14 才显示真实
  账号列表、授权状态和删除确认。

## 4. 空白归属与 hintRow 选择器

| 位置 | 空白持有者 | 生效规则 |
|---|---|---|
| section 顶 / 底 | `.section` 的 `padding: 16px 0` | `.heading` 永不命中首/末补偿 |
| h3 → 第一行 | 第一行的 `padding-top: 12px` | `.heading { margin: 0 }` |
| 行 → 行 | `.row` 12 + `.row` 12 | 24px |
| 首块为 row/fieldSlot/group | 首块自身 padding 或内部 field 的 padding-top | `.section > .row:first-child` / `.section > .fieldSlot:first-child` / `.section > .group:first-child` 的 `margin-top: −12px` |
| 末块为 row/fieldSlot/group | 末块自身 padding 或内部 field 的 padding-bottom | `.section > .row:last-child` / `.section > .fieldSlot:last-child` / `.section > .group:last-child` 的 `margin-bottom: −12px` |
| hintRow 在 fieldSlot 内部且 fieldSlot 是 section 直接末孩子 | 内部 hintRow 的 `margin-bottom: 12px` | 由 `.section > .fieldSlot:last-child` 承担；`.section > .hintRow:last-child` 不命中 |
| hintRow 是 section 直接末孩子 | hintRow 自身 `margin-bottom: 12px` | `.section > .hintRow:last-child` 承担 |
| 输入框 → 外置 hint | field 的 `padding-bottom: 12px` 与 hintRow 的 `margin-top: −6px` | 先 12 再 −6，净 6px；仅当自有字段仍为 `padding: 12px 0` 时成立 |

`.fieldSlot` 自身始终 `padding: 0; min-width: 0`；它的 `min-width` 只负责收缩，不持有
纵向空白。内部 `.field` 的 `padding: 12px 0; gap: 6px` 才是被首/末补偿抵消的对象。

## 5. 控件契约

| 控件 | 值 / 行为 |
|---|---|
| Switch | 原生 `button type=button`，`role=switch` / `aria-checked` / 必填 `aria-label`；轨道 36 × 20、`padding: 2px`、thumb 16、`translateX(16px)`、`transform 120ms ease`、disabled `opacity: .5`、focus-visible ring、`prefers-reduced-motion` 关闭动画 |
| Dropdown 锚点 | height 34px / padding `0 12px` / border `0.5px solid border-l4` / radius-md / bg-layer-3；disabled 只改 `label-tertiary` 与 cursor |
| Menu | `padding: 4px`；item `min-height: 34px`、`padding: 6px 8px`、`gap: 6px`、13px/20px；portal 到 `document.body`、autoFocus、minWidthFromAnchor |
| Dropdown 键盘 | Enter/Space/ArrowDown 打开并聚焦首项，ArrowUp 打开并聚焦末项；ArrowUp/ArrowDown 循环，Home/End 定位；Escape 与 Shift+Tab 关闭并把焦点还给 trigger；选择后焦点回 trigger；outside pointerdown 只关闭菜单 |

## 6. 证据边界

当前仅以 jsdom 验证真实 React DOM 结构、事件、焦点与 portal；以下项目未验收，必须在
Task 16 的真实安装页完成：

- 真实计算样式（首末 `−12px`、hintRow `−6px`、34px/36×20 等）与明暗主题；
- portal 在滚动详情列中的实际位置、390px 窄宽度横向溢出；
- 与同级插件全部最终样式表的类名交集、反向对照与 CSS Modules 隔离；
- zh/en 切换不重挂载、live slot key 与真实 Host 服务。
