# Spike：真实 DSH `tools/execute` 准入与短路

日期：2026-11-19
范围：Task 3，仅 `web_search` 执行接管；不是 SearchExecutor、真实厂商驱动、账号库或 UI。

## 结论

在当前安装 **DSH Desktop Runtime 0.2.2-rc.3** 的真实 Cordis、WebRuntime、tool-web、ToolsService、Native/PTC executor、共享 ToolExecutionPipeline 与 timeout policy 上，Spike 成立：

- `deepseek-flash`（目录显示名 DeepSeek-V4.1-Flash）和 `deepseek-v4-pro` 两个代表模型均可通过 `ToolsService.resolve()` 准入 `web_search`。
- Native 直接把 `web_search` 放入模型 schema；PTC 直接 schema 只有 `run_code`，但官方生成的 TypeScript SDK 含 `web_search`，真实 SDK binding 可以嵌套执行它。
- 安装监听器前，ON 仍调用官方 search spy 一次；安装后 OFF 调官方一次，ON 调所选 mock 一次且官方 spy 为零。
- 监听器返回的 `{ value }` 由宿主共享管道重新经过 tool-web 原有 output schema、`formatSearchOutput` render 和 presentation meta，不复制官方渲染器。
- ON 的缺驱动、非法参数、驱动错误都不 `next()`；`web_fetch` 无论 ON/OFF 都走原有路径。
- timeout policy 先注册、override 后注册时，派生 deadline 到达驱动，最终错误码为 `TOOL_TIMEOUT`，没有官方搜索回退。

**没有触发产品准入阻断。** 本结论仅是当前安装真实包的隔离 fixture 证据，不是最终真实 Desktop 插件/UI/模型运行矩阵验收。

## 真实宿主来源与版本

所有运行时代码均从以下已验证安装锚点解析，未使用 rc.2 源码 checkout，也未从 npm 重新解析其他版本：

`C:\Users\Think\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh`

| 组件 | 实测版本 | 关键源码 |
|---|---:|---|
| Desktop Runtime | 0.2.2-rc.3 | `dsh/package.json` |
| `@deepseek-ai/cordis` | 4.1.0 | `src/events.ts` 的 waterfall；`src/context.ts` |
| `@deepseek-ai/dsh-web` | 0.2.2-rc.3 | `src/index.ts` 的 WebRuntime 与 Provider 选择 |
| `@deepseek-ai/dsh-tools` | 0.2.2-rc.3 | `src/index.ts`、`src/pipeline.ts`、`src/batch.ts` |
| `@deepseek-ai/dsh-tool-web` | 0.2.2-rc.3 | `src/search.ts`、`src/fetch.ts` |
| `@deepseek-ai/dsh-tool-executor-native` | 0.2.2-rc.3 | `src/index.ts` |
| `@deepseek-ai/dsh-tool-executor-ptc` | 0.2.2-rc.3 | `src/index.ts`、`src/ptc.ts` |
| `@deepseek-ai/dsh-tool-call-timeout-policy` | 0.2.2-rc.3 | `src/index.ts` |

代表模型 ID 取自同一安装的 `dsh-llm-deepseek/src/models.ts`。执行子进程实测 Node `v24.21.0`、Electron `44.7.0`。

关键宿主事实：

1. Cordis `waterfall` 按注册顺序从最外层 listener 开始，未调用 `next()` 就 veto 后续 listener 与工具本体。
2. `ToolExecutionPipeline.normalizeDispatchResult()` 对非 canonical 成功结果读取 `result.value`，再调用 `createSuccessResult()`；后者执行官方 output JSON Schema 校验、render 与 presentationMeta。
3. Native executor 与 PTC nested binding 最终都使用这个共享 pipeline，因此两种执行路径的 `{ value }` 合同一致。
4. tool-web 的 `web_search` 注册条件只调用 `ctx.web.searchReady(modelSelection.provider)`；fixture 仅构造模型选择，不调用模型网络。

## Fixture 方法与边界

`tests/integration/dsh-runtime.fixture.ts` 由 Vitest 启动为独立子进程：

- 使用 `DSH_NODE_EXECUTABLE` 和 `DSH_INSTALL_DIR`，设置 `ELECTRON_RUN_AS_NODE=1`，直接加载当前 ASAR 内官方包。
- 使用 `--experimental-transform-types`，因为 Task 2 的 `SettingsService` 使用 TypeScript 参数属性，而 Node 24 默认 strip-only 不支持该语法。
- Cordis Context、SystemPrompt、WebRuntime、ToolsService、tool-web、executor 和 timeout policy 都是真实实现。
- 仅把最外层 search/fetch Provider 换成本地 spy；这些 spy 不发网络。PTC runtime 不求值任意程序，只调用宿主生成的目标 SDK binding。
- PTC 的 `session.append` 与 `workingDirectory` 是日志/目录边界 fixture；PTC dispatch start/result 仍走官方实现。
- 设置读取使用真实 Task 2 `SettingsService`，配置为稳定 volatile 引用；fixture 禁止配置写入。
- 不连接或操作正在运行的 Desktop，不读取/修改 profile，不安装、启用或禁用插件，不操作浏览器，不发模型或真实搜索请求。

## Native / PTC 准入差分

| 观察项 | Native | PTC |
|---|---|---|
| `ToolsService.resolve()` admitted | `web_search`、`web_fetch` | `web_search`、`web_fetch` |
| 直接模型 schema | `web_search`、`web_fetch` | 仅 `run_code` |
| SDK | 不适用 | 官方 SDK 文本包含 `web_search` binding |
| 执行入口 | 原始 `web_search` tool call | 原始 `run_code` → 官方 binding → nested `web_search` |
| 最终结果观察 | 直接 search result | nested search result；另有 outer `run_code` result |
| override 外层调用次数差异 | 只有 search 本身 | outer `run_code` 总是非 `web_search`，必须先 `next()`；只有 nested search 可短路 |

两个模型在两种模式下都完成准入；安装前 ON 的官方 search spy 都为 1。PTC 的“直接 schema 只有 `run_code`”是宿主设计，不是准入缺失。

## OFF / ON 与官方 output 证据

聚焦命令：

```sh
pnpm vitest run tests/integration/tool-admission.spec.ts tests/integration/tool-override.spec.ts
```

最终 GREEN：**2 个文件、18 个测试全部通过**。每个行为均分别在 Native 和 PTC 运行。

| 场景 | 官方 search spy | 官方 fetch spy | mock 调用 | 结果 |
|---|---:|---:|---:|---|
| 安装前 ON search | 1 | 0 | 0 | 官方值与 render |
| 安装后 OFF search，驱动表为空 | 1 | 0 | 0 | `next()`，官方值 |
| 安装后 ON search | 0 | 0 | 1 | mock `{value}` 经官方 output |
| 安装后 ON fetch | 0 | 1 | 0 | 始终 `next()`，官方 fetch 值 |
| ON 缺所选渠道驱动 | 0 | 0 | 0 | 错误结果，无回退 |
| ON 空白 query | 0 | 0 | 0 | 参数错误，无回退 |
| ON 驱动抛错 | 0 | 0 | 1 | 原驱动错误，无回退 |
| ON timeout | 0 | 0 | 1 | `TOOL_TIMEOUT`，无回退 |

ON 成功用例选择 `qoder`，断言驱动收到逐字参数 `query = "fixture query"`、`maxResults = 10`。返回值的 `content` 与官方 `formatSearchOutput(value)` 逐字一致，并带官方 presentation meta。`lifecycle.track` 收到同一个 operation 和非空 signal，计数为 1。

监听器没有修改 `web.searchProvider` / `web.fetchProvider`；所有场景结束后仍分别为 fixture 初值 `official-search` / `official-fetch`。实现没有 Shadow、prompt section、聊天 Provider 接管判断或 fetch 接管。

## listener 与 timeout wrapper 顺序

测试中的实际注册顺序（probe 只记录顺序，不替代宿主逻辑）：

1. `timeout-outer` 记录探针；
2. 官方 `timeoutPolicy.apply(ctx)`；
3. `timeout-inner` 记录探针；
4. `installSearchOverride(ctx, ...)`；
5. `downstream` 探针；
6. 官方工具本体。

因此 ON timeout 的嵌套 search 顺序为：

```text
timeout-outer:enter
timeout-inner:enter
driver:start
driver:abort:true
driver:end
timeout-inner:exit:aborted:true
timeout-outer:exit:restored:true
```

PTC 在这段前后另有 outer `run_code` 的 enter/exit；上述片段以最后一次 `driver:start` 定位，避免把 outer 退出误判为 nested 顺序。

归因链：官方 timeout wrapper 用 `deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)` 派生 signal 并调用后续 listener；共享 pipeline 再把它与原始 caller signal 融合，驱动看到 `aborted = true` 并达到 quiescence；wrapper 仅在 `timeoutOf(..., TOOL_TIMEOUT)` 认定自己的 deadline 获胜时替换为 `ToolTimeoutError / TOOL_TIMEOUT`，最后在 `finally` 恢复上游 signal。

**组合约束：timeout 必须先于 override 注册。** 如果 ON override 位于 timeout 外层且不调用 `next()`，内层 timeout 根本不会进入。Task 3 只证明并记录正确顺序；后续真实组合与 Task 15 生命周期接线必须保留它。

## 实现范围与限制

- 固定顺序为：非 `web_search` → `next`；读取 Task 2 设置，OFF → `next`；ON → 校验 mock 参数 → 选择当前渠道驱动 → `searchOnce(query, 10, signal)` → `{ value }`。
- R1 最小可选生命周期接口严格为：

  ```ts
  lifecycle?: {
    track?<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T>
  }
  ```

- mock Spike 只接受 `queries` 中一个非空白字符串；多查询合并仍由后续真实执行层设计，不在本任务扩张。
- 缺失驱动代表当前账号/渠道不可执行；真实账号存在性、秘密读取与厂商错误映射属于后续任务。
- `MockSearchDriver` 只生成确定性官方 output 形状，不持账号、不访问网络；未把 mock 接入正式 Host `apply`。
- 本 Spike 不宣称真实 Desktop 插件装载、真实 PTC Node worker、UI、模型流或厂商账号已验收；这些统一留到最终运行矩阵。
