# Web Search Replacement (`dsh-web-search-replace`)

让任意声明支持的模型都能通过用户显式选择的 CodeBuddy、WorkBuddy、
Qoder 国际版或 Qoder 中国版独立账号完成网页搜索，不再把网页搜索能力绑定在
DeepSeek 模型渠道上。`0.1.0` 只接管 `web_search`；`web_fetch` 保持官方实现不变。

- 包名：`dsh-web-search-replace`
- 当前版本：`0.1.0`
- 目标运行环境：DeepSeek Harness Desktop `0.2.2-rc.5` 及其自带 Web GUI

## 当前状态

本仓库已完成自动化静态门禁：全量单元/客户端/集成测试发现、构建产物契约、
跨插件 CSS 隔离（含反向对照）、真实 `pack --dry-run`、README/locale 披露检查。
这些只是代码与打包层面的证据。

真实 Desktop/Web GUI、Native/PTC、指定模型、四个厂商账号和浏览器计算样式
验收**尚未执行**，逐项状态见
[`docs/verification/2026-11-18-0.1.0.md`](docs/verification/2026-11-18-0.1.0.md)：
真实项全部为 **NOT RUN** 或 **PENDING**。因此：

> **0.1.0 尚未完成发布验收**，不得据此宣称发布完成或对外分发。

## 功能与 OFF 行为

- Host 通过 Cordis `tools/execute` 监听器接管 `web_search`，使用官方 output
  schema/render 返回 `{ value }`。
- **OFF**（`search.enabled=false`）：在任何账号、凭据、WASM 或网络工作之前直接
  `next()`，完整交还官方 `web_search` 的准入、执行与费用行为；不取消已经开始
  的厂商请求，但后续调用都走官方。
- **ON**：只调用当前所选渠道的当前账号执行搜索。任何账号、配置、渠道或上游
  错误都形成结构化错误，绝不静默回退官方或 DeepSeek。
- 非 `web_search` 工具以及 `web_fetch` 始终 `next()`，不会被本插件改写。

## 数据会发送给所选厂商

开启搜索后，查询文本与执行搜索所需的请求会发送给所选渠道的厂商域名：

| 渠道 | 厂商域名 |
| --- | --- |
| CodeBuddy | `copilot.tencent.com` |
| WorkBuddy | `www.workbuddy.ai` |
| Qoder 国际版 | `center.qoder.sh` / `api2.qoder.sh` |
| Qoder 中国版 | `gateway.qoder.com.cn` |

插件不会把搜索请求发送给 DeepSeek；OFF 时也完全不做厂商账号或网络工作。
账号 token、刷新材料与签名秘密只保存在本插件的 Host-only credentials 记录中，
Client 只接收脱敏 DTO；日志、Session 事件、错误与验收报告都不写入凭据。

## Qoder 国际版自动端点

只有 Qoder 国际版有 `auto / center / api2` 端点偏好；另外三个渠道固定使用各自
域名。自动模式在**没有最近成功记录**时从 `center.qoder.sh` 开始，只在
DNS/TCP/TLS 连接失败、明显超时或上游 5xx 时顺序尝试另一域名一次；
401/403/429、响应格式错误和账号/签名问题不触发跨域重试。

若第一域已经处理请求后才返回 5xx 或传输失败，自动切换可能产生**第二次上游
请求与额外配额**；自动模式不是零成本测速，不做并行双发或后台测速。

成功域名作为本机全局的**最近成功域**持久保存于 Host-only 记录
`dsh-web-search-replace/qoder-last-successful-host`：所有 Qoder 国际版账号共用，
DSH 重启后仍优先使用，换账号不清空。网络环境变化后，旧优选域可能先失败一次再
自动纠正；固定 `center`/`api2` 模式不切换且忽略该记录。

## 账号生命周期

包名从 `dsh-web-search-channels` 改为 `dsh-web-search-replace` 后，Host 在首次
activation 时会把旧 credentials scope `dsh-web-search-channels` 下的账号记录与
Qoder 最近成功域记录一次性迁移到新 scope，并在复制成功后删除旧 scope 记录；
迁移失败时 activation 失败并保留旧记录供下次重试，旧 scope 不会继续作为运行时
读取入口。

四个渠道的账号、当前账号、凭据和刷新状态完全独立，不跨渠道复用。设置页可就地
添加账号、重新登录、设置当前账号、删除账号，以及显式清除全部账号数据。每个账号另有
独立「测试」按钮，由用户点击后通过 `accounts.test` 管理 RPC 发起真实 Search 能力探测；
60 秒 deadline，可取消，成功/明确 401/其他服务错误分别更新为 ready/reauth_required/
temporarily_unavailable，坏记录为 credential_unavailable。测试只更新该账号，不切换当前账号；
OFF 时禁用，不会自动测试。探测会向所选厂商发送 `capability probe` 查询；Qoder 国际版
auto 仍遵守限定第二域规则，可能产生额外请求。
删除当前账号不会自动递补其他账号；搜索会保持 fail-closed，直到用户显式选择。
登录、授权、账号测试、删除和清除数据只由用户在设置页触发，不开放 Agent tool。

凭据刷新由 Host 自动完成：access grant 距过期不超过 60 秒或已过期时，首次搜索
operation 前按账号单飞刷新；收到明确 HTTP 401 时，也只刷新同一渠道、同一账号并
重试原请求一次。refresh grant 已过期会要求重新登录。设置页没有独立“手动刷新”
按钮；自动临期/401 刷新不等于另设用户操作入口。

## 与 JetHub 搜索接管互斥

本插件把 `web_search` 执行接管视为单一所有者扩展点。与 JetHub 同时安装时，
用户必须关闭 JetHub 的“渠道原生搜索”。`0.1.0` 不承诺多个搜索接管插件自动协调
waterfall，也不声称能通用检测所有监听器冲突。

## 0.1.0 范围

- 只实现 Search；不创建 Fetch 配置键、UI 或空适配器。
- `web_fetch` 始终由官方处理，`0.1.0` **不包含 Fetch**。
- CodeBuddy / WorkBuddy 的 Fetch 属于后续 `0.2.0` 范围，本版本没有相关配置键、
  UI 或适配器，也不会为它预留开关。

## 构建与验证

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test                                # 全部 unit/client/integration
pnpm test:integration                    # tests/integration
node scripts/verify-build.mjs            # 产物契约：apply、lazy factory、无禁用导入、无第二份 React
node scripts/verify-css-isolation.mjs    # 全部最终样式表 × 同级已构建插件类名交集
node scripts/verify-css-isolation.mjs --reverse-control
node scripts/verify-package.mjs          # 真实 pack --dry-run 内容、导入纯度、Fetch、秘密、披露
pnpm verify                              # 聚合以上静态门禁
```

默认（不设置该变量）按当前基线 `0.2.2-rc.5` 校验：

```powershell
pnpm test
```

如需在其他兼容版本上做对照验证，可显式覆盖期望版本：

```powershell
$env:DSH_TEST_EXPECTED_VERSION='0.2.2-rc.3'; pnpm test
```

显式覆盖只影响本次测试断言，不改变 `0.2.2-rc.5` 的基线与最终验收目标。

`verify-css-isolation` 直接读取同级现有只读构建产物
`dsh-project-groups/lib/client.js`、`dsh-auto-expand/lib/client.js`；反向对照只在
系统临时目录的副本中同时还原双方旧哈希并证明冲突会被识别，不重建、不修改、
不启用或停用其他插件。

`verify-package` 使用真实 `pack --dry-run` 文件清单，既检查 Host/Client/locale/
icon/WASM/README/patch 是否齐全，也检查源码、测试、文档与锁文件没有混入发布包。
运行环境必须在 `PATH` 中提供 **npm CLI**；脚本固定调用 `npm pack --dry-run
--ignore-scripts`，通过异步 `shell:false` 启动，找不到 npm CLI 时直接失败。没有
pnpm 回退，也不会为了规避环境要求而恢复可能执行安装脚本的 fallback。

## 安装

在 DSH 的 **Plugins** 页面用 **Add plugin** 安装本目录，或由
`plugin_manager.install_bundle` 指向本目录。安装后 bundle 详情页的配置区应出现
“Web Search Replacement”设置卡；真实安装与呈现仍属于上面的未完成验收项。

## 已知边界

- 真实 `0.2.2-rc.5` Desktop、Web GUI、Native/PTC、Kimi-K3.1 Pro、
  DeepSeek V4.1 Flash、四渠道真实账号与浏览器计算样式/截图均未验收。
- 多插件同时接管 `web_search` 时不自动协调；必须手动关闭 JetHub 的搜索接管。
- Qoder 自动端点依赖厂商网络可达性；换网络后可能需要一次失败才能纠正优选域，
  且限定故障下的第二次请求可能产生额外配额。
- 本版本不实现 Fetch；不承诺 standalone Web、Headless、SDK、ACP 等组合。

## 目录

```text
package.json                          # 包身份、exports、dsh.bundle / dsh.client
cordis.patch.yml                      # 插入 id = name = dsh-web-search-replace 的插件行
src/host/                             # Host：tools/execute 接管、渠道驱动、账号、生命周期
src/client/                           # Client：设置卡、账号/授权 UI、自有无依赖控件
src/shared/                           # 共享契约、渠道注册表、RPC 类型
locale/zh.json, locale/en.json        # meta.title / meta.description
scripts/build-client.mjs              # esbuild：Host ESM + Client lazy-CJS 包装
scripts/verify-build.mjs              # 构建产物契约
scripts/verify-css-isolation.mjs      # 跨插件 CSS 隔离与反向对照
scripts/verify-package.mjs            # 真实 pack 发布门禁
tests/unit, tests/client, tests/integration
docs/verification/2026-11-18-0.1.0.md # 发布证据与未验证边界
```

## 许可

尚未发布；设计文档与实施计划位于 `docs/superpowers/`。