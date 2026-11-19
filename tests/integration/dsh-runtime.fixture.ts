/**
 * Task 3 的真实 DSH 0.2.2-rc.3 集成 fixture。
 *
 * Vitest 只负责启动本文件并断言 JSON 观察值。子进程以当前 Desktop 自带的
 * Electron Node 24 运行，直接从已验证的 app.asar 导入 Cordis、WebRuntime、
 * tool-web、ToolsService、Native/PTC executor、timeout policy；不启动或连接
 * Desktop，不读取 profile，不调用模型或搜索网络。官方 Provider 是唯一替换的
 * 网络边界，PTC runtime 也只调用宿主生成的 SDK binding。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const FIXTURE_PATH = fileURLToPath(import.meta.url)
const PROJECT_ROOT = path.resolve(FIXTURE_PATH, '../../..')

/**
 * 测试期望的 DSH 运行时版本。
 *
 * 默认严格固定为项目声明支持的 0.2.2-rc.3；只有显式设置
 * DSH_TEST_EXPECTED_VERSION 时才切换为兼容验证版本（例如当前安装的
 * 0.2.2-rc.5）。这不是支持声明，也不改变最终 rc.3 验收目标。
 */
export const DSH_TEST_EXPECTED_VERSION = process.env.DSH_TEST_EXPECTED_VERSION ?? '0.2.2-rc.3'

export type FixtureMode = 'native' | 'ptc'
export type FixtureDriver = 'normal' | 'missing' | 'throw' | 'delay'
  | 'contract' | 'unauthorized' | 'rate-limit' | 'bad-response'

export interface FixtureModelSelection {
  readonly provider: string
  readonly model: string
}

export interface DshFixtureRequest {
  readonly mode: FixtureMode
  readonly modelSelection?: FixtureModelSelection
  readonly enabled?: boolean
  readonly channel?: 'buddy' | 'workbuddy' | 'qoder' | 'qodercn'
  readonly tool?: 'web_search' | 'web_fetch'
  readonly arguments?: unknown
  readonly installOverride?: boolean
  readonly driver?: FixtureDriver
  readonly timeoutMs?: number
  readonly lifecycle?: boolean
}

export interface ToolResultObservation {
  readonly isError: boolean
  readonly value?: unknown
  readonly content?: unknown
  readonly meta?: unknown
  readonly error?: unknown
}

export interface DshFixtureObservation {
  readonly source: Readonly<Record<string, string>>
  readonly runtime: { readonly node: string; readonly electron: string }
  readonly mode: FixtureMode
  readonly model: string
  readonly provider: string
  readonly route: string
  readonly admitted: readonly string[]
  readonly nativeSchemas: readonly string[]
  readonly ptcSchemas: readonly string[]
  readonly ptcSdkHasWebSearch: boolean
  readonly result: ToolResultObservation | undefined
  readonly transportResult: ToolResultObservation | undefined
  readonly expectedMockValue: unknown
  readonly expectedMockContent: unknown
  readonly expectedMeta: unknown
  readonly presentationResult: unknown
  readonly officialSearchCalls: number
  readonly officialFetchCalls: number
  readonly driverCalls: readonly { query: string; maxResults: number }[]
  readonly downstreamCalls: number
  readonly lifecycleTracks: number
  readonly events: readonly string[]
  readonly readyProviders: readonly string[]
  readonly providersConfig: { readonly searchProvider: string; readonly fetchProvider: string }
}

/** 在官方 Electron Node 子进程中运行一个场景，避免普通 Node 无法读取 ASAR。 */
export function runDshFixture(request: DshFixtureRequest): Promise<DshFixtureObservation> {
  const executable = process.env.DSH_NODE_EXECUTABLE
  const installDir = process.env.DSH_INSTALL_DIR
  if (executable === undefined || installDir === undefined) {
    throw new Error('真实 DSH fixture 需要 DSH_NODE_EXECUTABLE 与 DSH_INSTALL_DIR')
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--experimental-transform-types', FIXTURE_PATH, JSON.stringify(request)], {
      env: {
        ...process.env,
        DSH_NODE_EXECUTABLE: executable,
        DSH_INSTALL_DIR: installDir,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`真实 DSH fixture 超时：${request.mode}/${request.tool ?? 'web_search'}`))
    }, 15_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`真实 DSH fixture 退出码 ${code}\n${stderr}\n${stdout}`))
        return
      }
      try {
        resolve(JSON.parse(stdout) as DshFixtureObservation)
      } catch (error) {
        reject(new Error(`真实 DSH fixture 返回非 JSON：${String(error)}\n${stderr}\n${stdout}`))
      }
    })
  })
}

interface LoadedPackage {
  readonly module: any
  readonly version: string
}

/** 从当前安装锚点加载真实包，而不是从项目 cwd 或全局 npm 猜测。 */
async function loadInstalledPackages(): Promise<Record<string, LoadedPackage>> {
  const anchor = process.env.DSH_INSTALL_DIR
  if (anchor === undefined) throw new Error('缺少 DSH_INSTALL_DIR')
  const require = createRequire(path.join(anchor, 'package.json'))
  const names = [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-web',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-tool-web',
    '@deepseek-ai/dsh-tool-executor-native',
    '@deepseek-ai/dsh-tool-executor-ptc',
    '@deepseek-ai/dsh-tool-call-timeout-policy',
  ]
  const entries: [string, LoadedPackage][] = []
  for (const name of names) {
    const manifestPath = require.resolve(`${name}/package.json`)
    const manifest = require(manifestPath)
    const module = await import(pathToFileURL(path.join(path.dirname(manifestPath), manifest.main)).href)
    entries.push([name, { module, version: manifest.version }])
  }
  const desktopManifest = require(path.resolve(anchor, '../../..', 'package.json'))
  entries.push(['desktop', { module: undefined, version: desktopManifest.version }])
  return Object.fromEntries(entries)
}

/** 导入工作树内的生产 TypeScript；Electron Node 24 转换类型语法。 */
async function importProjectModule(relativePath: string): Promise<any> {
  return import(pathToFileURL(path.join(PROJECT_ROOT, relativePath)).href)
}

/** Task 2 SettingsService 所需的完整稳定 volatile 配置，无写入与账号网络。 */
function createVolatileConfig(enabled: boolean, channel: string): any {
  const value = <T>(current: T) => ({ get: () => current })
  return {
    search: { enabled: value(enabled), channel: value(channel) },
    buddy: { currentAccountId: value(null) },
    workbuddy: { currentAccountId: value(null) },
    qoder: { currentAccountId: value(null), endpointPreference: value('auto') },
    qodercn: { currentAccountId: value(null) },
  }
}

/** 把真实执行结果投影成可跨进程断言的 JSON。 */
function observeResult(result: any): ToolResultObservation | undefined {
  if (result === undefined) return undefined
  return JSON.parse(JSON.stringify({
    isError: result.isError,
    value: result.value,
    content: result.content,
    meta: result.meta,
    error: result.error,
  })) as ToolResultObservation
}

/** 等待 timeout abort，并以成功值配合官方 timeout wrapper 的 quiescence 合同。 */
async function settleAfterAbort(signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs * 2 + 100)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/** 在隔离 Cordis Context 中执行真实 Native 或 PTC 管道。 */
async function executeScenario(request: DshFixtureRequest): Promise<DshFixtureObservation> {
  const installed = await loadInstalledPackages()
  const cordis = installed['@deepseek-ai/cordis']!.module
  const { SystemPrompt } = installed['@deepseek-ai/dsh-system-prompt']!.module
  const { WebRuntime } = installed['@deepseek-ai/dsh-web']!.module
  const { ToolsService } = installed['@deepseek-ai/dsh-tools']!.module
  const toolWeb = installed['@deepseek-ai/dsh-tool-web']!.module
  const { NativeToolExecutor } = installed['@deepseek-ai/dsh-tool-executor-native']!.module
  const { PtcExecutor } = installed['@deepseek-ai/dsh-tool-executor-ptc']!.module
  const timeoutPolicy = installed['@deepseek-ai/dsh-tool-call-timeout-policy']!.module

  const mode = request.mode
  const modelSelection = request.modelSelection ?? {
    provider: 'magpie',
    model: 'wps-lingxi-desktop/kimi-k3.1-pro',
  }
  const { provider, model } = modelSelection
  const enabled = request.enabled ?? true
  const channel = request.channel ?? 'buddy'
  const tool = request.tool ?? 'web_search'
  const args = request.arguments ?? (tool === 'web_search'
    ? { queries: ['fixture query'] }
    : { url: 'https://official.example/fixture' })
  const timeoutMs = request.timeoutMs ?? 30
  const driverKind = request.driver ?? 'normal'
  const events: string[] = []
  const driverCalls: { query: string; maxResults: number }[] = []
  const readyProviders: string[] = []
  let officialSearchCalls = 0
  let officialFetchCalls = 0
  let downstreamCalls = 0
  let lifecycleTracks = 0
  let expectedMockValue: unknown
  let expectedMockContent: unknown
  let expectedMeta: unknown
  let presentationResult: unknown
  let observedResult: ToolResultObservation | undefined

  const ctx = new cordis.Context()
  try {
    new SystemPrompt(ctx, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      personaPrefix: '',
      personaSuffix: '',
      toolOrder: undefined,
    })
    const providersConfig = { searchProvider: 'official-search', fetchProvider: 'official-fetch' }
    const web = new WebRuntime(ctx, {
      searchProvider: { get: () => providersConfig.searchProvider },
      fetchProvider: { get: () => providersConfig.fetchProvider },
    })
    const tools = new ToolsService(ctx)

    web.registerSearchProvider({
      id: 'official-search',
      available: () => true,
      ready: async (route: string | undefined) => {
        readyProviders.push(route ?? '<undefined>')
        return true
      },
      search: async (input: { query: string }) => {
        officialSearchCalls++
        return {
          content: `official answer: ${input.query}`,
          sources: [{
            url: `https://official.example/search?q=${encodeURIComponent(input.query)}`,
            title: 'Official result',
            snippet: 'official snippet',
            summary: 'official summary',
          }],
          truncated: false,
        }
      },
    })
    web.registerFetchProvider({
      id: 'official-fetch',
      available: () => true,
      fetch: async (input: { url: string }) => {
        officialFetchCalls++
        return {
          url: input.url,
          statusCode: 200,
          body: { kind: 'text', content: 'official fetch body' },
          truncated: false,
        }
      },
    })

    toolWeb.apply(ctx, toolWeb.Config({
      search: true,
      fetch: true,
      searchTimeoutMs: timeoutMs,
      fetchTimeoutMs: timeoutMs,
    }))

    let transportResult: any
    const agent = {
      id: 'task-3-fixture-session',
      session: {
        id: 'task-3-fixture-session',
        // PTC SDK binding 的官方日志边界；本 fixture 不需要持久化，但必须完整提供。
        append: () => 0,
        // rc.5 官方 web_search 会读取会话路由来选择 Provider；与真实 Session
        // 及 rc.5 官方 tool-web 测试一致，返回本场景已解析的 provider/model。
        requestContext: () => ({ provider, model }),
      },
      ctx,
    }
    ctx.provide('workingDirectory', { ensure: async () => PROJECT_ROOT })
    let ptcExecutor: any
    if (mode === 'ptc') {
      ctx.provide('ptcRuntime', {
        language: 'typescript',
        programFormat: 'function-body',
        retainsState: false,
        resolve: (spec: any) => ({ ...spec, timeoutMs: null }),
        run: async (spec: any) => {
          try {
            const binding = spec.bindings[0].functions[tool]
            if (binding === undefined) throw new Error(`PTC SDK 缺少 ${tool} binding`)
            return { logs: [], value: await binding(args) }
          } catch (error) {
            return {
              logs: [],
              error: { kind: 'exception', message: error instanceof Error ? error.message : String(error) },
            }
          }
        },
        release: async () => {},
      })
      ptcExecutor = new PtcExecutor(ctx)
    }

    if (request.installOverride === true) {
      const [{ installSearchOverride }, { MockSearchDriver }, { SettingsService }] = await Promise.all([
        importProjectModule('src/host/tools/execute-listener.ts'),
        importProjectModule('src/host/drivers/mock-driver.ts'),
        importProjectModule('src/host/settings/service.ts'),
      ])
      const settings = new SettingsService({
        configEditor: { edit: async () => { throw new Error('fixture 不允许写设置') } },
        entry: { id: 'task-3-fixture' },
        config: createVolatileConfig(enabled, channel),
      })
      const mock = new MockSearchDriver()
      const recordingDriver = {
        searchOnce: async (query: string, maxResults: number, signal: AbortSignal) => {
          events.push('driver:start')
          driverCalls.push({ query, maxResults })
          if (driverKind === 'throw') throw new Error('mock driver exploded')
          if (driverKind === 'unauthorized') {
            throw Object.assign(new Error('fixture credentials expired'), { status: 401 })
          }
          if (driverKind === 'rate-limit') {
            throw Object.assign(new Error('fixture rate limited'), { statusCode: 429 })
          }
          if (driverKind === 'bad-response') {
            return { sources: [{ title: 'missing URL' }], truncated: false }
          }
          if (driverKind === 'contract') {
            return {
              content: query === 'alpha' ? 'Alpha answer' : 'Beta answer',
              sources: query === 'alpha'
                ? [
                    {
                      url: 'https://contract.test/shared',
                      title: 'Shared result',
                      snippet: 'shared snippet',
                      summary: `  ${'x'.repeat(801)}  `,
                      publishedAt: '2026-11-18',
                    },
                    { url: 'https://contract.test/alpha-2', snippet: 'alpha second' },
                  ]
                : [
                    { url: 'https://contract.test/beta-1', title: 'Beta first' },
                    { url: 'https://contract.test/shared', title: 'duplicate' },
                  ],
              truncated: false,
            }
          }
          if (driverKind === 'delay') {
            await settleAfterAbort(signal, timeoutMs)
            events.push(`driver:abort:${String(signal.aborted)}`)
          }
          const value = await mock.searchOnce(query, maxResults, signal)
          events.push('driver:end')
          return value
        },
      }
      const wrongChannelDriver = {
        searchOnce: async () => { throw new Error('selected the wrong channel driver') },
      }
      const drivers = driverKind === 'missing' ? {} : {
        buddy: channel === 'buddy' ? recordingDriver : wrongChannelDriver,
        [channel]: recordingDriver,
      }
      const lifecycle = request.lifecycle === true ? {
        track: async <T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> => {
          lifecycleTracks++
          events.push(`lifecycle:signal:${String(signal !== undefined)}`)
          return operation
        },
      } : undefined
      ctx.on('tools/execute', async (exec: any, next: () => Promise<any>) => {
        events.push('timeout-outer:enter')
        const callerSignal = exec.signal
        try {
          return await next()
        } finally {
          events.push(`timeout-outer:exit:restored:${String(exec.signal === callerSignal)}`)
        }
      })
      timeoutPolicy.apply(ctx)
      ctx.on('tools/execute', async (_exec: any, next: () => Promise<any>) => {
        events.push('timeout-inner:enter')
        try {
          return await next()
        } finally {
          events.push(`timeout-inner:exit:aborted:${String(_exec.signal.aborted)}`)
        }
      })
      installSearchOverride(ctx, { settings, drivers, lifecycle })
    }

    ctx.on('tools/execute', async (_exec: any, next: () => Promise<any>) => {
      downstreamCalls++
      events.push('downstream:enter')
      return next()
    })
    ctx.on('tools/result', (exec: any, result: any) => {
      if (exec.name === tool) observedResult = observeResult(result)
    })

    const toolSet = await tools.resolve({
      agent,
      modelSelection: { provider, model },
      signal: new AbortController().signal,
    })
    try {
      const definitions = tools.definitions(agent, toolSet)
      const admitted = [...toolSet.view(agent).keys()]
      const native = new NativeToolExecutor(ctx)
      const nativeSchemas = native.describe(definitions).schemas.map((schema: any) => schema.name)
      const ptc = ptcExecutor ?? new PtcExecutor(ctx)
      const ptcSchemas = mode === 'ptc' ? ptc.describe(definitions).schemas.map((schema: any) => schema.name) : []
      const sdkSection = ptc.sections.find((section: any) => section.name === 'tools:sdk')
      const ptcSdk = mode === 'ptc' && sdkSection !== undefined
        ? (typeof sdkSection.text === 'function' ? sdkSection.text(definitions) : sdkSection.text)
        : ''
      const executor = mode === 'native' ? native : ptc
      const calls = mode === 'native' ? [{
        id: 'task-3-native-call',
        name: tool,
        arguments: JSON.stringify(args),
      }] : [{
        id: 'task-3-ptc-call',
        name: 'run_code',
        arguments: JSON.stringify({
          code: `return tools.${tool}(args)`,
          description: 'Run fixture web tool binding',
        }),
      }]
      const batch = await executor.execute({
        calls,
        agent,
        toolSet,
        signal: new AbortController().signal,
      })
      transportResult = batch.results[0]?.result
      if (mode === 'native') observedResult = observeResult(transportResult)
      if (request.installOverride === true && (driverKind === 'normal' || driverKind === 'contract')) {
        if (driverKind === 'contract') {
          expectedMockValue = {
            content: '### alpha\n\nAlpha answer\n\n### beta\n\nBeta answer',
            sources: [
              {
                url: 'https://contract.test/shared',
                title: 'Shared result',
                snippet: 'shared snippet',
                summary: `${'x'.repeat(799)}…`,
                publishedAt: '2026-11-18',
              },
              { url: 'https://contract.test/beta-1', title: 'Beta first' },
              { url: 'https://contract.test/alpha-2', snippet: 'alpha second' },
            ],
            truncated: false,
          }
        } else {
          const { MockSearchDriver } = await importProjectModule('src/host/drivers/mock-driver.ts')
          expectedMockValue = await new MockSearchDriver().searchOnce('fixture query', 10, new AbortController().signal)
        }
        expectedMockContent = [{ type: 'text', text: toolWeb.formatSearchOutput(expectedMockValue) }]
        expectedMeta = toolWeb.searchMetaFromValue(expectedMockValue)
      }
      if (tool === 'web_search' && observedResult !== undefined) {
        presentationResult = toolWeb.presentSearchResult(args, observedResult)
      }
      return {
        source: Object.fromEntries(Object.entries(installed).map(([name, item]) => [name, item.version])),
        runtime: { node: process.version, electron: process.versions.electron ?? '<none>' },
        mode,
        model,
        provider,
        route: `${provider}/${model}`,
        admitted,
        nativeSchemas,
        ptcSchemas,
        ptcSdkHasWebSearch: ptcSdk.includes('web_search'),
        result: observedResult,
        transportResult: observeResult(transportResult),
        expectedMockValue,
        expectedMockContent,
        expectedMeta,
        presentationResult,
        officialSearchCalls,
        officialFetchCalls,
        driverCalls,
        downstreamCalls,
        lifecycleTracks,
        events,
        readyProviders,
        providersConfig,
      }
    } finally {
      toolSet.dispose()
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

const direct = process.argv[1] !== undefined && path.resolve(process.argv[1]) === FIXTURE_PATH
if (direct) {
  try {
    const request = JSON.parse(process.argv[2] ?? '{}') as DshFixtureRequest
    process.stdout.write(JSON.stringify(await executeScenario(request)))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
