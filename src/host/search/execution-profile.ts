/** 与 DSH tool-web 默认搜索边界一致的执行配置。 */
export interface SearchExecutionProfile {
  readonly maxQueries: number
  readonly maxResults: number
  readonly summaryMaxChars: number
}

/** 官方默认值；调用方不得在执行期间修改。 */
export const SEARCH_DEFAULT_PROFILE: Readonly<SearchExecutionProfile> = Object.freeze({
  maxQueries: 10,
  maxResults: 10,
  summaryMaxChars: 800,
})
