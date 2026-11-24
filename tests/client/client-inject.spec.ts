// @vitest-environment jsdom
/**
 * task-11 真实 Client/Cordis 形状回归：设置卡的服务必须来自 `ctx.inject`
 * 服务作用域，而不是 apply 时捕获的插件上下文属性。
 *
 * 独立真实实例证据：`plugins.bundle.config` 已经渲染出设置卡（apply 已执行、
 * locale 已注册），但 React props 的 `configForms` 与 `connection` 都是
 * undefined，Host `settings.describe` 的命名空间与值却正常。
 *
 * 本文件使用运行时真实依赖 `@deepseek-ai/cordis` 的 Context/Fiber，分两层
 * 复现证据：
 *
 * 1. 真实 Client 上下文形状（未被 fiber inject 声明的读取）：直接读取
 *    `configForms`/`connection` 得到 undefined，而 `ctx.inject([...], scope)`
 *    在服务提供者就绪后给出两项真实服务；
 * 2. 真实插件应用形状：模块 `inject` 只声明 apply 自己直接使用的
 *    `slots`/`locale`，`configForms`/`connection` 由其它插件稍后提供。
 *    设置卡只能在该服务作用域内注册，注入面绝不携带 undefined。
 */
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { SettingsCard, type SettingsCardProps } from '../../src/client/SettingsCard.tsx'
import * as clientModule from '../../src/client/index.ts'
import { Config } from '../../src/host/config.ts'
import { isAccountOrAuthMethod, routeAccounts } from './support/accounts-harness.ts'
import { clientSchemaFailure, hostDescribedForm } from '../unit/support/host-settings-schema.ts'
import {
  createConfigFormsDouble,
  createConnectionDouble,
  flush,
  makeSnapshot,
  mount,
  query,
  type MountedRoot,
  type RpcResponder,
} from './support/settings-harness.ts'

/** apply 在真实 Cordis 插件上下文里直接使用的服务。 */
const DIRECT_SERVICES = ['slots', 'locale'] as const

/** 一次真实 slot 注册。 */
interface RegisteredCard {
  readonly options: Record<string, unknown>
  readonly component: unknown
}

/** locale 服务替身：记录命名空间字典并按 active locale 查值。 */
interface LocaleDouble {
  readonly service: {
    register(ns: string, dicts: Record<'zh' | 'en', Record<string, string>>): () => void
    bind(ns: string): (key: string) => string
  }
  readonly namespaces: Map<string, Record<'zh' | 'en', Record<string, string>>>
  setActive(locale: 'zh' | 'en'): void
}

/** 创建与真实 locale 服务同形的替身。 */
function createLocaleDouble(): LocaleDouble {
  const namespaces = new Map<string, Record<'zh' | 'en', Record<string, string>>>()
  let active: 'zh' | 'en' = 'zh'
  return {
    service: {
      register: (ns, dicts) => {
        namespaces.set(ns, dicts)
        return () => { namespaces.delete(ns) }
      },
      bind: ns => key => namespaces.get(ns)?.[active]?.[key] ?? key,
    },
    namespaces,
    setActive: (locale) => { active = locale },
  }
}

/** slot 服务替身：立即执行已声明槽位的 inject 回调，并记录/移除注册。 */
function createSlotsDouble(): {
  readonly service: {
    inject(name: string, callback: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  readonly cards: RegisteredCard[]
} {
  const cards: RegisteredCard[] = []
  return {
    service: {
      inject(_name, callback) {
        const disposer = callback()
        return () => { if (typeof disposer === 'function') (disposer as () => void)() }
      },
      register(options, component) {
        const card = { options, component }
        cards.push(card)
        return () => {
          const index = cards.indexOf(card)
          if (index >= 0) cards.splice(index, 1)
        }
      },
    },
    cards,
  }
}

/** 用独立真实插件 fiber 在根上下文上提供一个服务。 */
async function provide(root: Context, name: string, value: unknown): Promise<Fiber> {
  return await root.plugin({
    apply(ctx) { ctx.provide(name, value) },
  })
}

/** 等待 Cordis 的 reapply/dispose 微任务链稳定。 */
async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

/** 一次设置卡的注入面。 */
function injectedFace(card: RegisteredCard): Record<string, unknown> {
  const inject = card.options.inject
  if (typeof inject !== 'function') throw new Error('设置卡注册缺少 inject 注入面')
  return (inject as () => Record<string, unknown>)()
}

/**
 * 真实插件应用形状：模块 inject 只声明 DIRECT_SERVICES，slots/locale 已在
 * 根上，configForms/connection 留待测试稍后提供。
 */
async function createClientHarness() {
  const root = new Context()
  const slots = createSlotsDouble()
  const locale = createLocaleDouble()
  await provide(root, 'slots', slots.service)
  await provide(root, 'locale', locale.service)
  const clientFiber = root.plugin({
    inject: [...DIRECT_SERVICES],
    apply: clientModule.apply as never,
  })
  await clientFiber
  return { root, slots, locale, clientFiber }
}

const mounted: MountedRoot[] = []

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

describe('Client 服务注入（真实 Cordis）', () => {
  it('直接读取未声明的服务为 undefined，服务作用域注入提供两项服务', async () => {
    // 真实 Client 上下文形状：slots/locale 已提供，configForms/connection
    // 尚未提供。直接读取（无 fiber inject 检查）得到 undefined —— 独立实例
    // 观察到的证据形状。
    const root = new Context()
    await provide(root, 'slots', createSlotsDouble().service)
    await provide(root, 'locale', createLocaleDouble().service)
    const direct = root as unknown as { configForms?: unknown; connection?: unknown }
    expect(direct.configForms).toBeUndefined()
    expect(direct.connection).toBeUndefined()

    // 同一上下文的 `ctx.inject([...], scope)` 在服务就绪后给出真实服务。
    const configForms = createConfigFormsDouble(makeSnapshot()).configForms
    const connection = createConnectionDouble(() => ({ ok: true, value: makeSnapshot() })).connection
    let scoped: { configForms?: unknown; connection?: unknown } | undefined
    const scopeFiber = root.inject(['configForms', 'connection'], (scope) => {
      scoped = {
        configForms: (scope as unknown as { configForms?: unknown }).configForms,
        connection: (scope as unknown as { connection?: unknown }).connection,
      }
    })
    expect(scoped).toBeUndefined()
    await provide(root, 'configForms', configForms)
    await provide(root, 'connection', connection)
    await settle()
    expect(scoped?.configForms).toBe(configForms)
    expect(scoped?.connection).toBe(connection)
    await scopeFiber.dispose()
  })

  it('设置卡只在服务作用域就绪后注册，注入面同时携带两项服务', async () => {
    const { root, slots, locale, clientFiber } = await createClientHarness()

    // apply 已执行、locale 已注册；但两项服务缺失时绝不注册注入面为
    // undefined 的卡片（当前实现会在此处提前注册）。
    expect(locale.namespaces.has(clientModule.NS)).toBe(true)
    expect(slots.cards).toHaveLength(0)

    // 只有 configForms 时仍不注册：connection 同时是硬要求。
    const forms = createConfigFormsDouble(makeSnapshot())
    const formsProvider = await provide(root, 'configForms', forms.configForms)
    await settle()
    expect(slots.cards).toHaveLength(0)

    const rpc = createConnectionDouble(() => ({ ok: true, value: makeSnapshot() }))
    await provide(root, 'connection', rpc.connection)
    await settle()

    // 两项服务就绪后，服务作用域触发注册，注入面携带两项真实服务。
    expect(slots.cards).toHaveLength(1)
    const [card] = slots.cards
    expect(card.options.name).toBe('plugins.bundle.config')
    expect(card.options.key).toBe(clientModule.PACKAGE_NAME)
    expect(card.options.locale).toBe(clientModule.NS)
    expect(card.component).toBe(SettingsCard)
    const face = injectedFace(card)
    expect(face.configForms).toBe(forms.configForms)
    expect(face.connection).toBe(rpc.connection)
    expect((face.t as (key: string) => string)('settings.title')).toBe('网页搜索替换')

    // 服务提供者卸载：子作用域释放，卡片注册被清理。
    await formsProvider.dispose()
    await settle()
    expect(slots.cards).toHaveLength(0)

    // 重新提供：作用域重建，注入面换成新的服务实例。
    const nextForms = createConfigFormsDouble(makeSnapshot({ enabled: true, channel: 'qoder' }))
    await provide(root, 'configForms', nextForms.configForms)
    await settle()
    expect(slots.cards).toHaveLength(1)
    expect(injectedFace(slots.cards[0]).configForms).toBe(nextForms.configForms)

    await clientFiber.dispose()
  })

  it('服务作用域注入的设置卡进入 ready、OFF 默认并提示无账号', async () => {
    const { root, slots, locale } = await createClientHarness()
    const snapshot = makeSnapshot({ enabled: false, channel: 'buddy' })
    const forms = createConfigFormsDouble(snapshot)
    const accounts = routeAccounts({})
    const settingsResponder: RpcResponder = () => ({ ok: true, value: snapshot })
    const routed: RpcResponder = call => (
      isAccountOrAuthMethod(call.method) ? accounts(call) : settingsResponder(call)
    )
    const rpc = createConnectionDouble(routed, {
      ignoredMethods: ['accounts.list', 'accounts.current'],
    })

    await provide(root, 'configForms', forms.configForms)
    await provide(root, 'connection', rpc.connection)
    await settle()
    expect(slots.cards).toHaveLength(1)
    const face = injectedFace(slots.cards[0])
    expect(face.connection).toBe(rpc.connection)

    const mountedRoot = mount(createElement(SettingsCard, {
      view: 'page',
      ...face,
    } as unknown as SettingsCardProps))
    mounted.push(mountedRoot)
    await flush()

    const stack = query<HTMLElement>(mountedRoot.container, '[data-dsh-web-search-replace="settings-card"]')
    expect(stack.getAttribute('data-settings-status')).toBe('ready')
    expect(forms.getCalls).toContain(clientModule.PACKAGE_NAME)

    const toggle = query<HTMLButtonElement>(mountedRoot.container, '[role="switch"]')
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    const config = query<HTMLElement>(mountedRoot.container, '[data-channel-config-host]')
    expect(config.getAttribute('data-channel')).toBe('buddy')
    expect(query(config, '[data-account-state]').getAttribute('data-account-state')).toBe('required')
    expect(config.textContent).toContain('需要账号')
    expect(mountedRoot.container.querySelector('[role="alert"]')).toBeNull()
    expect(locale.namespaces.get(clientModule.NS)?.zh['settings.title']).toBe('网页搜索替换')
  })

  it('真实 Host schema 投影值与服务作用域注入组合后卡片 ready', async () => {
    // 真实 Config 经 rc.5 Host `settings.describe` 投影：schema 信封与表单值
    // 都来自真实 Schemastery 序列化，而不是手写 plain object。
    const described = hostDescribedForm(Config)
    const value = described.project(Config({}))
    // 对应客户端 ConfigFormController.decode 的 schema 校验步骤；失败时
    // 整个表单被判为不可用（loading）。
    expect(clientSchemaFailure(described.wire, value)).toBeUndefined()

    const { root, slots } = await createClientHarness()
    const forms = createConfigFormsDouble(value, { status: 'ready', writable: true })
    const accounts = routeAccounts({})
    const rpc = createConnectionDouble(call => (
      isAccountOrAuthMethod(call.method)
        ? accounts(call)
        : { ok: true, value: value as never }
    ), { ignoredMethods: ['accounts.list', 'accounts.current'] })

    await provide(root, 'configForms', forms.configForms)
    await provide(root, 'connection', rpc.connection)
    await settle()
    expect(slots.cards).toHaveLength(1)

    const mountedRoot = mount(createElement(SettingsCard, {
      view: 'page',
      ...injectedFace(slots.cards[0]),
    } as unknown as SettingsCardProps))
    mounted.push(mountedRoot)
    await flush()

    const stack = query<HTMLElement>(mountedRoot.container, '[data-dsh-web-search-replace="settings-card"]')
    expect(stack.getAttribute('data-settings-status')).toBe('ready')
    const toggle = query<HTMLButtonElement>(mountedRoot.container, '[role="switch"]')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    const config = query<HTMLElement>(mountedRoot.container, '[data-channel-config-host]')
    expect(query(config, '[data-account-state]').getAttribute('data-account-state')).toBe('required')
    expect(config.textContent).toContain('需要账号')
  })

  it('运行时 inject 只声明 apply 真正直接使用的服务', () => {
    expect([...clientModule.inject].sort()).toEqual([...DIRECT_SERVICES].sort())
  })
})
