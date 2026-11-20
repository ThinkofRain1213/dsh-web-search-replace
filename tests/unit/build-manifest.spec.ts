/**
 * Task 1 契约测试：可安装 Bundle 的 manifest、patch、构建链与真实 slot 骨架。
 *
 * 这里固定的是「安装器与 Plugins 页面读取的契约」：包身份、两层 inject、
 * 导出入口、patch 行、空 Host apply、Client 运行时注册的 `plugins.bundle.config`
 * 键，以及骨架渲染出的中英文文案与 `.stack` 类。
 *
 * 构建产物（`lib/index.js`、`lib/client.js`）的纯度检查属于
 * `scripts/verify-build.mjs`：本文件在 `pnpm build` 之前运行，不能依赖产物存在。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { createSettingsDouble } from './support/settings-double.ts'
import { MemoryCredentials } from './support/memory-credentials.ts'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PACKAGE_NAME = 'dsh-web-search-channels'

/** 读取仓库相对路径的 UTF-8 文本。 */
function readText(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8')
}

/** 读取并解析仓库相对路径的 JSON。 */
function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(readText(relativePath)) as Record<string, any>
}

/** 读取 package.json（每次调用都重新读，避免测试互相污染）。 */
function manifest(): Record<string, any> {
  return readJson('package.json')
}

/** 一份最小的 Client locale 服务替身：注册字典、按 active locale 查值。 */
function createLocaleDouble(): {
  readonly service: { register: (ns: string, dicts: unknown) => () => void; bind: (ns: string) => (key: string) => string }
  readonly namespaces: () => Map<string, Record<string, Record<string, string>>>
  setActive: (locale: 'zh' | 'en') => void
} {
  const namespaces = new Map<string, Record<string, Record<string, string>>>()
  let active: 'zh' | 'en' = 'zh'
  return {
    service: {
      register: (ns, dicts) => {
        namespaces.set(ns, dicts as Record<string, Record<string, string>>)
        return () => { namespaces.delete(ns) }
      },
      bind: (ns) => (key: string) => namespaces.get(ns)?.[active]?.[key] ?? key,
    },
    namespaces: () => namespaces,
    setActive: (locale) => { active = locale },
  }
}

describe('package manifest', () => {
  it('声明可安装 bundle 的包名与 0.1.0 版本', () => {
    const pkg = manifest()
    expect(pkg.name).toBe(PACKAGE_NAME)
    expect(pkg.version).toBe('0.1.0')
    expect(pkg.type).toBe('module')
  })

  it('导出 Host 与 Client 的构建入口', () => {
    const { exports } = manifest()
    expect(exports['.']).toBe('./lib/index.js')
    expect(exports['./client']).toBe('./lib/client.js')
    expect(exports['./package.json']).toBe('./package.json')
    expect(exports['./locale/*.json']).toBe('./locale/*.json')
    expect(exports['./icon']).toBe('./icon.svg')
  })

  it('声明 bundle patch 与 web 平台 Client 半体', () => {
    const { dsh } = manifest()
    expect(dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(dsh.client.platform).toBe('web')
  })

  it('package.json.dsh.client.inject 声明设置卡依赖的四个 Client 包', () => {
    const inject = manifest().dsh.client.inject
    expect(Array.isArray(inject)).toBe(true)
    expect(inject).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-client-ui-plugin-manager',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-locale',
    ]))
    for (const entry of inject) expect(typeof entry).toBe('string')
  })

  it('files 打包 Plugin Manager 读取的每个产物', () => {
    const { files } = manifest()
    expect(files).toEqual(expect.arrayContaining([
      'lib/index.js',
      'lib/client.js',
      'cordis.patch.yml',
      'locale/*.json',
      'icon.svg',
      'README.md',
    ]))
  })

  it('通过 esbuild 脚本构建 Client，并提供产物校验脚本', () => {
    const { scripts } = manifest()
    expect(scripts.build).toBe('node scripts/build-client.mjs')
    expect(scripts.verify).toBe('node scripts/verify-build.mjs')
    expect(scripts.test).toBe('vitest run')
  })
})

describe('cordis.patch.yml', () => {
  it('只插入一行，id 与 name 都是包名且未禁用', () => {
    const patch = parseYaml(readText('cordis.patch.yml'))
    expect(Array.isArray(patch)).toBe(true)
    expect(patch).toHaveLength(1)

    const [layer] = patch
    expect(Array.isArray(layer.insert)).toBe(true)
    expect(layer.insert).toHaveLength(1)

    const [row] = layer.insert
    expect(row.id).toBe(PACKAGE_NAME)
    expect(row.name).toBe(PACKAGE_NAME)
    expect(row.disabled).toBeUndefined()
    expect(row.config ?? {}).toEqual({})
  })
})

describe('tsconfig.json', () => {
  it('以 strict 与 bundler 解析编译 src', () => {
    const { compilerOptions, include } = readJson('tsconfig.json')
    expect(compilerOptions.strict).toBe(true)
    expect(compilerOptions.noEmit).toBe(true)
    expect(String(compilerOptions.moduleResolution).toLowerCase()).toBe('bundler')
    expect(include).toEqual(expect.arrayContaining(['src']))
  })
})

describe('Host 入口', () => {
  it('导出 apply(ctx, config) 与 volatile Config，并注册设置服务与管理 RPC', async () => {
    const host = await import('../../src/host/index.ts')
    expect(typeof host.apply).toBe('function')
    expect(host.apply.length).toBe(2)
    expect(host.Config).toBeDefined()
    expect([...host.inject].sort()).toEqual(['configEditor', 'connection', 'credentials', 'tools'])

    const double = createSettingsDouble()
    const routes = new Map<string, { path: string }>()
    let effects = 0
    let disposal: (() => Promise<void>) | undefined
    const ctx = {
      connection: {
        fetch: {
          register(route: { path: string }) {
            routes.set(route.path, route)
            return async () => { routes.delete(route.path) }
          },
        },
        rpc: { async call() { return { ok: true, value: undefined } } },
      },
      configEditor: double.editor,
      credentials: new MemoryCredentials(),
      fiber: {
        entry: {
          id: 'dsh-web-search-channels',
          options: { id: 'dsh-web-search-channels', name: 'dsh-web-search-channels', config: {} },
          fiber: {},
        },
      },
      on: () => () => {},
      effect(execute: () => Promise<() => Promise<void>> | (() => Promise<void>) | void) {
        effects += 1
        const result = execute()
        if (result instanceof Promise) return result.then((dispose) => { disposal = dispose })
        disposal = result ?? undefined
        return disposal
      },
    }

    expect(() => { host.apply(ctx as never, double.config) }).not.toThrow()
    expect(effects).toBe(1)
    expect(routes.has('/api/web-search-channels')).toBe(true)
    await Promise.resolve()
    await disposal?.()
  })
})

describe('Client 入口', () => {
  it('运行时 inject 恰好是 slots、locale、configForms、connection', async () => {
    const client = await import('../../src/client/index.ts')
    expect(Array.isArray(client.inject)).toBe(true)
    expect([...client.inject].sort()).toEqual(['configForms', 'connection', 'locale', 'slots'])
  })

  it('把设置卡注册进 plugins.bundle.config，key 等于包名', async () => {
    const client = await import('../../src/client/index.ts')
    const registered: { options: Record<string, any>; component: unknown }[] = []
    const locale = createLocaleDouble()
    const configForms = {
      get: () => ({
        getSnapshot: () => ({
          status: 'loading' as const,
          value: undefined,
          base: undefined,
          user: undefined,
          revision: undefined,
          writable: false,
        }),
        subscribe: () => () => {},
      }),
    }
    const connection = {
      fetch: { register: () => async () => {} },
      rpc: { async call() { return { ok: true as const, value: undefined } } },
    }

    const ctx = {
      effect: (fn: () => unknown) => {
        const disposer = fn()
        return () => { if (typeof disposer === 'function') (disposer as () => void)() }
      },
      locale: locale.service,
      configForms,
      connection,
      slots: {
        inject: (_name: string, callback: () => unknown) => {
          callback()
          return () => {}
        },
        register: (options: Record<string, any>, component: unknown) => {
          registered.push({ options, component })
          return () => {}
        },
      },
    }

    client.apply(ctx as never)

    expect(registered).toHaveLength(1)
    const [{ options, component }] = registered
    expect(options.name).toBe('plugins.bundle.config')
    expect(options.key).toBe(PACKAGE_NAME)
    expect([...locale.namespaces().keys()]).toEqual([options.locale])

    const injected = options.inject()
    expect(injected.configForms).toBe(configForms)
    expect(injected.connection).toBe(connection)
    const styles = (await import('../../src/client/styles/settings-card.module.css')) as { default: Record<string, string> }
    const page = renderToStaticMarkup(createElement(component as never, { view: 'page', ...injected }))
    expect(typeof styles.default.stack).toBe('string')
    expect(styles.default.stack).not.toBe('')
    expect(page).toContain(`class="${styles.default.stack}"`)
    expect(page).toContain('网页搜索渠道')
    expect(page).toContain('设置加载中')
  })

  it('summary 视图不渲染设置卡，英文文案来自 en 字典', async () => {
    const client = await import('../../src/client/index.ts')
    const registered: { options: Record<string, any>; component: unknown }[] = []
    const locale = createLocaleDouble()

    client.apply({
      effect: (fn: () => unknown) => { fn(); return () => {} },
      locale: locale.service,
      slots: {
        inject: (_name: string, callback: () => unknown) => { callback(); return () => {} },
        register: (options: Record<string, any>, component: unknown) => {
          registered.push({ options, component })
          return () => {}
        },
      },
    } as never)

    const [{ options, component }] = registered
    const injected = options.inject()
    expect(renderToStaticMarkup(createElement(component as never, { view: 'summary', ...injected }))).toBe('')

    locale.setActive('en')
    const english = renderToStaticMarkup(createElement(component as never, { view: 'page', ...injected }))
    expect(english).toContain('Web search channels')
    expect(english).toContain('Loading settings')
  })

  it('只以 import type 引用 Harness Client 包，不产生运行时值导入', () => {
    for (const file of ['src/client/index.ts', 'src/client/SettingsCard.tsx']) {
      const source = readText(file)
      const valueImports = [...source.matchAll(/^\s*import\s+(?!type\b)[^\n]*?\sfrom\s+['"]@deepseek-ai\/[^'"]+['"]/gm)]
      expect(valueImports, `${file} 不得值导入 Harness Client 包`).toEqual([])
    }
  })
})

describe('样式与 locale 资源', () => {
  it('settings-card.module.css 定义 .stack 骨架类', () => {
    expect(readText('src/client/styles/settings-card.module.css')).toMatch(/\.stack\s*\{/)
  })

  it('提供真实中英文 meta.title 与 meta.description', () => {
    const zh = readJson('locale/zh.json')
    const en = readJson('locale/en.json')

    for (const dict of [zh, en]) {
      expect(typeof dict.meta?.title).toBe('string')
      expect(dict.meta.title.trim()).not.toBe('')
      expect(typeof dict.meta?.description).toBe('string')
      expect(dict.meta.description.trim()).not.toBe('')
    }

    expect(zh.meta.title).toBe('网页搜索渠道')
    expect(en.meta.title).toBe('Web search channels')
    expect(zh.meta.title).not.toBe(en.meta.title)
    expect(zh.meta.title).toMatch(/[\u4e00-\u9fff]/)
    expect(en.meta.title).toMatch(/^[A-Za-z0-9 .:·—-]+$/)
  })
})

describe('构建链与展示资源', () => {
  it('提供 build-client 与 verify-build 脚本', () => {
    expect(existsSync(path.join(ROOT, 'scripts', 'build-client.mjs'))).toBe(true)
    expect(existsSync(path.join(ROOT, 'scripts', 'verify-build.mjs'))).toBe(true)
  })

  it('README 说明插件用途', () => {
    const readme = readText('README.md')
    expect(readme).toContain(PACKAGE_NAME)
    expect(readme).toContain('网页搜索')
  })

  it('icon.svg 是可解析的 SVG 文档', () => {
    expect(readText('icon.svg')).toMatch(/^<svg[\s>]/)
  })
})
