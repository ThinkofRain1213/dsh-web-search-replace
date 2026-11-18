# 网页搜索渠道（`dsh-web-search-channels`）

让任意模型都能通过用户显式选择的 CodeBuddy、WorkBuddy、Qoder 国际版或
Qoder 中国版账号完成网页搜索，不再把网页搜索能力绑定 DeepSeek 模型渠道。

- 包名：`dsh-web-search-channels`
- 当前版本：`0.1.0`
- 目标运行环境：DeepSeek Harness Desktop `0.2.2-rc.3`

## 当前状态

**Task 1 骨架**：本仓库当前只交付可安装 Bundle、构建链与真实设置卡骨架。

- 已实现：bundle 清单与 `cordis.patch.yml`、Host 空 `apply(ctx, config)`、
  Client 在 `plugins.bundle.config` 槽位注册「网页搜索渠道 / 设置加载中」卡片、
  中英文 locale、图标、构建与产物校验脚本。
- 未实现：搜索接管（`tools/execute`）、四个渠道驱动、账号登录与凭据、
  Fetch（`0.2.0` 才有）。骨架阶段不伪造搜索按钮或账号。

因此归档描述里也明确写着：骨架当前只注册设置卡，尚未接管搜索；关闭插件时
完整交还官方 `web_search`。

## 目录

```text
package.json                          # 包身份、exports、dsh.bundle / dsh.client
cordis.patch.yml                      # 插入 id = name = dsh-web-search-channels 的插件行
tsconfig.json                         # strict + bundler 解析
src/host/index.ts                     # Host 半体：空 apply(ctx, config)
src/client/index.ts                   # Client 半体：locale 字典 + 槽位注册
src/client/SettingsCard.tsx           # 设置卡骨架（只渲染 page 视图）
src/client/styles/settings-card.module.css
scripts/build-client.mjs              # esbuild：Host ESM + Client lazy-CJS 包装
scripts/verify-build.mjs              # 产物契约校验
locale/zh.json, locale/en.json        # meta.title / meta.description
icon.svg
tests/unit/build-manifest.spec.ts     # Task 1 契约测试
```

## 两层 inject 的区别

| 层 | 位置 | 内容 |
|---|---|---|
| 包清单层 | `package.json` → `dsh.client.inject` | 加载哪些 Client 包：`@deepseek-ai/dsh-client-ui-plugin-manager`、`@deepseek-ai/dsh-client-ui-settings`、`@deepseek-ai/dsh-client-connection`、`@deepseek-ai/dsh-client-locale` |
| 模块运行时层 | `src/client/index.ts` → `export const inject` | 依赖哪些服务：`slots`、`locale`、`configForms`、`connection` |

两者不能互换：前者决定模块表里有哪些包，后者决定插件何时激活。

## 构建与验证

```bash
pnpm install
pnpm vitest run tests/unit/build-manifest.spec.ts   # 契约测试
pnpm build                                          # 产出 lib/index.js 与 lib/client.js
node scripts/verify-build.mjs                       # 产物契约：key = 包名、无禁用导入、无第二份 React
```

`lib/client.js` 是 `window.__ModuleLoader__.load({ id: "dsh-web-search-channels", factory })`
包装的 lazy-CJS 产物；React/ReactDOM 保持 external。CSS Modules 类名由
构建脚本按「包名 + 包内相对路径 + 原始类名」哈希，避免与其他插件或宿主冲突。

## 安装

在 DSH 的 **Plugins** 页面用 **Add plugin** 安装本目录（或由
`plugin_manager.install_bundle` 指向本目录）。安装后 bundle 详情页的配置区
应出现「网页搜索渠道 / 设置加载中」骨架。

## 许可

尚未发布；设计文档与实施计划位于 `docs/superpowers/`。
