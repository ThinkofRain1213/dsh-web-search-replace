/**
 * 测试侧复刻 rc.5 Host 设置表单的投影与线格式，用于验证真实 Config 的
 * schema 反序列化闭环（不替代产品代码，产品代码不依赖本文件）。
 *
 * 逐段对应上游 `0.2.2-rc.5`：
 * - `plainConfig` / `plainSchema` / `volatileForm` / `projectForm`：
 *   `packages/settings/settings/src/schema.ts`；
 * - `settings.describe` 的 `schema: form.toJSON()` 与
 *   `value: projectForm(form, plainConfig(effectiveConfig))`：
 *   `packages/settings/settings/src/index.ts`；
 * - 客户端 `SettingsSchemaService.rehydrate/validate` 与
 *   `ConfigFormController.decode`：`packages/client/ui-settings/src/client/schema.ts`
 *   与 `config-form.ts`。
 *
 * 这里只复刻本插件 Config 实际用到的普通字段路径（无 secret role、无表单
 * decode 覆盖）；快照投影使用与 cosmokit `isVolatile` 相同的共享符号协议。
 */
import Schema from '@deepseek-ai/schemastery'

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 与 cosmokit `isVolatile` 相同的跨副本判定（不依赖未声明的运行时包）。 */
export function isVolatileConfigValue(value: unknown): value is { get(): unknown } {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/** 去掉 volatile 引用后的普通配置值（对应 Host `plainConfig`）。 */
export function plainConfig(value: unknown): unknown {
  if (isVolatileConfigValue(value)) return plainConfig(value.get())
  if (Array.isArray(value)) return value.map(plainConfig)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]))
  }
  return value
}

/** 重建一份去掉 volatile 标记的普通 schema（对应 Host `plainSchema`）。 */
function plainSchema(schema: Schema): Schema {
  const result = new Schema(schema.toJSON())
  const walk = (node: Schema): void => {
    delete node.meta.volatile
    for (const child of Object.values(node.dict ?? {})) walk(child)
    if (node.inner) walk(node.inner)
    for (const child of node.list ?? []) walk(child)
  }
  walk(result)
  return result
}

/** 只保留 volatile 字段的投影 schema（对应 Host `volatileForm`）。 */
export function volatileForm(schema: Schema): Schema | undefined {
  if (schema.meta.volatile) return plainSchema(schema)
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child)
      return field === undefined ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? undefined : Schema.object(dict)
  }
  return undefined
}

/**
 * 只投影 schema 声明且值存在的字段（对应 Host `projectForm`）。
 * @param schema - 投影 schema。
 * @param value - 普通配置值。
 * @returns 客户端收到的表单值。
 */
export function projectForm(schema: Schema, value: unknown): unknown {
  if (schema.type === 'object' && value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = (value as Record<string, unknown>)[key]
      return field === undefined ? [] : [[key, projectForm(child, field)]]
    }))
  }
  return value
}

/** 一个 `settings.describe` 命名空间视图的 schema/value 投影。 */
export interface HostDescribedForm {
  /** Host 投影后的表单 schema。 */
  readonly form: Schema
  /** describe 线上的 schema 信封（JSON 往返后）。 */
  readonly wire: unknown
  /**
   * 把解析后的 Config 投影成 describe 线上的 value。
   * @param value - `Config(...)` 的解析结果。
   * @returns 客户端收到的普通表单值。
   */
  project(value: unknown): unknown
}

/**
 * 按 Host `settings.describe` 形状投影真实 Config。
 * @param schema - 插件 Config schema。
 * @returns 表单 schema、线上信封与 value 投影器。
 * @throws 当 schema 没有任何 volatile 字段时（Host 同样不发布该命名空间）。
 */
export function hostDescribedForm(schema: Schema): HostDescribedForm {
  const form = volatileForm(schema)
  if (form === undefined) throw new Error('Config 没有任何 volatile 字段，Host 不会发布该设置命名空间')
  return {
    form,
    wire: JSON.parse(JSON.stringify(form.toJSON())),
    project: value => projectForm(form, plainConfig(value)),
  }
}

/** 收集 schema 信封里出现的全部节点类型（用于断言 transform 不再进入线格式）。 */
export function schemaNodeTypes(wire: unknown): string[] {
  const refs = (wire as { refs?: Record<string, { type?: unknown }> }).refs
  if (refs === undefined) throw new Error('schema 信封缺少 refs')
  return Object.values(refs).flatMap(node => typeof node.type === 'string' ? [node.type] : [])
}

/**
 * 客户端 `SettingsSchemaService.validate` + `ConfigFormController.decode`
 * 的 schema 判定：反序列化并执行校验，失败返回错误文本。
 * @param wire - describe 线上的 schema 信封。
 * @param value - describe 线上的表单值。
 * @returns 失败文本；通过时为 undefined。
 */
export function clientSchemaFailure(wire: unknown, value: unknown): string | undefined {
  try {
    const schema = new Schema(wire as Schema)
    ;(schema as (draft: unknown) => unknown)(value)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}