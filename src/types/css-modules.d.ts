/**
 * Vite 与 esbuild 都把 `*.module.css` 编译成「原始类名 → 作用域类名」的映射。
 * 这里只声明这一个形状，让 strict 模式下的 `pnpm typecheck` 与构建保持一致。
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
