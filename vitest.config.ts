import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 全量测试里有多类真实子进程与毫秒级时序用例：Native/PTC 运行时 fixture 由
    // Electron Node 加载 app.asar，release-gates 运行 `vitest list`、真实
    // `npm pack`（含进程树 deadline 自证）与 CSS 门禁，capability-probe 用
    // 50ms/100ms 级别的 deadline race。Vitest 默认 maxWorkers 取 CPU 可用并行度
    // （本机 16 逻辑核 → 15），满并发时 CPU/IO 争抢会让这些子进程逼近或超过
    // 既有 5s 测试超时，也会让毫秒级 race 在事件循环延迟下失序；单文件或低并发
    // 运行则稳定通过。因此这里固定保守并发 4，用可复现的执行资源边界消除抖动，
    // 而不是延长测试 timeout、删除断言或修改产品行为。
    // 证据与边界：docs/verification/2026-11-18-0.1.0.md 运行备注。
    maxWorkers: 4,
    server: {
      deps: {
        // ConfigEditor 的真实 change/YAML/atomic-write 需要在 Vitest 内联执行，
        // 才能只替换 Loader reconcile；其余依赖维持默认外部化策略。
        inline: [/@deepseek-ai\/dsh-config-editor/, /@deepseek-ai\/dsh-app-boot/],
      },
    },
  },
})
