import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 全量测试里有多类真实子进程与毫秒级时序用例：Native/PTC 运行时 fixture 由
    // Electron Node 加载 app.asar，release-gates 运行 `vitest list`、真实
    // `npm pack`（含进程树 deadline 自证）与 CSS 门禁，capability-probe 用
    // 50ms/100ms 级别的 deadline race。Vitest 默认 maxWorkers 取 CPU 可用并行度
    // （本机 16 逻辑核 → 15）；实测 4 workers 在机器级外部负载下仍出现 11 个
    // 真实子进程 5s 超时，因此 4 不能当作稳定保证。这里把本仓库测试执行收敛为
    // 单 worker（maxWorkers: 1，文件串行），用本仓库可复现的资源边界避免自身
    // 并发加剧真实子进程与毫秒级 race 的争抢；不延长任何 timeout、不删除断言、
    // 不修改产品行为。机器上其他进程/项目的并发负载仍属外部边界。
    // 证据与边界：docs/verification/2026-11-18-0.1.0.md 运行备注。
    maxWorkers: 1,
    server: {
      deps: {
        // ConfigEditor 的真实 change/YAML/atomic-write 需要在 Vitest 内联执行，
        // 才能只替换 Loader reconcile；其余依赖维持默认外部化策略。
        inline: [/@deepseek-ai\/dsh-config-editor/, /@deepseek-ai\/dsh-app-boot/],
      },
    },
  },
})
