# Web Search Channels 0.1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个独立的 DSH 插件，使任意声明支持的模型都能通过 CodeBuddy、WorkBuddy、Qoder 国际版或 Qoder 中国版的独立账号完成网页搜索，并具备完整账号生命周期、明确的失败行为、动态渠道配置和可验证的 OFF 官方恢复。

**Architecture:** Host 以根生命周期中的 `tools/execute` 拦截 `web_search`；OFF 直接 `next()`，ON 只调用所选渠道并返回 `{ value }` 交给官方 output 契约。四个渠道共享必要的协议代码，但配置、账号、凭据、端点、授权和刷新完全独立。Client 在 `plugins.bundle.config` 中呈现单一搜索渠道与对应配置区；只有 Qoder 国际版另有端点偏好下拉。

**Tech Stack:** TypeScript、Node.js 24、Cordis/DSH Host APIs、React（平台外置）、原生 Fetch/undici、Qoder COSY WASM、Vitest、jsdom、esbuild、pnpm。

**Spec:**
- 产品设计：`docs/superpowers/specs/2026-11-18-web-search-channels-design.md`
- 设置页规范：`C:\Users\Think\Desktop\项目\DSH-插件设置页UI规范.md`（规范原文基于 DSH `0.2.2-rc.3`，SHA256 `787F9807B1960B19B996196272DD6B0BC30020FC0506300665A3DA035F525AF6`；原文不改，当前基线为 rc.5，其中 UI 数值只有经 rc.5 复核后才沿用）
- JetHub 参考实现：`C:\Users\Think\Desktop\项目\deepseek-harness-codearts`（只提取协议与测试经验，不复制聊天账号池）

## Global Constraints

- `0.1.0` 只实现 Search；`web_fetch` 必须始终 `next()`，不创建 Fetch 配置键、UI 或空适配器。
- 顶层渠道固定为 `buddy / workbuddy / qoder / qodercn`；协议族只能复用代码，不能成为账号归属或执行选择条件。
- `search.enabled=false`、`search.channel='buddy'`；四渠道各有独立 `currentAccountId=null`，不得跨渠道读取账号或凭据。
- ON 时任何账号、配置、渠道或上游错误均不得 `next()` 或调用 DeepSeek；OFF 必须在任何账号/网络工作之前 `next()`。
- 不修改官方 `web.searchProvider/fetchProvider`，不注册默认 Shadow，不新增 `tool:web_search` 提示词 section。
- Qoder 国际版端点偏好为 `auto / center / api2`，默认 `auto`；无最近成功记录时自动从 center 开始，仅在 DNS/TCP/TLS/连接失败、明显超时或 5xx 时在两个国际版域名间切换一次，并在本机全局持久保存最近成功域供后续与重启后优先使用，固定模式不切换且忽略该记录。`qoder.lastSuccessfulHost` 是通过本插件 Host-only 全局持久记录保存的非秘密路由状态，DSH 重启后仍读取并优先使用；它不是账号 grant、普通 Config/configForms 字段或用户偏好，也不进入 Client 普通设置快照。不得并行双发、后台测速、虚构网络出口 ID 或使用 `gateway.qoder.com.cn`。
- 普通配置只保存非秘密用户意图；token、刷新材料和签名秘密只进入本插件 Host credentials。Client 只接收脱敏 DTO。登录、授权、重新登录、删除和清除数据不开放 Agent tool。
- Qoder `machine_id` 是每次登录新生成的随机、非秘密设备标识（不是 bearer 凭据，也不是 token、刷新材料或其他签名秘密）；设备绑定协议要求它出现在授权 URL 中，因此只允许它作为该次授权 URL 的 `machine_id` 查询参数进入发起流程的 Client 可见 `authUrl`。它仍保存于对应 qoder grant 供签名和续期使用，但不得进入日志、Session 事件、错误/cause、普通配置、`AccountSummary` 或其他 DTO 字段；`authUrl` 不持久化，此例外不适用于 token、刷新材料或其他签名秘密。
- 最低验收矩阵：Desktop `0.2.2-rc.5` 及其 Web GUI、Native + PTC、Magpie/WPS 灵犀的 Kimi-K3.1 Pro 与 DeepSeek V4.1 Flash、DeepSeek 官方路由 OFF 对照。任一声明项失败阻断发布，不得从报告中删项。
- 当前验收基线：`0.2.2-rc.5`（用户于 2026-11-21 明确“全部改为 rc5”，rc.3 不再是发布阻断）。rc.3 时期记录的设置页 UI 数值只有经 rc.5 复核后才沿用到实现与验收；测试仍保留 `DSH_TEST_EXPECTED_VERSION` 显式覆盖能力。
- 第三方设置卡只用 `plugins.bundle.config`，key 必须等于 npm 包名 `dsh-web-search-channels`；该 slot 只请求 `view:'page'`，不使用 `plugins.item`，不期待 Host 传 `form`。
- 设置页以 rc.5 为当前基线，沿用复审后的规范数值（经 rc.5 复核后生效）：下拉锚点 `34px / 0 12px`；Menu 项 `min-height:34px; padding:6px 8px; gap:6px`；Switch 轨道 `36×20`、thumb `16×16`、`translateX(16px)`、`120ms`；`.fieldSlot { padding:0; min-width:0 }`，内部 `.field` 才是 `padding:12px 0; gap:6px`。
- section 的 `h3` 不命中首末 `−12px`；只有 `.row/.group` 自身 12px padding 或 `.fieldSlot` 内部 `.field`/`.hintRow` 才应用对应补偿。section 直接末孩子为 `.hintRow` 时才用 `.section > .hintRow:last-child`。
- 不得运行时值导入任何 Harness Client 包；只允许 `import type`。不得打入第二份 React/ReactDOM 或 Host Client 包。所有可见文案至少提供 zh/en。
- 所有最终样式表必须参与跨插件类名交集检查和双向反向对照；真实页面必须量取计算样式，不能用源码字符串断言代替。
- 本地提交只允许在工作仓库内 `git add/commit`；未经用户另行明确授权，不 push、不创建 PR/issue、不启用或禁用其他插件。

## Review Focus

1. **渠道与凭据串用**：选择 WorkBuddy 时绝不能读取 CodeBuddy 的当前账号或 `copilot.tencent.com`；Qoder 国际版与中国版同样隔离。Task 5、6、7、8 的隔离测试负责。
2. **ON 失败变官方、OFF 又未恢复**：任何 ON 失败都不得进入 `next()`，OFF 必须恢复原官方准入、执行和费用行为。Task 3、4、16 的差分与 spy 测试负责。
3. **Qoder 自动端点造成重复配额或跨域**：固定模式不得重试另一域，自动模式只能在限定错误下双向切换一次且不换账号、不去中国版。Task 7 的策略矩阵负责。
4. **配置/账号切换、迟到响应和卸载破坏状态**：进行中的调用使用启动快照；卸载取消并等待在飞，旧代资源不得删除新代资源。Task 13、14、15 的 generation、快照、HMR 和 WASM 测试负责。
5. **动态 UI 与实际渠道不一致、双重 padding、控件不可访问**：下拉、状态和配置必须同源；其他三渠道无端点下拉；h3/fieldSlot/hintRow 不得被错误补偿。Task 13、14 的 DOM 测试与 Task 16 的真实计算样式、键盘和 CSS 隔离验收负责。

---

### Task 1: 可安装 Bundle、构建链与真实 Slot 骨架

**Files:**
- Create: `package.json`
- Create: `cordis.patch.yml`
- Create: `tsconfig.json`
- Create: `src/host/index.ts`
- Create: `src/client/index.ts`
- Create: `src/client/SettingsCard.tsx`
- Create: `src/client/styles/settings-card.module.css`
- Create: `scripts/build-client.mjs`
- Create: `scripts/verify-build.mjs`
- Create: `locale/zh.json`
- Create: `locale/en.json`
- Create: `icon.svg`
- Create: `README.md`
- Test: `tests/unit/build-manifest.spec.ts`

**Interfaces:**
- Produces: 包名 `dsh-web-search-channels`；Host `apply(ctx, config)`；Client lazy-CJS `apply(ctx)`；`plugins.bundle.config` key 与包名一致。

- [ ] **Step 1: 先写失败的 manifest/构建契约测试**

断言：版本 `0.1.0`；`exports['.']='./lib/index.js'`、`exports['./client']='./lib/client.js'`；patch 行 `id=name='dsh-web-search-channels'`；`dsh.client.platform='web'`。区分两层注入：`package.json.dsh.client.inject` 含 `@deepseek-ai/dsh-client-ui-plugin-manager`、`@deepseek-ai/dsh-client-ui-settings`、`@deepseek-ai/dsh-client-connection`、`@deepseek-ai/dsh-client-locale`；Client 模块运行时 `inject` 含 `slots,locale,configForms,connection`。最终产物不得含 Host Client 值导入或第二份 React。

- [ ] **Step 2: 运行测试，确认因骨架不存在而失败**

Run: `pnpm vitest run tests/unit/build-manifest.spec.ts`
Expected: FAIL，提示 `package.json` 或目标文件不存在。

- [ ] **Step 3: 实现最小可安装骨架**

若目录尚未初始化，只执行 `git init`，不添加 remote。Host 导出一个不注册业务能力的空 `apply`。Client 只渲染一张带 `.stack` 的“网页搜索渠道 / 设置加载中”骨架，不伪造搜索按钮或账号。`build-client.mjs` 用 esbuild 产出 CJS 后包成 `window.__ModuleLoader__.load({id:package.name,factory})`，React/ReactDOM external；CSS Modules 哈希 filename 带包名。locale 提供真实中英文 `meta.title/description`。

- [ ] **Step 4: 运行单测与构建，确认骨架和产物通过**

Run: `pnpm vitest run tests/unit/build-manifest.spec.ts && pnpm build && node scripts/verify-build.mjs`
Expected: 单测 PASS；`lib/index.js`、`lib/client.js` 生成；产物 key=包名，无禁用 import、无第二份 React。

- [ ] **Step 5: 主会话执行真实安装与 slot 冒烟**

主会话使用 `plugin_manager.install_bundle` 安装本目录，并在真实插件详情确认骨架出现于 `plugins.bundle.config`。不得用静态 HTML 代替。检查无 `slot entry crashed`，随后保留插件供后续任务迭代；若有渲染错误，先修骨架，不继续业务任务。

- [ ] **Step 6: 本地提交**

```bash
git add package.json cordis.patch.yml tsconfig.json src scripts locale icon.svg README.md tests/unit/build-manifest.spec.ts docs/superpowers
git commit -m "chore: add installable search channels bundle skeleton"
```

### Task 2: 四渠道注册表、设置服务与管理 RPC

**Files:**
- Create: `src/shared/channels.ts`
- Create: `src/shared/contracts.ts`
- Create: `src/shared/rpc.ts`
- Create: `src/host/config.ts`
- Create: `src/host/settings/service.ts`
- Create: `src/host/rpc.ts`
- Modify: `src/host/index.ts`
- Test: `tests/unit/channels.spec.ts`
- Test: `tests/unit/settings-service.spec.ts`
- Test: `tests/unit/management-rpc.spec.ts`

**Interfaces:**
- Produces: `ChannelId='buddy'|'workbuddy'|'qoder'|'qodercn'`；`CHANNELS:Readonly<Record<ChannelId,ChannelDefinition>>`；`SearchSettingsSnapshot`；`SettingsService.getSnapshot()/updateSearch(patch)/setCurrentAccount(channel,id)`；`callManagementRpc(connection,method,payload,signal)`。
- Produces: RPC `settings.get`、`settings.update`、`settings.setCurrentAccount`，统一 `{ok:true,value}|{ok:false,error}`。

- [ ] **Step 1: 写四渠道和设置服务的失败测试**

断言：四个下拉项及固定域分别为 `copilot.tencent.com`、`www.workbuddy.ai`、国际版 `center/api2`、中国版 `gateway.qoder.com.cn`；只有国际版有 `auto/center/api2`；默认 `enabled=false/channel=buddy`；四个 currentAccountId 均 null；非法渠道、非法端点偏好、跨渠道 currentAccount 写入均被拒绝。

- [ ] **Step 2: 运行测试，确认类型与实现缺失**

Run: `pnpm vitest run tests/unit/channels.spec.ts tests/unit/settings-service.spec.ts tests/unit/management-rpc.spec.ts`
Expected: FAIL，提示模块或导出不存在。

- [ ] **Step 3: 实现注册表、volatile Config、设置服务和通用 RPC**

`ChannelDefinition` 只描述本渠道能力、域名、配置类型和账号边界；协议族字段仅供实现复用。`SettingsService` 通过 `configEditor.edit` 写配置，成功后重读；失败不发布新快照。RPC 复用 JetHub 风格的 `connection.fetch.register` + `connection.rpc.call('/api','web-search-channels',{method,payload},signal)`，严格校验 method/payload，不返回秘密。

- [ ] **Step 4: 运行测试，确认设置与 RPC 通过**

Run: `pnpm vitest run tests/unit/channels.spec.ts tests/unit/settings-service.spec.ts tests/unit/management-rpc.spec.ts`
Expected: 全部 PASS；写失败时保持旧值，四个渠道配置互不串用。

- [ ] **Step 5: 本地提交**

```bash
git add src/shared src/host/config.ts src/host/settings src/host/rpc.ts src/host/index.ts tests/unit/channels.spec.ts tests/unit/settings-service.spec.ts tests/unit/management-rpc.spec.ts
git commit -m "feat: add channel registry and settings management"
```

### Task 3: 真实 DSH `tools/execute` 准入与短路 Spike

**Files:**
- Create: `src/host/tools/execute-listener.ts`
- Create: `src/host/drivers/mock-driver.ts`
- Create: `tests/integration/dsh-runtime.fixture.ts`
- Create: `tests/integration/tool-override.spec.ts`
- Create: `tests/integration/tool-admission.spec.ts`
- Create: `docs/spikes/tools-execute.md`

**Interfaces:**
- Consumes: Task 2 的 `search.enabled/channel`。
- Produces: `installSearchOverride(ctx,{settings,drivers,lifecycle})`；mock `SearchDriver.searchOnce(query,maxResults,signal)`。

- [ ] **Step 1: 先写真实工具管道失败测试**

用当前 DSH `0.2.2-rc.5` 的真实 Cordis、tool-web、tools pipeline 和 output render，不用手写 waterfall 替身代替整个宿主。断言：Native/PTC 均可解析 `web_search`；安装前 ON 无拦截时走官方 spy；安装后 OFF `next()`；ON 返回 `{value}` 经官方 schema/render；ON 无账号错误不调用官方。

- [ ] **Step 2: 运行集成测试，确认拦截器缺失导致失败**

Run: `pnpm vitest run tests/integration/tool-admission.spec.ts tests/integration/tool-override.spec.ts`
Expected: FAIL，提示 `installSearchOverride` 不存在或 ON 仍执行官方。

- [ ] **Step 3: 实现最小监听器与 mock 驱动**

顺序固定为：非 `web_search`→next；OFF→next；ON→校验 mock 参数并调用所选 mock 驱动→返回 `{value}`。不得读取聊天 Provider 决定接管，不得修改官方 web 配置。记录实际 listener 与 timeout 顺序到 spike 文档。

- [ ] **Step 4: 运行 Native/PTC 与 OFF 差分验证**

Run: `pnpm vitest run tests/integration/tool-admission.spec.ts tests/integration/tool-override.spec.ts`
Expected: 全部 PASS；ON 官方 spy=0，OFF 官方 spy=1；output schema/render 一致；web_fetch 始终 next。

- [ ] **Step 5: 若准入失败，停止后续任务**

若 Magpie 任一代表模型或 PTC 不含 `web_search`，不得删测试或继续批量开发。主会话回到产品决策：修复组合或另行设计条件 Shadow。

- [ ] **Step 6: 本地提交**

```bash
git add src/host/tools src/host/drivers/mock-driver.ts tests/integration docs/spikes/tools-execute.md
git commit -m "feat: prove web search execution override on current DSH"
```

### Task 4: 官方语义 SearchExecutor 与错误契约

**Files:**
- Create: `src/host/search/execution-profile.ts`
- Create: `src/host/search/executor.ts`
- Create: `src/host/search/errors.ts`
- Modify: `src/host/tools/execute-listener.ts`
- Test: `tests/unit/search-executor.spec.ts`
- Test: `tests/integration/search-output-contract.spec.ts`

**Interfaces:**
- Produces: `executeSearchQueries(args,{channel,driver,profile},signal):Promise<WebSearchValue>`；`SEARCH_DEFAULT_PROFILE={maxQueries:10,maxResults:10,summaryMaxChars:800}`；结构化 `ChannelSearchError`。

- [ ] **Step 1: 写参数、并发、合并与错误失败测试**

覆盖：非数组/空数组/11 queries/空白项；精确字符串去重；参数错误先于账号解析；首失败取消兄弟并等待 settle；rank 轮转；URL 去重；10 条 cap；`summary/publishedAt` 保留；无账号/401/429/超时/bad response 不 next。

- [ ] **Step 2: 运行测试，确认执行器不存在**

Run: `pnpm vitest run tests/unit/search-executor.spec.ts tests/integration/search-output-contract.spec.ts`
Expected: FAIL，提示 `executeSearchQueries` 未实现。

- [ ] **Step 3: 实现执行器并接入监听器**

参数校验先于驱动/账号工作。驱动接收 `query,maxResults,signal`；执行器只做官方语义，不读腾讯/Qoder 专属字段。错误直接抛给宿主规范错误结果，不 catch 后回退。

- [ ] **Step 4: 运行全部执行与 output 差分测试**

Run: `pnpm vitest run tests/unit/search-executor.spec.ts tests/integration/search-output-contract.spec.ts`
Expected: 全部 PASS；官方 output schema/render/presentationMeta 接受结果。

- [ ] **Step 5: 本地提交**

```bash
git add src/host/search src/host/tools/execute-listener.ts tests/unit/search-executor.spec.ts tests/integration/search-output-contract.spec.ts
git commit -m "feat: add canonical multi-query search executor"
```

### Task 5: CodeBuddy 与 WorkBuddy 独立搜索驱动

**Files:**
- Create: `src/host/channels/tencent/protocol.ts`
- Create: `src/host/channels/buddy/driver.ts`
- Create: `src/host/channels/workbuddy/driver.ts`
- Test: `tests/unit/tencent-protocol.spec.ts`
- Test: `tests/unit/buddy-driver.spec.ts`
- Test: `tests/unit/workbuddy-driver.spec.ts`

**Interfaces:**
- Produces: `createBuddyDriver(deps):SearchDriver`、`createWorkbuddyDriver(deps):SearchDriver`；共享 `postTencentSearch({host,accessToken,query,maxResults,signal})`。

- [ ] **Step 1: 写两端点、映射和账号隔离失败测试**

断言：buddy 只发 `copilot.tencent.com/agenttool/v1/search`；workbuddy 只发 `www.workbuddy.ai/agenttool/v1/search`；body 为 `{query,type:'text2text',max_results}`；两驱动不得读取对方 currentAccount/credential；无 token 不发请求；URL/title/snippet 映射、20s 与 abort 分类正确。

- [ ] **Step 2: 运行驱动测试，确认实现缺失**

Run: `pnpm vitest run tests/unit/tencent-protocol.spec.ts tests/unit/buddy-driver.spec.ts tests/unit/workbuddy-driver.spec.ts`
Expected: FAIL，提示驱动模块不存在。

- [ ] **Step 3: 提取腾讯协议并实现两个渠道驱动**

共享代码只负责 HTTP、响应防御与错误分类；每个驱动只注入自己的 host、账号解析和产品请求头。不得引入 `resolveCredentialFor`、余额选号或自动轮换。

- [ ] **Step 4: 运行测试，确认两渠道独立通过**

Run: `pnpm vitest run tests/unit/tencent-protocol.spec.ts tests/unit/buddy-driver.spec.ts tests/unit/workbuddy-driver.spec.ts`
Expected: 全部 PASS；任一渠道错误不会触发另一渠道或官方请求。

- [ ] **Step 5: 本地提交**

```bash
git add src/host/channels/tencent src/host/channels/buddy src/host/channels/workbuddy tests/unit/tencent-protocol.spec.ts tests/unit/buddy-driver.spec.ts tests/unit/workbuddy-driver.spec.ts
git commit -m "feat: add independent Buddy and WorkBuddy search drivers"
```

### Task 6: Qoder 共享签名生命周期与中国版搜索驱动

**Files:**
- Create: `src/host/channels/qoder/signer.ts`
- Create: `src/host/channels/qoder/protocol.ts`
- Create: `src/host/channels/qodercn/driver.ts`
- Create: `assets/qoder/qoder-auth-wasm.wasm`
- Test: `tests/unit/qoder-signer.spec.ts`
- Test: `tests/unit/qodercn-driver.spec.ts`

**Interfaces:**
- Produces: `QoderSigner.prepare(host,path,body,credential,signal):Promise<PreparedRequest>`、`QoderSigner.dispose()`；`createQoderCnDriver(deps):SearchDriver`。

- [ ] **Step 1: 写真实 WASM 与固定中国版端点失败测试**

断言：签名输入 path 为 `/api/v1/webSearch/oneSearch`，实发由 WASM 生成 `/algo/...?Encode=1`；host 只能 `gateway.qoder.com.cn`；`pageItems.link→url`、title/snippet、合法 `publishedTime→publishedAt`；无 token/machine_id 不发请求；成功和失败均 dispose，不输出签名头或秘密。

- [ ] **Step 2: 运行测试，确认签名器与驱动缺失**

Run: `pnpm vitest run tests/unit/qoder-signer.spec.ts tests/unit/qodercn-driver.spec.ts`
Expected: FAIL，提示模块或 WASM 资产缺失。

- [ ] **Step 3: 提取并裁剪 COSY/WASM 与 Qoder 协议**

保留真实签名，不 mock WASM。 signer 明确唯一所有者和在飞计数；协议只处理请求/响应与中国版产品参数，不包含国际版或账号池逻辑。WASM 文件进入 package `files` 与构建校验。

- [ ] **Step 4: 运行真实签名与驱动测试**

Run: `pnpm vitest run tests/unit/qoder-signer.spec.ts tests/unit/qodercn-driver.spec.ts`
Expected: 全部 PASS；mock fetch 收到真实签名请求，异常路径无 WASM 泄漏。

- [ ] **Step 5: 本地提交**

```bash
git add src/host/channels/qoder src/host/channels/qodercn assets/qoder tests/unit/qoder-signer.spec.ts tests/unit/qodercn-driver.spec.ts package.json
git commit -m "feat: add Qoder CN signed search and signer lifecycle"
```

### Task 7: Qoder 国际版驱动与双域自动策略

**Files:**
- Create: `src/host/channels/qoder/endpoint-policy.ts`
- Create: `src/host/channels/qoder/driver.ts`
- Test: `tests/unit/qoder-endpoint-policy.spec.ts`
- Test: `tests/unit/qoder-driver.spec.ts`

**Interfaces:**
- Produces: `QoderEndpointPolicy.execute({preference,accountKey,operation,signal})`；`createQoderInternationalDriver(deps):SearchDriver`。

- [ ] **Step 1: 写自动/固定/持久成功域/错误类别失败测试**

断言：auto 无最近成功记录时初始 center；连接失败/超时/5xx 可在 center↔api2 间切换一次，并在本机全局持久保存最近成功域供后续与重启后优先使用；401/403/429/bad response 不切换；固定 center/api2 任何错误不切换且忽略该记录；两域失败返回可归因错误；绝不出现 gateway、并行双发、后台测速、虚构网络出口 ID 或换账号。

- [ ] **Step 2: 运行策略测试，确认实现缺失**

Run: `pnpm vitest run tests/unit/qoder-endpoint-policy.spec.ts tests/unit/qoder-driver.spec.ts`
Expected: FAIL，提示策略或国际版驱动不存在。

- [ ] **Step 3: 实现策略与国际版驱动**

自动模式只在本机全局保存一个最近成功域，所有 Qoder 国际版账号共用；无记录时从 center 开始，后续调用及重启后优先最近成功域，换账号不清空。单 query 最多两域各一次；正常多 query 兄弟不重复。记录脱敏实际域名、耗时和错误类别。固定模式只走用户选定域并忽略最近成功记录，不使用虚构网络出口 ID。

- [ ] **Step 4: 运行策略与驱动测试**

Run: `pnpm vitest run tests/unit/qoder-endpoint-policy.spec.ts tests/unit/qoder-driver.spec.ts`
Expected: 全部 PASS；固定与自动行为严格分离，无跨渠道调用。

- [ ] **Step 5: 本地提交**

```bash
git add src/host/channels/qoder/endpoint-policy.ts src/host/channels/qoder/driver.ts tests/unit/qoder-endpoint-policy.spec.ts tests/unit/qoder-driver.spec.ts
git commit -m "feat: add Qoder international endpoint policy"
```

### Task 8: 四渠道凭据库、当前账号与账号管理 RPC

**Files:**
- Create: `src/shared/accounts.ts`
- Create: `src/host/accounts/store.ts`
- Create: `src/host/accounts/service.ts`
- Create: `src/host/accounts/rpc-methods.ts`
- Modify: `src/host/rpc.ts`
- Modify: `src/host/channels/buddy/driver.ts`
- Modify: `src/host/channels/workbuddy/driver.ts`
- Modify: `src/host/channels/qoder/driver.ts`
- Modify: `src/host/channels/qodercn/driver.ts`
- Test: `tests/unit/account-store.spec.ts`
- Test: `tests/unit/account-service.spec.ts`
- Test: `tests/unit/account-rpc.spec.ts`

**Interfaces:**
- Produces: `AccountSummary`、`AccountStatus`、`AccountService.list(channel)/getCurrent(channel)/setCurrent(channel,id)/delete(channel,id,replacement?)/resolveCurrentCredential(channel)/clearAll()`；RPC `accounts.list/current/setCurrent/delete/clearAll`。

- [ ] **Step 1: 写凭据隔离与账号生命周期失败测试**

断言：record ID 与 payload 均含 channelId；credential key 的 scope/id 两段均满足 `^[a-z][a-z0-9-]*$`，账号记录使用生成的稳定小写 ID 而不是直接拿邮箱或厂商原始 ID 拼 key；跨 channel resolve 失败；账号管理 RPC 不含 token/refresh/machine_id（Qoder 授权 URL 的 `machine_id` 窄例外见 Global Constraints）；首账号可设当前；删除当前不自动递补，只有显式 replacement 才替换；clearAll 需显式用户调用；写失败保持旧快照。

- [ ] **Step 2: 运行测试，确认账号域缺失**

Run: `pnpm vitest run tests/unit/account-store.spec.ts tests/unit/account-service.spec.ts tests/unit/account-rpc.spec.ts`
Expected: FAIL，提示账号服务不存在。

- [ ] **Step 3: 实现 credentials store、账号服务和 RPC**

使用本插件 scope 的 grant records；账号 ID 生成稳定小写 slug，厂商原始账号身份只作为 payload 内的去重依据，不直接充当 credential key。Client DTO 仅含 id、displayName、channelId、端点标签、状态和脱敏标识。把四个搜索驱动接到 `resolveCurrentCredential(channel)`，不得提供按协议族选号接口。

- [ ] **Step 4: 运行账号与驱动隔离测试**

Run: `pnpm vitest run tests/unit/account-*.spec.ts tests/unit/buddy-driver.spec.ts tests/unit/workbuddy-driver.spec.ts tests/unit/qoder-driver.spec.ts tests/unit/qodercn-driver.spec.ts`
Expected: 全部 PASS；跨渠道记录永远不可用于执行。

- [ ] **Step 5: 本地提交**

```bash
git add src/shared/accounts.ts src/host/accounts src/host/rpc.ts src/host/channels tests/unit/account-*.spec.ts tests/unit/buddy-driver.spec.ts tests/unit/workbuddy-driver.spec.ts tests/unit/qoder-driver.spec.ts tests/unit/qodercn-driver.spec.ts
git commit -m "feat: add isolated channel accounts and credential storage"
```

### Task 9: CodeBuddy 独立授权与刷新流程

**Files:**
- Create: `src/host/channels/tencent/auth-flow.ts`
- Create: `src/host/channels/buddy/auth.ts`
- Create: `src/host/channels/buddy/auth-rpc.ts`
- Test: `tests/unit/buddy-auth.spec.ts`

**Interfaces:**
- Produces: `BuddyAuthFlow.start/cancel/status/refresh/reauthenticate`；RPC `auth.start/cancel/status/refresh`，payload 必须含 `channel:'buddy'`。

- [ ] **Step 1: 写 CodeBuddy external-link 生命周期失败测试**

覆盖授权 URL 获取、轮询、取消、超时、成功落码、刷新单飞、401 后同账号最多重试一次、重新登录；不得使用 WorkBuddy 产品参数或返回秘密。

- [ ] **Step 2: 运行测试，确认流程缺失**

Run: `pnpm vitest run tests/unit/buddy-auth.spec.ts`
Expected: FAIL，提示 `BuddyAuthFlow` 不存在。

- [ ] **Step 3: 提取并实现 CodeBuddy 授权流程**

可共享腾讯 external-link 底层状态机，但产品 platform、host、账号记录和刷新状态固定 buddy。所有网络使用可注入 fetcher；授权/重新登录只可从用户 RPC 触发。

- [ ] **Step 4: 运行授权测试**

Run: `pnpm vitest run tests/unit/buddy-auth.spec.ts`
Expected: 全部 PASS；取消与卸载无迟到写入，无跨渠道记录。

- [ ] **Step 5: 本地提交**

```bash
git add src/host/channels/tencent/auth-flow.ts src/host/channels/buddy/auth.ts src/host/channels/buddy/auth-rpc.ts tests/unit/buddy-auth.spec.ts
git commit -m "feat: add CodeBuddy account authorization lifecycle"
```

### Task 10: WorkBuddy 独立授权与刷新流程

**Files:**
- Create: `src/host/channels/workbuddy/auth.ts`
- Create: `src/host/channels/workbuddy/auth-rpc.ts`
- Test: `tests/unit/workbuddy-auth.spec.ts`

**Interfaces:**
- Produces: `WorkbuddyAuthFlow.start/cancel/status/refresh/reauthenticate`；payload 必须含 `channel:'workbuddy'`。

- [ ] **Step 1: 写 WorkBuddy 产品参数与独立账号失败测试**

断言：host 只能 `www.workbuddy.ai`，使用 workbuddy 产品授权参数与账号记录；CodeBuddy 成功状态不能使 WorkBuddy ready；取消、刷新、重新登录、401 重试和迟到响应行为独立。

- [ ] **Step 2: 运行测试，确认流程缺失**

Run: `pnpm vitest run tests/unit/workbuddy-auth.spec.ts`
Expected: FAIL，提示 `WorkbuddyAuthFlow` 不存在。

- [ ] **Step 3: 实现 WorkBuddy 授权流程**

复用 Task 9 的协议状态机，但绝不共享 currentAccount、credential 或运行时刷新状态。不得用“腾讯账号已登录”作为跨渠道 ready 判据。

- [ ] **Step 4: 运行两个腾讯授权隔离测试**

Run: `pnpm vitest run tests/unit/buddy-auth.spec.ts tests/unit/workbuddy-auth.spec.ts`
Expected: 全部 PASS；两流程互不改变账号或配置。

- [ ] **Step 5: 本地提交**

```bash
git add src/host/channels/workbuddy/auth.ts src/host/channels/workbuddy/auth-rpc.ts tests/unit/workbuddy-auth.spec.ts
git commit -m "feat: add WorkBuddy account authorization lifecycle"
```

### Task 11: Qoder 国际版授权、刷新与签名配置

**Files:**
- Create: `src/host/channels/qoder/auth-flow.ts`
- Create: `src/host/channels/qoder/auth.ts`
- Create: `src/host/channels/qoder/auth-rpc.ts`
- Test: `tests/unit/qoder-auth.spec.ts`

**Interfaces:**
- Produces: `QoderInternationalAuthFlow.start/cancel/status/refresh/reauthenticate`；payload 必须含 `channel:'qoder'`。

- [ ] **Step 1: 写国际版授权与刷新失败测试**

覆盖设备授权、取消、超时、国际版 client ID、账号身份去重、刷新单飞、401 同账号重试一次、签名所需秘密保存；`machine_id` 只允许作为发起流程授权 URL 的 `machine_id` 查询参数，不得进入其他状态/DTO/普通配置；不得使用中国版 client ID 或 gateway。

- [ ] **Step 2: 运行测试，确认流程缺失**

Run: `pnpm vitest run tests/unit/qoder-auth.spec.ts`
Expected: FAIL，提示国际版授权流程不存在。

- [ ] **Step 3: 提取并实现国际版授权与签名配置**

授权服务与搜索端点偏好分离；center/api2 只影响搜索，不改变授权账号。Client 只收到等待/成功/失败等脱敏状态（Qoder 授权 URL 的 `machine_id` 窄例外见 Global Constraints）。

- [ ] **Step 4: 运行授权与签名配置测试**

Run: `pnpm vitest run tests/unit/qoder-auth.spec.ts tests/unit/qoder-signer.spec.ts`
Expected: 全部 PASS；无秘密输出、无中国版配置混入。

- [ ] **Step 5: 本地提交**

```bash
git add src/host/channels/qoder/auth-flow.ts src/host/channels/qoder/auth.ts src/host/channels/qoder/auth-rpc.ts tests/unit/qoder-auth.spec.ts
git commit -m "feat: add Qoder international authorization lifecycle"
```

### Task 12: Qoder 中国版授权与刷新流程

**Files:**
- Create: `src/host/channels/qodercn/auth.ts`
- Create: `src/host/channels/qodercn/auth-rpc.ts`
- Test: `tests/unit/qodercn-auth.spec.ts`

**Interfaces:**
- Produces: `QoderCnAuthFlow.start/cancel/status/refresh/reauthenticate`；payload 必须含 `channel:'qodercn'`。

- [ ] **Step 1: 写中国版独立 client ID、host 与账号失败测试**

断言：授权服务与中国版 client ID、账号记录、`gateway.qoder.com.cn` 一致；国际版授权成功不能使中国版 ready；取消、超时、刷新和重新登录均不串用国际版记录。

- [ ] **Step 2: 运行测试，确认流程缺失**

Run: `pnpm vitest run tests/unit/qodercn-auth.spec.ts`
Expected: FAIL，提示中国版授权流程不存在。

- [ ] **Step 3: 实现中国版授权流程**

复用 Qoder 授权协议状态机，独立配置与账号域。不得把国际版历史跨域搜索成功当作中国版授权可用的证据。

- [ ] **Step 4: 运行两个 Qoder 授权隔离测试**

Run: `pnpm vitest run tests/unit/qoder-auth.spec.ts tests/unit/qodercn-auth.spec.ts`
Expected: 全部 PASS；两套 client ID、host 和账号记录不混用。

- [ ] **Step 5: 本地提交**

```bash
git add src/host/channels/qodercn/auth.ts src/host/channels/qodercn/auth-rpc.ts tests/unit/qodercn-auth.spec.ts
git commit -m "feat: add Qoder CN authorization lifecycle"
```

### Task 13: SearchSection、动态 ChannelConfigHost 与 rc5 控件

**Files:**
- Create: `docs/ui/settings-card-profile.md`
- Modify: `src/client/SettingsCard.tsx`
- Create: `src/client/SearchSection.tsx`
- Create: `src/client/ChannelConfigHost.tsx`
- Create: `src/client/controllers/settings.ts`
- Create: `src/client/components/Switch.tsx`
- Create: `src/client/components/Dropdown.tsx`
- Modify: `src/client/styles/settings-card.module.css`
- Modify: `src/client/index.ts`
- Test: `tests/client/search-section.spec.tsx`
- Test: `tests/client/channel-config-host.spec.tsx`
- Test: `tests/unit/settings-card-profile.spec.ts`

**Interfaces:**
- Consumes: Task 2 的设置快照与 RPC、Task 1 的真实 slot。
- Produces: `SearchSection`、`ChannelConfigHost({channel,children})`、自有 `Switch/Dropdown`；`docs/ui/settings-card-profile.md` 完整剖面。

- [ ] **Step 1: 先写完整剖面与失败 DOM/控制器测试**

剖面必须从 `.stack` 顶到底列出 search section、分隔线、四个条件渠道配置、Qoder 国际版端点行、fieldSlot/hintRow 和所有包装层 padding，不拆段。测试断言：同一 channel 驱动下拉/状态/配置；OFF 用 lockedHint 替换渠道说明；OFF 下方配置区整体灰化且仅 clear-all 可用；保存失败回滚； busy 锁定；无第二查看选择器。

- [ ] **Step 2: 运行测试，确认组件与剖面缺失**

Run: `pnpm vitest run tests/client/search-section.spec.tsx tests/client/channel-config-host.spec.tsx tests/unit/settings-card-profile.spec.ts`
Expected: FAIL，提示组件或完整剖面不存在。

- [ ] **Step 3: 实现 rc5 自有控件与动态搜索区**

Switch 必须 `role=switch/aria-checked/aria-label`，36×20、thumb16、120ms、disabled .5。Dropdown 锚点 34px/`0 12px`，Menu 项 34/6 8/gap6/13 20，portal+autoFocus+minWidthFromAnchor，选择后焦点回 trigger。不得运行时 import Host Client 包。设置控制器用 `configForms.get('dsh-web-search-channels')` 读取与订阅快照，写入只走 Task 2 的 settings RPC；slot props 不读取 `form`（rc.3 实测 bundle.config 不传 `form`，该结论需在 rc.5 复核后沿用）。

- [ ] **Step 4: 实现动态配置与精确布局**

`.stack gap:0`；`.row padding:12px 0`；跨 section 16+16；h3→首行由该行 padding-top 12；h3 不命中补偿；`.fieldSlot padding:0`，内部 `.field padding:12px 0; gap:6px`；hintRow 只在其实际 DOM 所属层参与补偿。配置保存成功后才切视图。

- [ ] **Step 5: 运行 DOM、控制器与剖面检查**

Run: `pnpm vitest run tests/client/search-section.spec.tsx tests/client/channel-config-host.spec.tsx tests/unit/settings-card-profile.spec.ts`
Expected: 全部 PASS；动态配置与运行渠道一致，无双重 padding 或 h3 补偿。

- [ ] **Step 6: 本地提交**

```bash
git add docs/ui src/client tests/client tests/unit/settings-card-profile.spec.ts
git commit -m "feat: add dynamic search settings and rc5 controls"
```

### Task 14: 四渠道账号 UI、内联授权与国际版端点行

**Files:**
- Create: `src/client/AccountChannelConfig.tsx`
- Create: `src/client/AccountList.tsx`
- Create: `src/client/InlineAuthFlow.tsx`
- Create: `src/client/InlineDeleteConfirmation.tsx`
- Create: `src/client/QoderEndpointRow.tsx`
- Create: `src/client/controllers/accounts.ts`
- Modify: `src/client/ChannelConfigHost.tsx`
- Modify: `src/client/styles/settings-card.module.css`
- Test: `tests/client/account-channel-config.spec.tsx`
- Test: `tests/client/qoder-endpoint-row.spec.tsx`
- Test: `tests/client/inline-auth-flow.spec.tsx`

**Interfaces:**
- Consumes: Task 8 账号 RPC、Tasks 9–12 授权 RPC、Task 2 设置快照。
- Produces: 单一 `AccountChannelConfig(channel)`、`QoderEndpointRow(preference,onChange,actualHost)`。

- [ ] **Step 1: 写四渠道配置与端点行失败测试**

断言：任一时刻只显示当前渠道账号；添加/重登/删除就地展开；首账号可设当前，删除不自动递补；只有 qoder 出现 `auto/center/api2` 下拉，其他三渠道只显示固定文本；不出现 gateway 或第二配置选择器。

- [ ] **Step 2: 运行测试，确认账号 UI 缺失**

Run: `pnpm vitest run tests/client/account-channel-config.spec.tsx tests/client/qoder-endpoint-row.spec.tsx tests/client/inline-auth-flow.spec.tsx`
Expected: FAIL，提示账号组件不存在。

- [ ] **Step 3: 实现账号列表、内联操作和授权流程**

当前账号、备选、状态、添加、取消、重新登录、删除确认全部在当前渠道区内完成。异步 generation 丢弃迟到结果；授权 busy 锁主渠道下拉；invalid 红字不被门控覆盖；Client 不保存秘密。

- [ ] **Step 4: 实现 Qoder 国际版端点偏好与状态**

下拉只有自动/center/api2；自动显示实际 host；固定模式只显示所选 host；OFF 时端点下拉随下方配置区整体灰化禁用，clear-all 除外。端点保存失败回滚，实际 host 不改变用户 preference。

- [ ] **Step 5: 运行账号与端点 UI 测试**

Run: `pnpm vitest run tests/client/account-channel-config.spec.tsx tests/client/qoder-endpoint-row.spec.tsx tests/client/inline-auth-flow.spec.tsx`
Expected: 全部 PASS；四渠道配置不串用，端点控件只出现在国际版。

- [ ] **Step 6: 本地提交**

```bash
git add src/client tests/client
git commit -m "feat: add channel accounts and inline authorization UI"
```

### Task 15: 在飞调用、HMR、卸载与 WASM 生命周期闭环

**Files:**
- Create: `src/host/lifecycle.ts`
- Create: `src/host/inflight.ts`
- Modify: `src/host/index.ts`
- Modify: `src/host/channels/qoder/signer.ts`
- Modify: `src/client/controllers/settings.ts`
- Modify: `src/client/controllers/accounts.ts`
- Test: `tests/integration/plugin-lifecycle.spec.ts`
- Test: `tests/integration/hmr-generation.spec.ts`
- Test: `tests/unit/inflight.spec.ts`

**Interfaces:**
- Produces: `PluginLifecycle.track(promise,signal)/abortAllAndSettle()/dispose()`；`InFlight`； signer owner 的引用计数与最终 dispose。

- [ ] **Step 1: 写 OFF、切换、卸载与 HMR 失败测试**

断言：OFF 不取消旧调用但新调用 next；切换使用启动快照；卸载先阻止新调用、abort 并等待全部 settle；旧代 disposer 不删除新代资源；迟到授权不写账号；WASM 在在飞归零后释放。

- [ ] **Step 2: 运行生命周期测试，确认闭环缺失**

Run: `pnpm vitest run tests/unit/inflight.spec.ts tests/integration/plugin-lifecycle.spec.ts tests/integration/hmr-generation.spec.ts`
Expected: FAIL，提示生命周期协调器不存在或资源残留。

- [ ] **Step 3: 实现生命周期与异步 generation**

监听器和订阅由根 effect 持有；授权、刷新、搜索纳入 in-flight；Client 控制器丢弃卸载后回包；WASM owner 仅在在飞归零后释放。不得留下后台测速任务（首版本就不实现）。

- [ ] **Step 4: 运行全部生命周期与既有集成测试**

Run: `pnpm vitest run tests/unit/inflight.spec.ts tests/integration/plugin-lifecycle.spec.ts tests/integration/hmr-generation.spec.ts tests/integration/tool-override.spec.ts`
Expected: 全部 PASS；无监听器、登录轮询、在飞或 WASM 残留。

- [ ] **Step 5: 本地提交**

```bash
git add src/host/lifecycle.ts src/host/inflight.ts src/host/index.ts src/host/channels/qoder/signer.ts src/client/controllers tests/integration/plugin-lifecycle.spec.ts tests/integration/hmr-generation.spec.ts tests/unit/inflight.spec.ts
git commit -m "feat: close plugin and signer lifecycle across reloads"
```

### Task 16: 全量验证、真实矩阵与发布证据

**Files:**
- Create: `scripts/verify-css-isolation.mjs`
- Create: `scripts/verify-package.mjs`
- Create: `docs/verification/2026-11-18-0.1.0.md`
- Modify: `README.md`
- Modify: `package.json`
- Test: `tests/integration/required-runtime-matrix.spec.ts`
- Test: `tests/integration/release-gates.spec.ts`

**Interfaces:**
- Produces: `pnpm verify`、CSS 隔离反向对照、真实运行矩阵记录、四渠道人工授权验收记录、发布证据文档。

- [ ] **Step 1: 先写发布门禁失败测试**

断言：全部单元/客户端/集成测试被发现并执行；最终样式表全部参与类名交集；双方旧哈希同时还原时检查必须失败；package `files` 包含 Host、Client、locale、icon、WASM、README；产物无 Host Client 值导入和第二份 React；无 Fetch 配置键或 UI。README/locale 还必须披露数据会发送给所选厂商、OFF 行为、自动端点切换可能产生第二次上游请求、JetHub 搜索接管互斥，以及 `0.1.0` 不包含 Fetch。

- [ ] **Step 2: 运行门禁，确认验证脚本缺失**

Run: `pnpm vitest run tests/integration/release-gates.spec.ts`
Expected: FAIL，提示 CSS/package 验证脚本或证据文档缺失。

- [ ] **Step 3: 实现验证脚本并运行完整静态门禁**

Run: `pnpm test && pnpm test:integration && pnpm build && node scripts/verify-build.mjs && node scripts/verify-css-isolation.mjs && node scripts/verify-package.mjs`
Expected: 全部 PASS；反向对照按预期 FAIL 后被门禁识别；所有声明测试实际执行，无跳过的必测项。

- [ ] **Step 4: 主会话完成真实 DSH 运行矩阵**

在真实 Desktop 0.2.2-rc.5 中分别创建 Native 与 PTC 测试 Session，使用 Magpie/WPS 灵犀的 Kimi-K3.1 Pro 和 DeepSeek V4.1 Flash，验证 ON/OFF、无账号 fail-closed、官方 output 和 PTC binding。DeepSeek 官方路由只做 OFF 差分；任何真实 DeepSeek 付费搜索必须另行征得用户当次确认，不能用 mock 结果冒充真实免费。

- [ ] **Step 5: 主会话与用户配合完成四渠道真实账号验收**

分别由用户在本插件中完成 CodeBuddy、WorkBuddy、Qoder 国际版、Qoder 中国版独立登录。每渠道验证刷新、重新登录和一次真实单 query 搜索；不得导入旧 token，不得把凭据写入报告。任一渠道失败都阻断发布并保留失败记录。

- [ ] **Step 6: 主会话完成真实设置页与 CSS 验收**

在真实插件详情逐项量取：34px 下拉、36×20 Switch、24/32/6/16 间距、h3 不补偿、fieldSlot padding 0、hintRow 归属；验证 OFF 说明替换与下方配置区整体灰化（仅 clear-all 可用）、动态配置同源、Qoder 独有端点下拉、键盘/焦点/Escape、390px、深浅主题、zh/en。对所有最终样式表做跨插件交集与双向反向对照，至少覆盖同级已构建的 `dsh-project-groups` 与 `dsh-auto-expand`，并保存必要截图与计算样式证据。

- [ ] **Step 7: 记录证据并做最终本地提交**

在 `docs/verification/2026-11-18-0.1.0.md` 中逐项记录命令、结果、未验证边界和真实账号验收。只有 Global Constraints 的必测项全部通过才可写“0.1.0 验证完成”；否则保留阻断，不得发布。

```bash
git add scripts package.json README.md docs/verification tests/integration/required-runtime-matrix.spec.ts tests/integration/release-gates.spec.ts
git commit -m "test: add search channels release verification gates"
```

## Execution Handoff

用户已明确要求主会话以团队方式统筹：V4.1 Flash 负责快速执行与核验，K3.1 Pro 负责讨论、探索和高难度任务。计划确认后使用 subagent-driven-development，每个任务由新的实现者与新的审查者完成，主会话负责接口协调、真实安装、浏览器验收、用户授权流程和最终整体验证。

`0.2.0` 的 CodeBuddy / WorkBuddy Fetch 不在本计划内，不提前创建配置键、UI 或适配器。
