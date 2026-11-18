# 网页搜索渠道插件设计

- 日期：2026-11-18
- 状态：已于 2026-11-18 获用户批准；builder 可实施性审查、四渠道与运行/验收支持矩阵、Qoder 国际版端点策略均已纳入
- 目标运行环境：DeepSeek Harness Desktop / Web，`0.2.2-rc.3`
- 首个交付版本：`0.1.0`（完整 Search 产品）
- 后续版本：`0.2.0`（CodeBuddy / WorkBuddy Fetch 备选能力，默认关闭）
- 项目目录当前仅包含本设计文档；未初始化 Git、未搭建产品工程、未编写产品代码

## 1. 意图与背景

本插件面向在 DSH 中使用自行配置模型的用户，使任意模型都能通过用户显式选择的 CodeBuddy、WorkBuddy、Qoder 国际版或 Qoder 中国版账号完成网页搜索，避免网页搜索能力绑定 DeepSeek 模型渠道或 DeepSeek 付费搜索。

产品不是 codearts / Jet Hub 的附属功能，也不要求用户安装 Jet Hub。插件自己拥有账号登录、凭据刷新、当前账号选择、重新登录、删除、配置持久化、工具接管和异常恢复。

界面工作名称为“网页搜索与抓取”，`0.1.0` 实际只交付搜索。内部项目名暂用 `dsh-web-search-channels`；“搜索替换”只作为讨论用语，避免被理解为文本查找替换。

已确认的版本策略：

- `0.1.0` 必须是可独立使用的完整 Search 产品，不是技术 Demo。
- `0.2.0` 才加入 CodeBuddy / WorkBuddy Fetch；它是可选备选能力，不是首个版本必须补齐的核心价值。
- 不为了分期而砍掉独立登录、自动刷新、账号状态、失败策略或卸载清理。

## 2. 目标、非目标与反目标

### 2.1 `0.1.0` 目标

1. CodeBuddy、WorkBuddy、Qoder 国际版、Qoder 中国版四个独立搜索渠道均可通过各自真实鉴权方式完成搜索；任一渠道的配置与账号不得冒充另一渠道通过验收。
2. 搜索后端不再取决于当前聊天模型 Provider，而由插件自己的 `search.channel` 决定。
3. 插件自己完成四个渠道账号的添加、授权、刷新、当前账号选择、重新登录和删除，且任一渠道都不读取另一渠道的账号配置。
4. Search 开关与渠道选择相互独立；没有 `auto`，没有自动渠道或账号切换。
5. 开关 ON 时只走所选渠道；无账号、凭据失效或渠道异常时明确失败，绝不静默调用 DeepSeek。
6. 开关 OFF 时完整交还官方 `web_search`，包括准入、参数、结果、提示词和费用行为。
7. 插件详情页采用单一页面、单一渠道真源：上方实际使用哪个渠道，下方就配置哪个渠道。
8. 渠道配置具有明确扩展边界：账号型、API Key 型和自定义型渠道不必共用一种配置模型。
9. 复用 JetHub 已验证的搜索执行经验，但修正其与当前 DSH 的版本漂移和路由/账号耦合。
10. 凭据不进入普通配置、Client 持久状态、日志或 Session 事件。

### 2.2 `0.1.0` 非目标

- 不实现或展示 Fetch 开关、Fetch 渠道行、Fetch 配置键或空 Fetch 适配器。
- 不做旧 Jet Hub 账号池导入、同步或运行时依赖。
- 不做自动渠道、账号轮换、负载均衡、额度调度或故障递补。
- 不做按模型、会话、工作区或 Agent 分别绑定渠道与账号。
- 不增加 Tavily、AnySearch 或其他渠道的实现；只保留内部扩展边界。
- 不开放第三方动态渠道插件 SDK；新增渠道仍通过本插件版本升级交付。
- 不做条件 Shadow；只有实测准入失败时，才另行评估这一兼容方案。
- 不做主导航页面、设置侧栏账号页、账号二级路由或账号管理 Modal。
- 不做团队账号共享、云同步、企业配额、计费分析或管理后台。

### 2.3 反目标（技术上能运行也算失败）

- 用户开启插件搜索后，因账号或渠道问题静默产生 DeepSeek 搜索调用或费用。
- 上方显示实际使用 A，下方却配置 B，让用户误以为正在使用 B。
- 为了“统一”而要求未来所有渠道都伪装成账号型渠道。
- 插件 OFF 或卸载后留下指向本插件的官方 Provider 配置、工具注册或后台任务。
- Client 能读取 token、刷新材料或 Qoder 签名秘密。
- 把 JetHub 的路由限定、聊天账号池和旧版 4/8 常量原样搬入新产品。
- 仅有静态源码或单元测试，就宣称真实 DSH 渲染与端到端行为已经验证。

## 3. 已确认的产品决策

| 决策 | 结论 |
|---|---|
| 账号归属 | 完整独立账号产品，不依赖 Jet Hub |
| 旧账号迁移 | 不做 |
| ON 后不可用 | 明确报错，绝不回退官方或其他渠道 |
| 多账号 | 每家一个显式“当前使用”账号，其他为手动备选 |
| 渠道选择 | 不要 `auto`，不因可用性自动改变选择 |
| 顶层渠道 | `buddy / workbuddy / qoder / qodercn` 四个独立渠道；协议族只用于代码复用，不共享账号或配置 |
| 页面结构 | 单页平铺；渠道配置区随所选渠道变化，不做账号二级页 |
| 渠道与配置关系 | 共用同一个搜索渠道下拉，不设置独立的配置查看选择器 |
| 搜索关闭 | 渠道下拉灰化保值；当前所选渠道的配置仍可管理 |
| 版本分期 | `0.1.0` Search；`0.2.0` 腾讯 Fetch 默认关闭 |
| 运行时 | 默认采用 JetHub 风格 `tools/execute`，不默认实现 Shadow |
| Qoder Fetch | 国际版与中国版均不支持；`0.2.0` 中两个选项分别显示“仅搜索”并禁用 |
| Qoder 国际版端点 | 配置段独有“自动 / center.qoder.sh / api2.qoder.sh”下拉；自动默认 center，限定故障时另一域兜底并粘性，其他渠道只显示固定端点 |

“共用搜索渠道下拉”是有意的信息架构选择：同一个 `search.channel` 同时驱动运行时分派、状态说明和下方配置区，从结构上杜绝“实际用 A、配置 B”的歧义。

## 4. 方案比较与取舍

### 4.1 账号产品形态

**长期读取 Jet Hub 账号池**：开发较少，但产生双插件依赖、刷新归属不清、写入竞争和版本耦合。当前 Desktop profile 未安装 Jet Hub，排除。

**独立凭据柜**：插件自己保存 token，但登录和刷新后置。首个版本仍会留下最核心的长期使用问题，排除作为正式产品形态。

**完整独立账号产品（选定）**：自己登录、刷新和管理。实现成本最高，但符合独立产品目标。不做旧账号导入。

### 4.2 页面承载

**独立设置子页 / 主导航面板 / 大 Modal**：当前 DSH 无法从 `plugins.bundle.config` 受支持地定向打开某个 `settings.section`；主导航过重，Modal 不适合多账号与登录流程，均不采用。

**两个静态账号区平铺**：能展示全部账号，但把“账号”错误提升为跨渠道统一抽象，对未来 Tavily、AnySearch 不适用，排除。

**单一下拉 + 动态渠道配置（选定）**：页面仍是一个平面，没有路由切换；仅配置区内容随实际渠道变化。隐藏渠道的配置和账号状态保留，不删除。

### 4.3 运行时接管

**原生 WebProvider + 修改官方 `web.searchProvider/fetchProvider`**：需要修改其他插件配置；OFF 或卸载留下 Provider ID 时，官方不会自动恢复，排除。

**永久同名 Shadow**：会改变官方准入，并可能绕过 Agent 对继承工具的 `restrict`，排除。

**仅 ON 注册的条件 Shadow**：能解决特定 readiness=false 场景，但引入定义捕获、注册协调、双 owner、HMR 和在飞管理复杂度。当前内置 Provider 均没有 `ready()`，Provider 选择失败时 readiness 也为 true，因此不作为默认方案。

**JetHub 风格 `tools/execute`（选定）**：当前真实 DSH 组合下官方工具会进入执行管道；OFF `next()` 可完整交还官方，`{ value }` 会经官方 output schema/render 收尾。先以真实准入验证确认，再交付。

### 4.4 版本范围

**Search + Fetch 一次完成，Fetch 默认关**：默认关并不能减少 Fetch 的契约、测试、质量和维护成本，排除。

**先完整 Search，再增量 Fetch（选定）**：先验证独立账号、渠道、工具接管和失败策略；Fetch 后续复用稳定骨架。

## 5. `0.1.0` 信息架构与真实页面

### 5.1 页面结构

插件详情页只有以下两个逻辑区域，垂直排列，无二级视图：

```text
搜索
  网页搜索                                      [ 开关 ]
  用所选渠道的凭据替换 DSH 网页搜索。

  搜索渠道                                      [ CodeBuddy ▾ ]
  状态：已关闭 / 已开启·已就绪 / 已开启·需要账号 / …

────────────────────────────────────────────────

渠道配置（由“搜索渠道”唯一决定）

  [若搜索渠道 = buddy / CodeBuddy]
    CodeBuddy 账号                              [ 添加账号 ]
    ● 当前使用  账号 A   正常
    端点：copilot.tencent.com

  [若搜索渠道 = workbuddy / WorkBuddy]
    WorkBuddy 账号                              [ 添加账号 ]
    ● 当前使用  账号 B   正常
    端点：www.workbuddy.ai

  [若搜索渠道 = qoder / Qoder 国际版]
    Qoder 国际版账号                            [ 添加账号 ]
    ● 当前使用  账号 C   正常
    搜索端点                                    [ 自动 ▾ ]
    选项：自动 / center.qoder.sh / api2.qoder.sh
    自动模式本次实际使用：center.qoder.sh
    仅支持搜索，不支持服务端网页抓取。

  [若搜索渠道 = qodercn / Qoder 中国版]
    Qoder 中国版账号                            [ 添加账号 ]
    ● 当前使用  账号 D   正常
    端点：gateway.qoder.com.cn
    仅支持搜索，不支持服务端网页抓取。
```

四个账号区不会同时出现，也没有第二个配置查看选择器。每个渠道只看到自己的账号、端点、授权和状态；腾讯系、Qoder 系这类协议族概念不得作为可选择渠道或账号归属。

端点控件故意不对称：**只有 Qoder 国际版配置段出现端点下拉**；CodeBuddy、WorkBuddy、Qoder 中国版的“搜索端点”均为纯文本固定域名，没有下拉、不可编辑。Qoder 国际版下拉只属于其配置段，不是顶层渠道选择器，也不能选择中国版域名。

### 5.2 单一渠道真源

`search.channel` 同时决定：

1. ON 时实际调用哪个搜索适配器；
2. 搜索状态行显示哪家渠道和当前账号；
3. 下方渲染哪一家的配置组件；
4. 添加、重新登录、删除等操作作用于哪一家。

不允许配置区自行偏离这个值。切换渠道不改变 `search.enabled`。

### 5.3 开关与下拉

- `search.enabled` 默认 OFF；`search.channel` 默认 `buddy`（CodeBuddy）。
- OFF 时下拉禁用、整行灰化，但保留所选值。
- OFF 时当前所选渠道的配置组件保持可操作，账号管理不被连坐禁用；Qoder 国际版的端点偏好也可修改，但只影响后续 ON 的调用。
- 因共用下拉，OFF 时不能查看另一家的配置。若需管理另一家，用户须暂时开启搜索、切换渠道；随后可再关闭搜索。这是本方案的明确取舍，不再增加第二个选择器规避。
- ON 且没有账号时，下拉仍可切换；状态写“已开启 · 需要账号”，不是“未生效”。此时工具调用会 fail closed。
- 开关与下拉均点击即保存，不做乐观更新。只有 Host 持久化成功并返回快照后，才更新下拉和配置区；失败时恢复旧渠道与旧视图并提示。
- 登录、重新登录、删除确认或配置保存进行中时，下拉暂时锁定，文案说明“先完成或取消当前操作”。避免切换后隐藏正在等待用户处理的流程。

### 5.4 渠道配置区

- 切走渠道只卸载其配置视图，不删除该渠道的普通配置、账号、当前账号选择或凭据。
- 添加账号、授权等待、取消、重新登录和删除确认都在对应渠道配置区内就地展开。
- 添加账号时不再选择“产品变体”；当前顶层渠道已经唯一确定 CodeBuddy、WorkBuddy、Qoder 国际版或 Qoder 中国版。
- 不使用账号管理 Modal，不切换路由。
- 首个账号添加成功后设为当前账号；后续账号不自动替换当前账号，用户可显式选择“设为当前使用”。
- 删除当前账号时，确认区列出受影响的搜索能力；用户可显式选择替代账号或“暂不指定”。不自动递补。
- 切换或删除只影响后续调用；已经开始的请求继续使用启动时的配置快照。
- 账号操作只锁定当前账号行；渠道切换操作本身按前述规则防止隐藏进行中流程。

### 5.5 搜索状态

状态至少区分：

- 已关闭：当前使用 DSH 官方搜索；渠道下拉灰化。
- 读取中：不能短暂假装“无账号”。
- 已开启 · 已就绪：显示渠道、当前账号和脱敏状态。
- 已开启 · 未选择当前账号。
- 已开启 · 需要重新登录。
- 已开启 · 暂时不可用：网络、限流或服务异常，不等于凭据失效。
- 已开启 · 配置或凭据读取失败。
- 已开启 · 与其他工具接管存在已知冲突（仅在能可靠识别时展示；不声称通用自动检测）。

## 6. 渠道扩展边界

### 6.1 核心原则

“账号管理”只是渠道配置的一种实现，不是所有渠道的统一抽象。新增渠道时，应提供对应的能力声明、配置界面、秘密解析和执行适配器，而不是强迫它创建伪账号。

V1 的扩展边界是本插件内部的注册表，不是动态第三方插件系统。新增渠道需要随本插件版本提交定义、Host 驱动、Client 配置视图和测试。

### 6.2 共享渠道描述

每个渠道有一份共享元数据，至少表达：

- 稳定 ID：`buddy` / `workbuddy` / `qoder` / `qodercn`，未来可为 `tavily` / `anysearch`。
- 显示名称与本地化说明。
- 固定账号与端点边界，以及可选的协议族标记（仅用于代码复用）。
- 能力矩阵：是否支持 search、是否支持 fetch。
- 配置类型：账号授权型、API Key 型或自定义型。
- 普通配置命名空间与版本。
- 非秘密状态向 Client 投影的方式。

`0.1.0` 的四个渠道及端点定义如下：

| 渠道 ID | 显示名称 | 搜索域名与首版默认 | 账号边界 |
|---|---|---|---|
| `buddy` | CodeBuddy | `copilot.tencent.com` | 仅 CodeBuddy 账号 |
| `workbuddy` | WorkBuddy | `www.workbuddy.ai` | 仅 WorkBuddy 账号 |
| `qoder` | Qoder 国际版 | 自动模式默认 `center.qoder.sh`，`api2.qoder.sh` 为同渠道备用；也可固定选择其一 | 仅 Qoder 国际版账号，两域不得串用中国版配置 |
| `qodercn` | Qoder 中国版 | `gateway.qoder.com.cn` | 仅 Qoder 中国版账号 |

历史上某账号曾在其他域名搜索成功，不构成渠道合并或账号互通依据。`0.1.0` 不提供跨渠道端点选择；Qoder 国际版的两个候选域都属于且只属于 `qoder` 配置，绝不与 `qodercn` 共用配置。自动模式的默认与故障切换规则见 §9.6。

Search 下拉固定展示上述四项；未来新增渠道时只列出声明支持 Search 的渠道，未来 Fetch 下拉只列出声明支持 Fetch 的渠道。渠道是否出现不取决于“当前是否已有可用账号”，也不因账号失效自动改选。协议族（腾讯系、Qoder 系）只能标记可复用的协议代码，不能成为下拉项、执行资格或账号归属。

### 6.3 Host 渠道驱动

Host 驱动负责：

- 读取并校验本渠道普通配置；
- 解析本次执行所需秘密或账号上下文；
- 返回统一、脱敏的配置/账号状态；
- 执行对应鉴权、刷新或自定义初始化；
- 将统一搜索请求转换为厂商请求；
- 将厂商响应转换为官方 canonical 结果；
- 分类鉴权、限流、超时、取消、响应格式和服务端错误。

搜索执行器只按四个稳定渠道 ID 解析对应驱动，不读取渠道专属字段，也不知道未来渠道是否使用“账号”概念。不得先解析为协议族后再从同族账号中挑选可用凭据。

### 6.4 Client 渠道配置视图

Client 按 `search.channel` 从内部注册表选择配置组件：

- `AccountChannelConfig`：适用于账号授权型渠道；提供当前账号、备选账号、添加、重新登录和删除。
- 未来的 `ApiKeyChannelConfig`：适用于 Tavily 等密钥型渠道。
- 未来的 `CustomChannelConfig`：适用于 AnySearch 等拥有不同端点与参数模型的渠道。

四个渠道可以复用账号配置的通用外壳，但每个渠道拥有独立配置实例、账号记录、当前账号、授权流程、刷新逻辑和错误文案。CodeBuddy 与 WorkBuddy 可共享腾讯协议代码，Qoder 国际版与中国版可共享 Qoder 协议代码；这些共享只允许发生在驱动实现层，不能共享配置或账号状态。

非账号秘密（例如 API Key）同样写入 DSH credentials；普通 Config 只保存非秘密配置或凭据引用。

### 6.5 不为未来提前实现的内容

- 不定义动态远程加载或第三方组件沙箱。
- 不预先保存 Tavily、AnySearch 的配置键。
- 不预先创建空适配器、伪账号或通用“所有渠道都相同”的庞大字段联合。
- 不承诺新渠道无需修改插件版本即可接入。

## 7. 配置、账号与凭据模型

### 7.1 普通配置

`0.1.0` 仅保存：

```text
search.enabled: boolean = false
search.channel: "buddy" | "workbuddy" | "qoder" | "qodercn" = "buddy"

buddy.currentAccountId: string | null = null
workbuddy.currentAccountId: string | null = null
qoder.currentAccountId: string | null = null
qodercn.currentAccountId: string | null = null

qoder.endpointPreference: "auto" | "center" | "api2" = "auto"
```

- 可热修改字段使用当前 DSH 的 volatile 配置机制；执行时读取每次调用的配置快照。
- 不保存任何 Fetch 配置键。
- 只有 `qoder` 保存 `endpointPreference`；另外三个渠道没有端点偏好字段。`auto / center / api2` 是用户意图，自动模式实际选中的域名和最近成功域属于运行状态，不改写用户下拉值。
- 自动模式的粘性仅在当前进程、当前 Qoder 国际版账号及其网络出口内有效；插件重启后重新从 center 开始，避免把旧网络环境固化为永久配置。
- 账号显示所需的非秘密元数据可放入渠道配置或账号公开投影；秘密只能放 credentials。
- 配置写入通过 `configEditor` / `configForms`，不自行读取和改写 profile 的 `cordis.patch.yml`。

### 7.2 凭据记录

- 使用本插件自己的 credentials scope；记录 ID 同时编码 `channelId` 与账号稳定 ID，记录内容也保留 `channelId`，禁止跨渠道引用。
- 四个账号型渠道分别使用独立 grant 记录，保存访问令牌、刷新材料、该渠道端点、账号稳定身份和签名所需数据。即使协议相同，也不把一条记录同时视为另一渠道可用。
- Client 只接收账号 ID、显示名、`channelId`、端点标签、状态和脱敏标识，不接收秘密。
- 不写自定义 token 文件，不使用 localStorage，不记录到日志、Session 事件或普通配置。
- CodeBuddy 与 WorkBuddy 是独立的顶层渠道，不是同一账号配置下的变体。
- Qoder 国际版与 Qoder 中国版是独立的顶层渠道；即使历史上存在跨域搜索成功，也不共享账号、当前账号、授权或刷新状态。

### 7.3 账号运行时状态

账号状态与持久化用户意图分开：

- `checking`：正在验证。
- `ready`：本地判断凭据可用；不等于每次上游请求必然成功。
- `refreshing`：正在刷新，账号与当前选择保留。
- `reauth_required`：必须重新登录。
- `temporarily_unavailable`：网络、限流或服务端异常。
- `credential_unavailable`：记录存在但无法读取或解析。

单次请求失败不能直接清除账号、改变当前账号或修改开关。

### 7.4 能力就绪判据

Search 就绪需要同时满足：

```text
插件处于活动状态
AND search.enabled = true
AND search.channel 是已注册且支持 Search 的渠道
AND 该渠道配置完整
AND 若为账号型渠道，已指定 currentAccountId
AND 对应秘密可读取
AND 对应 Host 驱动可用
```

“已开启但不就绪”与 OFF 不同：ON 仍由本插件接管并明确报错；OFF 才交还官方。

## 8. 账号生命周期

### 8.1 添加与授权

1. 用户在实际要使用的渠道下选择“添加账号”。
2. 页面展示数据发送对象、用途和授权说明。
3. 启动当前渠道自己的授权流程：CodeBuddy 与 WorkBuddy 分别使用各自的 external-link 产品参数和账号记录；Qoder 国际版与中国版分别使用各自授权服务、client ID、设备授权和签名配置。渠道内不再要求用户重复选择产品。
4. 授权流程在当前渠道配置区内显示等待、取消、超时和失败状态。
5. 成功后验证账号身份和 Search 能力，再保存本插件自己的凭据记录。
6. 首个账号自动设为当前；后续账号由用户决定是否设为当前。
7. 添加账号本身不自动打开 Search，也不改变渠道选择。

登录、授权、重新登录、删除和清除数据是用户专属操作，不开放 Agent tool 自动执行。

### 8.2 刷新与认证失败

- 临近过期时按账号执行单飞刷新，避免并发重复刷新。
- 认证拒绝时，只有明确的 401 / token 失效类别才允许刷新后重试同一次厂商请求一次。
- 重试仍使用同一渠道、同一账号；不换账号、不换渠道、不调用 DeepSeek。
- 除 §9.6 的 Qoder 国际版自动端点切换外，网络错误、限流、超时、5xx 和响应格式错误在 `0.1.0` 不自动重放，避免重复配额消耗。
- 刷新失败区分暂时服务异常与凭据失效；后者进入 `reauth_required`。
- 刷新与请求都遵守取消信号和插件生命周期。

### 8.3 删除与清除

- 删除账号需要用户确认。
- 删除当前账号不自动选择备用账号；用户可显式选择替代或暂不指定。
- 未指定新账号时保留开关和渠道值，后续 Search 调用明确失败。
- 插件禁用保留普通配置和凭据；重新启用后重新计算状态。
- 提供“清除全部账号数据”用户操作。卸载本身不宣称能可靠物理删除凭据，也不擅自删除用户可能还想保留的数据。

## 9. 运行时设计

### 9.1 默认接管结构

Host 在插件根生命周期中通过 `ctx.inject(['tools'])` 注册一个 `tools/execute` 监听器：

```text
exec.name !== "web_search"
  → next()（0.1.0 中 web_fetch 也始终走这里）

search.enabled = false
  → next()，且发生在账号解析与厂商工作之前

search.enabled = true
  → 校验原始参数
  → 固定本次调用的 search.channel 与渠道配置快照
  → 解析所选渠道的账号/秘密
  → 执行本插件 SearchExecutor
  → 返回 { value }，由当前官方 output schema/render/presentationMeta 收尾
```

禁止行为：

- 根据当前聊天 Provider 判断是否接管。
- 因无 Agent、无聊天路由、无账号、账号失效、渠道不受支持或适配器失败而 `next()`。
- 在 ON 的错误路径调用 `ctx.web.search()`、官方 definition 或其他搜索 Provider。
- 修改官方 `web.searchProvider/fetchProvider`，或把四个渠道注册为官方 WebProvider 形成第二条全局路径。
- 新增 `tool:web_search` 提示词 section。

### 9.2 参数与执行契约

以当前 DSH `0.2.2-rc.3` 为基线：

- `queries` 为非空字符串数组，默认最多 10 条。
- 空白字符串拒绝；按当前官方规则做精确字符串去重，不沿用 JetHub 先 trim 再去重的偏差。
- 参数校验先于账号解析，避免畸形输入触发账号或余额操作。
- 每个去重后的 query 各调用一次所选驱动的单次搜索。
- 适配器接收 `maxResults`，不再写死上游数量。
- 任一 query 失败：记录首个错误、取消兄弟请求、等待全部 settle 后抛出。
- 按原 query 顺序、rank 轮转合并，按 URL 去重。
- 默认最多 10 条 sources，摘要单条上限与当前官方 800 字符基线一致。
- 返回官方支持的 `url/title/snippet/summary/publishedAt`，不丢弃 Qoder 国际版或中国版的发布时间。
- 本插件没有辅助模型摘要时，不伪造 `content`。
- `truncated` 表示本地或上游可确认的截断，不把“恰好返回上限”误当必然还有更多。

这些默认值形成本插件 `ExecutionProfile`。ON 不声称自动继承官方 tool-web 的非默认闭包配置；OFF 永远使用官方当前配置。版本升级必须通过差分测试更新 ExecutionProfile。

### 9.3 OFF 与官方行为

OFF `next()` 后，官方原始注册和执行链继续：

- 官方 readiness 与 restrict 不变。
- 官方 schema、提示词和 PTC binding 不变。
- 官方参数校验、多查询和输出处理不变。
- 官方 Provider、费用与错误行为不变。

“恢复官方”指恢复官方原始准入与执行，不保证官方工具在其自身规则不允许时也强行出现。

### 9.4 准入验证与 Shadow 后备

当前安装版内置 search/fetch Provider 均没有 `ready()`，Provider 选择失败时 readiness 也会返回 true，因此默认组合下 `tools/execute` 可覆盖任意聊天模型。

`0.1.0` 的最低必支持矩阵明确限定为：

- 当前打包的 Desktop `0.2.2-rc.3` 及其自带 Web GUI；不包含 standalone Web、Headless、SDK、ACP 等组合的支持承诺。
- Native 与 PTC 两种 Agent 执行模式。
- 用户实际使用的 Magpie / WPS 灵犀路由，以 Kimi-K3.1 Pro 与 DeepSeek V4.1 Flash 两个代表模型覆盖大小两类模型；具体 model ID 不得成为渠道选择条件。
- DeepSeek 官方路由用于 OFF 差分对照，验证插件关闭后官方准入、执行和费用行为不变。

发布前必须对矩阵内每个组合执行真实 `tools.resolve({ modelSelection })` 与完整管道验证。矩阵外组合可以后续补充，但不能用矩阵外结果替代任何必测项。

若矩阵内任一组合在 ON 时不包含 `web_search`：

- 不得悄悄回退 DeepSeek，也不得在发布前静默删除该组合来换取“全绿”。
- 该失败阻断整个 `0.1.0` 发布；先修复，或重新经过产品决策缩小版本支持声明。
- 只有此时才另行评估“仅 ON 注册、OFF 撤销”的条件 Shadow；它不属于 `0.1.0` 默认骨架。

### 9.5 多插件与监听器顺序

- 本插件把 `web_search` 执行接管视为单一所有者扩展点。
- 与 Jet Hub 同时安装时，用户必须关闭 Jet Hub 的“渠道原生搜索”。
- V1 不承诺多个搜索接管插件能自动协调 waterfall，也不声称能通用检测所有监听器冲突。
- 必须与真实 base composition 的 timeout wrapper 做顺序验证，确认本插件获得带 deadline 的 `exec.signal`，并记录任何被短路跳过的内层扩展风险。

### 9.6 Qoder 国际版端点选择

只有 `qoder` 具有端点偏好，取值为 `auto / center / api2`。另外三个渠道固定使用各自域名，没有该配置或对应运行时分支。

**固定模式**：选择 `center` 时只走 `center.qoder.sh`，选择 `api2` 时只走 `api2.qoder.sh`。连接失败、超时、5xx 或任何其他错误都不自动切到另一域，由用户看到明确失败并自行决定。

**自动模式**：

1. 每次插件启动后的初始首选为 `center.qoder.sh`。
2. 不并行双发，不在首搜前或后台主动测速，不以单次延迟或当前进程的简单 EWMA 自动切换。
3. 只有 DNS/TCP/TLS/连接失败、请求超时或上游 5xx 时，才允许用同一 Qoder 国际版账号、同一 query 顺序尝试另一域名一次：当前为 center 时尝试 api2，当前为 api2 时尝试 center。
4. 401/403、429、响应格式错误和其他账号/签名问题不触发跨域重试。
5. 成功的域名成为当前进程内该账号及网络出口的粘性首选，后续调用先走它；只有再次满足限定故障条件才切换。插件重启后回到 center，不做主动恢复探测。
6. 自动切换仍不出 `qoder` 渠道，绝不使用 `gateway.qoder.com.cn`、其他渠道账号、其他搜索 Provider 或 DeepSeek。
7. 单个 query 最多向两个域名各发一次。若第一域已经处理请求后才返回 5xx 或传输失败，第二次调用可能产生额外上游配额；UI 与详情说明必须披露，不能把自动模式包装成零成本测速。
8. 多 query 场景不取消或重复仍在正常执行的兄弟请求；只有满足条件的失败 query 可按上一条切换。每个请求都记录实际域名，避免合并结果后无法归因。

配置区显示“自动模式本次实际使用：某域名”。Host 可记录脱敏的域名、耗时、HTTP 状态和错误类别，但不记录 query、请求头或秘密。`0.1.0` 不做并行竞速、周期性测速、延迟评分、滞回窗口或自定义 TLS 曲线；这些只在有跨时段真实需求时另行设计。

**默认域的实测依据（2026-11-18，单机、单账号、单网络出口）**：同一 Qoder 国际版账号、相同 query、交替顺序，两个域名真实 COSY 签名搜索均 7/7 成功且两组 query 的 URL 集合一致；center 暖路径中位约 335ms，api2 约 420ms；空闲后冷连接首搜 center 约 477ms，api2 约 2963ms。api2 的冷启动主要受 Node 默认 TLS 栈与当前线路影响，不能误当成纯服务端评分，因此首版采用“center 默认 + 限定故障切换 + 粘性”，不采用复杂速度算法。该结果只证明本次环境，不承诺所有网络的固定优劣。

## 10. 生命周期、并发与异步状态

### 10.1 配置切换

- 开关、渠道和 Qoder 国际版端点偏好切换只影响新调用。
- 已开始调用使用启动时快照，不在中途换渠道、账号或用户指定的端点偏好；自动模式内部按 §9.6 的限定规则处理失败 query。
- OFF 不主动取消已经开始的厂商请求；OFF 只保证后续调用交还官方。
- UI 异步读取使用 generation / sequence，丢弃卸载后或过期回包。

### 10.2 插件关闭、HMR 与卸载

按顺序处理：

1. 停止接受新调用和新登录任务。
2. 撤销 `tools/execute` 监听器及配置/事件订阅。
3. 取消本插件拥有的在飞授权、刷新和搜索请求。
4. 等待在飞操作 settle，确保迟到结果不会再写配置或 UI 状态。
5. 释放 Qoder/WASM、计时器、轮询和其他资源。
6. 清空本代所有状态；旧代 disposer 不得删除新代资源。

Qoder WASM 若使用进程级缓存，必须明确唯一所有者、引用/在飞计数和释放策略；不能只复制 JetHub 单例而宣称卸载无残留。

### 10.3 并发

- 同一账号的刷新单飞。
- 同一工具的多个 query 遵守失败取消与全部 settle。
- 不同 Agent 可并发搜索，但不共享可变的单次执行状态。
- 每个顶层渠道各自持有一个全局显式当前账号；四个渠道互不复用该选择，`0.1.0` 不做会话亲和或自动负载均衡。

## 11. Host / Client / Shared 模块骨架

以下是职责骨架，不要求实施时逐文件照搬名称：

```text
Host
├─ plugin-lifecycle
├─ settings-service
│  ├─ search.enabled / search.channel
│  └─ 各账号型渠道 currentAccountId
├─ tools-execute-listener
├─ search-executor
│  ├─ 参数校验与 ExecutionProfile
│  ├─ 多查询取消、合并、去重和截断
│  └─ 官方 canonical output value
├─ channel-registry
│  └─ 渠道元数据、能力矩阵和 Host 驱动解析
├─ account-service
│  ├─ 脱敏账号列表与当前账号
│  ├─ 删除与影响计算
│  └─ 状态投影
├─ credential-store
├─ refresh-coordinator
├─ auth-flows
│  ├─ BuddyAuthFlow
│  ├─ WorkbuddyAuthFlow
│  ├─ QoderInternationalAuthFlow
│  └─ QoderCnAuthFlow
├─ drivers
│  ├─ BuddySearchDriver
│  ├─ WorkbuddySearchDriver
│  ├─ QoderInternationalSearchDriver
│  ├─ QoderInternationalEndpointPolicy（center/api2 偏好、限定切换与粘性）
│  ├─ QoderCnSearchDriver
│  ├─ TencentProtocolFamily（仅共享协议代码）
│  └─ QoderProtocolFamily + CosySigner / WASM assets（仅共享协议代码）
└─ remote-controller

Client
├─ plugins.bundle.config 注册（key = 包名）
├─ SearchSection
│  ├─ SearchEnabledRow
│  ├─ SearchChannelRow
│  └─ SearchStatus
├─ ChannelConfigHost
│  └─ 按 search.channel 选择唯一配置组件
├─ AccountChannelConfig
│  ├─ AccountList / CurrentAccountRow
│  ├─ InlineAuthFlow
│  └─ InlineDeleteConfirmation
├─ settings-controller / account-controller
├─ 自有控件、样式、错误边界与中英文文案
└─ 异步 generation 与卸载清理

Shared
├─ 渠道元数据与能力矩阵
├─ 设置与脱敏账号 DTO
├─ Search 请求/结果契约
└─ 错误码与状态类型
```

## 12. JetHub 资产复用边界

参考仓库：`C:\Users\Think\Desktop\项目\deepseek-harness-codearts`，审查基线 `82d007a6d1341b156d36337671449c4e8b107e1b`。本地所有分支中 `web-native.ts` 最后实质修改仍为 2026-10-14。此次只读审查未重新运行其测试。

### 可复用并需适配的资产

- 多查询失败取消、全部 settle、rank 轮转、URL 去重和截断。
- 错误分类与修正后的 abort/timeout 归因。
- CodeBuddy / WorkBuddy 可复用腾讯搜索请求与响应投影，但必须拆成两个渠道配置与账号域。
- Qoder 国际版 / 中国版可复用 Qoder 搜索、COSY/WASM 签名和每次资源释放经验，但不得合并两个渠道的产品参数、账号或端点。
- 不乐观更新、失败回读、区分读写失败、丢弃迟到响应的 UI 模式。
- 历史腾讯 Fetch 仅作为 `0.2.0` 的行为资料与防御测试来源。

### 不得照搬的内容

- 按聊天 Provider 选择搜索渠道，以及不支持路由 `next()`。
- `resolveCredentialFor()` 与聊天账号池的选号、额度和轮换逻辑。
- 把 CodeBuddy / WorkBuddy 或 Qoder 国际版 / 中国版合并为一个“账号变体”配置；新设计只复用协议实现，不合并渠道。
- 单个默认 ON 的 `nativeWebSearchEnabled`。
- 硬编码 4 queries / 8 results 和精简结果字段。
- Jet Hub 整份状态文件与自有 RPC 持久化体系。
- Jet Hub 页头按钮行、供应商导航、模型中心和整页账号状态机。
- 进程级 WASM 单例但无明确释放所有者的生命周期。
- 仅 Fiber 自动清理就宣称在飞与 HMR 完整闭环。

## 13. Client 技术与体验约束

- 设置卡注册 `plugins.bundle.config`，key 必须等于包名。
- 不使用 `plugins.item` 伪装成内置插件配置。
- 当前规范禁止第三方插件运行时值导入 Harness Client 包；只允许 `import type`。控件按当前官方 markup、样式和交互自行实现。
- 使用宿主主题 token、locale、焦点环和键盘行为；不引入 iframe 或第二个应用根。
- 菜单 portal、焦点管理、Escape、错误边界和卸载清理由实现显式覆盖。
- 所有可见产品文案走 locale，至少提供中文和英文。
- CSS Modules 哈希输入包含包名；与其他已构建插件做类名交集检查和反向对照。
- 页面只有当前实际渠道的配置区；异步切换期间不能出现“新渠道下拉 + 旧渠道配置被误认为已生效”的保存假成功状态。
- 390px 宽度下无横向溢出，深浅主题均可读。

## 14. `0.2.0` 与后续扩展约束

### 14.1 CodeBuddy / WorkBuddy Fetch

`0.2.0` 才增加：

- `fetch.enabled`，默认 OFF。
- 独立 `fetch.channel` 与独立下拉行。
- `BuddyFetchDriver` 与 `WorkbuddyFetchDriver`；Qoder 国际版和中国版选项显示“仅搜索”并禁用。
- 与 Fetch 实际渠道一致的配置上下文，不制造“实际用 A、配置 B”的歧义。
- Fetch 与同一顶层渠道的 Search 共用账号记录和当前账号：CodeBuddy 只复用 CodeBuddy，WorkBuddy 只复用 WorkBuddy；不得跨渠道复用。
- 官方 `web_fetch` canonical 输出：`body.kind='text'`、真实整数状态码、URL、正文和截断标记。
- 表格结构降级、账号依赖和错误可读性披露。

历史实现只提供以下判据与测试：

- 上游已是 Markdown，不能按 HTML 二次转换。
- `status_code` 缺失或非整数时回退真实 HTTP 状态。
- `content` 非字符串必须失败。
- 使用修正后的超时归因。

官方 output schema 装不下的 `title/content_length` 不强塞，也不为这些元数据另造工具。`0.2.0` 的具体配置区呈现可在该版本设计时细化，但账号数据模型必须共享，且每个配置面板必须明确服务的实际能力。

### 14.2 新搜索渠道

新增 Tavily / AnySearch 等渠道时，需要同一版本内交付：

1. 共享渠道描述与 Search 能力声明。
2. Host 配置与秘密解析驱动。
3. 与实际配置类型一致的 Client 配置组件。
4. 搜索请求/响应适配器与错误分类。
5. 统一 SearchExecutor 接入。
6. 契约、失败、卸载、UI 和真实服务验证。

不得要求它们使用现有四个账号型渠道的配置模型，也不得让配置区脱离 `search.channel`。

## 15. 验证与发布门槛

### 15.1 执行与契约测试

- 移植并更新 JetHub 的有效搜索单测；实施时必须实际运行，不能以源码存在测试代替通过结论。
- 官方与 ON 的参数、查询合并、summary cap、output shape 差分测试。
- 当前 10/10 基线、精确去重、发布时间、URL 去重和截断测试。
- 参数错误发生在任何账号或网络操作之前。
- 无账号、401、刷新失败、限流、超时、取消、响应格式错误均分类正确。
- 认证失败最多同账号同渠道重试一次；其他错误不自动重放。

### 15.2 真实 DSH 集成 spike

先以 mock 渠道和 mock 账号验证，不依赖真实服务：

1. 目标模型下官方 `web_search` 进入 `tools/execute`。
2. ON 无账号仍能到达拦截器并返回明确错误，DeepSeek spy 为零调用。
3. OFF 与未安装插件时，准入、提示词、参数、结果展示和官方调用次数一致。
4. `{ value }` 经过官方 output schema/render/presentationMeta。
5. Native 与 PTC 行为一致。
6. timeout listener 顺序和取消归因正确。
7. 卸载后无监听器、在飞任务或 WASM 残留。

若 §9.4 的任一必支持组合无法准入，阻断整个 `0.1.0` 发布，不能静默回退，也不能从报告中删项后继续发布。

### 15.3 功能矩阵

- Search OFF/ON × `buddy / workbuddy / qoder / qodercn` 四渠道 × 有/无当前账号 × 凭据有效/失效。
- OFF 时 `web_fetch` 永远 `next()`，页面无 Fetch 配置键或 UI。
- 当前账号切换、删除当前账号、暂不指定替代账号，且任一操作都不能改变另外三个渠道的配置。
- 添加、取消授权、授权超时、重复账号、重新登录和刷新单飞。
- **四个渠道分别完成真实验收**：每个渠道都由用户配合完成一次本插件独立登录，并验证刷新、重新登录和至少一次真实单 query 搜索，不能用同协议族另一渠道的结果代替。本设计将四项全部列入正式支持下拉，因此任一渠道失败都阻断 `0.1.0` 发布。
- 真实验收不得用导入旧 token 代替；旧凭据最多用于对照研究，不进入本插件账号记录。
- 只有 Qoder 国际版配置段出现端点下拉；另外三个渠道只显示固定域名且没有下拉。
- Qoder 国际版自动模式初始选 center；连接失败、超时、5xx 可在两域间顺序切换一次并粘性；401/403、429、响应格式错误不切换；两域都失败时返回可归因错误。
- 固定 center/api2 时任何失败都不跨域；自动与固定模式都不并行双发、不使用 gateway.qoder.com.cn、不换账号或 DeepSeek。
- 端点偏好保存失败回滚，实际使用域名在自动模式下可见，多 query 正常兄弟请求不被重复执行。
- 配置写失败回滚、迟到响应、渠道切换时进行中操作锁定。
- 多 Agent 并发、配置快照、OFF 后新调用、卸载时在飞请求。
- 与 Jet Hub 搜索接管互斥的使用说明和顺序测试。

### 15.4 UI 与构建验证

- 在真实安装的 DSH 页面验证，而非只做静态 HTML 预览。
- 同一 `search.channel` 同步驱动下拉、状态和配置区。
- Qoder 国际版端点下拉只有“自动 / center.qoder.sh / api2.qoder.sh”三项，其他渠道的端点文本不可点击。
- OFF 灰化保值、当前渠道账号与 Qoder 国际版端点偏好仍可管理。
- 添加/登录/删除就地展开，无路由或 Modal 依赖。
- 键盘、焦点、Escape、390px、深浅主题和中英文。
- CSS 类名交集为空，并做反向对照。
- 构建产物不打入第二份 React 或宿主 Client 包。
- 插件详情、图标、描述明确说明数据会发送给所选厂商及 OFF 行为。

## 16. 留给实施者的选择

以下不改变已批准的产品行为，可由实施者在计划或最小 spike 后决定：

- TypeScript 源码结构、包管理器和产生 DSH lazy-CJS Client 的具体构建链。
- Host Remote 描述生成与 Client 类型化调用的具体实现方式。
- CodeBuddy、WorkBuddy、Qoder 国际版、Qoder 中国版四套授权模块从 JetHub 提取时的文件边界及依赖裁剪；共享代码不得重新合并账号配置。
- 系统浏览器打开方式；若当前 Host 无受支持入口，首版可复制授权链接作为降级。
- 测试框架与真实 DSH fixture 的具体搭建。
- 包名和图标的最终美术交付，但设置槽 key 与最终包名必须一致。
- 普通字段 volatile 更新通知的具体订阅方式，必须以 spike 证明配置保存后下一次调用读取新值。

## 17. 尚需实施前验证而不能伪装成已知事实的内容

- 当前运行中每个目标模型的真实工具准入与 PTC binding。
- 当前真实 composition 中 timeout 与本插件监听器的最终顺序。
- CodeBuddy、WorkBuddy、Qoder 国际版、Qoder 中国版四套授权与刷新逻辑从 JetHub 解耦后的完整性，以及各渠道独立真实账号验收资源。
- Qoder WASM 在独立插件中的实例所有者和卸载行为。
- 新 Client 构建产物在真实 `plugins.bundle.config` 中的渲染与交互。
- 多插件同时接管时的具体瀑布顺序；V1 只声明互斥使用，不宣称自动协调。

本设计批准后，下一步是编写实施计划；在计划获批前，不创建产品工程、不安装依赖、不安装或启用插件。
