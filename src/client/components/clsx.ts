/** 官方组件使用的最小 clsx 兼容：仅接收字符串与条件值，不新增依赖。 */
export default function clsx(...values: Array<string | false | null | undefined>): string {
  return values.filter((value): value is string => typeof value === 'string' && value !== '').join(' ')
}
