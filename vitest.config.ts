import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    server: {
      deps: {
        // ConfigEditor 的真实 change/YAML/atomic-write 需要在 Vitest 内联执行，
        // 才能只替换 Loader reconcile；其余依赖维持默认外部化策略。
        inline: [/@deepseek-ai\/dsh-config-editor/, /@deepseek-ai\/dsh-app-boot/],
      },
    },
  },
})
