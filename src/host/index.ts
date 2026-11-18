/**
 * Host 半体：0.1.0 骨架只让插件行可安装，不注册任何业务能力。
 *
 * 搜索接管、渠道驱动、账号与凭据都在后续任务里实现；这里保持空 apply，
 * 避免在骨架阶段提前创建 tools/execute 监听器或配置读写。
 */

/**
 * @param _ctx - Cordis 插件上下文（骨架阶段不使用）。
 * @param _config - 插件行的 config（0.1.0 骨架为空对象）。
 */
export function apply(_ctx: unknown, _config: unknown): void {}
