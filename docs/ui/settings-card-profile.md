# 0.1.0 设置卡完整剖面（SearchSection / ChannelConfigHost / 账号 / 端点行）

> 目标：DSH `0.2.2-rc.3`；当前证据是静态源码与 jsdom DOM 测试。
> **本文件不宣称真实浏览器计算样式、主题或 CSS 隔离已验收**；这些由 Task 16 在真实
> Desktop 中量取。本任务只固化 DOM 结构、空白归属与控件行为契约。

## 1. 唯一真源

设置卡只认一个 `search.channel`：下拉值、配置区标题、账号区与端点行都由它
派生；同一时刻只渲染一个 `ChannelConfigHost`，不存在第二渠道查看选择器。`OFF` 只
禁用并灰化渠道下拉，保留渠道值；当前渠道配置区（含账号与端点）仍可管理。

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
│   ┄ 仅 qoder：div.fieldSlot[data-qoder-endpoint-slot] ▸ padding · 0px ┄
│   ┌─ QoderEndpointRow（Task 14） ───────────────────────────────┐  │
│   │  ┆ div.field[data-qoder-endpoint-row] ▸ padding ··· 12px 0  │  │
│   │  ┆ .field ▸ gap ······································· 6px │  │
│   │  搜索端点（唯一端点下拉）                       [ 自动 ▾ ] │  │
│   │  Dropdown 锚点 34px / 0 12px；选项仅自动、center.qoder.sh、 │  │
│   │  api2.qoder.sh；固定域来自共享定义，不含 gateway           │  │
│   │  span[data-endpoint-status]：自动模式本次实际使用 /        │  │
│   │  尚无运行观测（缺少 Host 运行观测时不得伪造默认 center）     │  │
│   │  span.hintText：仅支持搜索，不支持服务端网页抓取。           │  │
│   │  span.error[data-endpoint-error][role=alert]（保存失败时）   │  │
│   └───────────────────────────────────────────────────────────┘  │
│   ┄ 其他三渠道：div.fieldSlot[data-fixed-endpoint-slot] ▸ padding · 0px ┄
│   ┌─ 固定端点文本（无按钮、无下拉） ───────────────────────────┐  │
│   │  ┆ div.field[data-field="endpoint"] ▸ padding ····· 12px 0 │  │
│   │  搜索端点（纯文本固定域）      span[data-fixed-endpoint]   │  │
│   │  说明：此渠道固定使用该域名，没有端点下拉。                 │  │
│   └───────────────────────────────────────────────────────────┘  │
│   ┄ 以下账号区始终渲染；不是第二渠道选择器 ┄                       │
│   ┆ .fieldSlot ▸ padding ································· 0px   │
│   ┆ .field ▸ padding ··································· 12px 0  │
│   ┆ .field ▸ gap ··········································· 6px │
│   ┆ div.fieldSlot[data-account-config-slot] ▸ padding ····· 0px   │
│   ┌─ AccountChannelConfig（Task 14） ────────────────────────────┐ │
│   │  ┆ div.field[data-field="accounts"] ▸ padding ··· 12px 0    │ │
│   │  ┆ .field ▸ gap ······································· 6px │ │
│   │  账号（fieldHead）                                [添加账号] │ │
│   │  span.error[data-account-error][role=alert]（读取/删除/清除失败）│
│   │  span[data-account-state]：正在读取账号 / 需要账号 /        │ │
│   │  当前账号 / 未选择当前账号                                   │ │
│   │  div[data-account-list]：每行                               │ │
│   │    [当前使用|备选] 显示名  脱敏标识  状态（正常/需要重新登录…）│ │
│   │    [设为当前使用]（仅备选） [重新登录] [删除]                │ │
│   │  div[data-inline-auth]（添加/重登就地展开）：               │ │
│   │    等待授权完成 / 复制授权链接 / 取消授权 / 只读 authUrl     │ │
│   │  div[data-delete-confirmation]（就地确认）：                │ │
│   │    删除当前账号时默认 [暂不指定] 替代账号，不自动递补        │ │
│   │  ┆ div.field[data-field="clear-accounts"] ▸ padding 12px 0 │ │
│   │  清除全部账号数据（四个渠道） [清除全部账号数据]             │ │
│   │  div[data-clear-confirmation]：明确列出四渠道与不可自动恢复  │ │
│   │  （缺省 children 时才渲染旧占位）                            │ │
│   │  ┆ .hintRow ▸ margin-top ····························· −6px  │ │
│   │  ┆ .hintRow ▸ margin-bottom ························· 12px   │ │
│   │  ┆ div.hintRow[data-hint-row] ▸ margin-top ·········· −6px  │ │
│   │  需要账号：请先添加此渠道账号。                              │ │
│   │  ┆ .hintRow ▸ margin-bottom ························ 12px   │ │
│   │  ┆（section ▸ 末块补偿）.fieldSlot:last-child ▸ margin-bottom · −12px │
│   └───────────────────────────────────────────────────────────┘ │
│   ┆ .section ▸ padding-bottom ····························· 16px   │
└───────────────────────────────────────────────────────────────────┘
                              ┆        ← 卡片底 16px
```

四渠道共用上面同一个 `data-channel-config-host` 段，差别只在标题、说明、端点行
条件与账号区内容；`buddy`、`workbuddy`、`qoder`、`qodercn` 各自拥有独立
`currentAccountId`、账号列表和授权流程，不会串用。只有 `qoder` 渲染
`data-qoder-endpoint-slot` 与端点下拉；其他三个渠道渲染固定域文本，没有端点
下拉、不可点击。

## 3. Task 14 已完成范围与 Task 15/16 边界

- `AccountChannelConfig（Task 14）` 通过 `children` 挂到 `data-account-config-slot`，
  只读取当前渠道的 `accounts.list/current`；添加、轮询、取消、重登、删除确认和
  清除全部数据都在该区内联完成，不使用 Modal/路由。
- `QoderEndpointRow（Task 14）` 挂到 `data-qoder-endpoint-slot`；实际 host 目前没有
  Client RPC 提供，因此 prop 为 null 并显示“尚无运行观测”。**不提前实现**真实
  Host 运行观测接线、真实 external-open 或厂商验收；这些留 Task 15/16。
- 授权 URL 只在当前流程用于复制/只读展示，不自动打开、不持久化；`machine_id`
  只允许出现在该 authUrl，不进入其他字段、配置或存储。
- 清除全部数据入口明确影响四个渠道；确认后才调用 `accounts.clearAll`，取消不写。
- 不增加第二个渠道查看选择器；端点下拉只属于 qoder 配置段，不是顶层渠道选择器。
- 真实 Host 根组合、实际域名观测接线、RPC/Session 日志、浏览器计算样式与厂商
  账号验收不得由本文件的 jsdom 证据宣称通过。

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
| 账号/端点内联块 | 内部 `.field` 的 `padding: 12px 0`；账号行自身 `padding: 8px 0` | 内联块不新增 fieldSlot padding；末块由 `.section > .fieldSlot:last-child` 统一抵消 |

`.fieldSlot` 自身始终 `padding: 0; min-width: 0`；它的 `min-width` 只负责收缩，不持有
纵向空白。内部 `.field` 的 `padding: 12px 0; gap: 6px` 才是被首/末补偿抵消的对象。
Task 14 传入 children 后不再渲染占位 hintRow；该行只保留在缺省 fallback 中。

## 5. 控件契约

| 控件 | 值 / 行为 |
|---|---|
| Switch | 原生 `button type=button`，`role=switch` / `aria-checked` / 必填 `aria-label`；轨道 36 × 20、`padding: 2px`、thumb 16、`translateX(16px)`、`transform 120ms ease`、disabled `opacity: .5`、focus-visible ring、`prefers-reduced-motion` 关闭动画 |
| Dropdown 锚点 | height 34px / padding `0 12px` / border `0.5px solid border-l4` / radius-md / bg-layer-3；disabled 只改 `label-tertiary` 与 cursor |
| Menu | `padding: 4px`；item `min-height: 34px`、`padding: 6px 8px`、`gap: 6px`、13px/20px；portal 到 `document.body`、autoFocus、minWidthFromAnchor |
| Dropdown 键盘 | Enter/Space/ArrowDown 打开并聚焦首项，ArrowUp 打开并聚焦末项；ArrowUp/ArrowDown 循环，Home/End 定位；Escape 与 Shift+Tab 关闭并把焦点还给 trigger；普通 Tab 在当前菜单项上选择、关闭并回 trigger（相同 onSelect/RPC），菜单外 Tab 保持浏览器 traversal；选择后焦点回 trigger；outside pointerdown 只关闭菜单 |
| Dropdown 最终焦点 | 选择先同步回 trigger；pending 中原生 disabled 不承诺持续持焦；保存结束并重新 enabled 后，只有本次选择且焦点因禁用落到 body/documentElement 等无竞争状态时补一次 `focus()`；用户已聚焦其它控件不抢，不新增定时器 |
| Qoder 端点下拉 | 仅 `auto / center.qoder.sh / api2.qoder.sh` 三项；auto 无观测显示“尚无运行观测”，有观测显示实际 host 且不改写 preference；固定模式只显示所选域；保存非乐观，失败回滚并只在端点行显示 `.error` |
| 账号行 | 只显示六字段投影；当前行有“当前使用”标记且无“设为当前使用”；备选行可显式设当前；行操作只锁相关行，授权在飞锁主渠道下拉与全部账号操作；enabled 的第二行操作进入显式顺序队列并显示“排队中/处理中”，不静默丢弃 |
| 内联授权 | 状态按 phase/errorCode 本地化映射，不渲染 Host `displayHint`；授权链接只读 + 复制，剪贴板不可用时降级提示并选中链接文本；取消停止轮询，终态可关闭；非法/错渠道 authUrl 或异 flow/异目标回包 fail closed，只清理原 flow |
| 删除/清除确认 | 删除当前账号默认“暂不指定”替代，不自动递补；清除全部必须就地二次确认，明确影响四渠道且不可自动恢复；授权完成后的账号刷新 settle 前禁止写操作，失败不显示成功 notice |

## 6. 证据边界

当前仅以 jsdom 验证真实 React DOM 结构、事件、焦点、portal、授权轮询/generation
与 RPC 调用形状；以下项目未验收，必须在 Task 16 的真实安装页完成：

- 真实计算样式（首末 `−12px`、hintRow `−6px`、34px、36×20、账号行 8px 等）与明暗主题；
- portal 在滚动详情列中的实际位置、390px 窄宽度横向溢出；
- 与同级插件全部最终样式表的类名交集、反向对照与 CSS Modules 隔离；
- zh/en 切换不重挂载、live slot key 与真实 Host 服务；
- 真实 Host `configForms` 的账号当前值快照、真实运行观测 host、真实 external-open
  与四渠道真实账号授权/搜索验收。
