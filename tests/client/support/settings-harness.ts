/**
 * Client DOM/controller 测试的共用夹具。
 *
 * 这里只提供 Host 边界替身（configForms 快照、Connection RPC、locale 字典）与
 * 真实 React DOM 挂载器；组件、控制器和 CSS 都由产品代码执行，不用 mock 组件
 * 代替真实渲染。
 */
import { act } from 'react'
import type { ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ChannelId, QoderEndpointPreference } from '../../../src/shared/channels.ts'
import type { SearchSettingsSnapshot } from '../../../src/shared/contracts.ts'
import type { RpcResult } from '../../../src/shared/rpc.ts'
import { en, zh } from '../../../src/client/locales.ts'

// React 18 的 act 需要这个全局标记，否则测试输出会出现未包裹更新警告。
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 测试使用的两种 locale。 */
export type TestLocale = 'zh' | 'en'

/**
 * 读取真实产品字典并返回翻译函数。
 * @param locale - 中文或英文。
 * @returns 与 `ctx.locale.bind(NS)` 行为一致的同步查表函数。
 */
export function translator(locale: TestLocale): (key: string) => string {
  const dictionary = locale === 'zh' ? zh : en
  return (key: string) => dictionary[key] ?? key
}

/** 构造设置快照时可覆盖的字段。 */
export interface SnapshotOptions {
  readonly enabled?: boolean
  readonly channel?: ChannelId
  readonly buddyAccount?: string | null
  readonly workbuddyAccount?: string | null
  readonly qoderAccount?: string | null
  readonly qodercnAccount?: string | null
  readonly endpointPreference?: QoderEndpointPreference
}

/**
 * 构造一份完整的 `SearchSettingsSnapshot`。
 * @param options - 需要偏离默认值的字段。
 * @returns 四渠道设置快照。
 */
export function makeSnapshot(options: SnapshotOptions = {}): SearchSettingsSnapshot {
  return {
    search: {
      enabled: options.enabled ?? false,
      channel: options.channel ?? 'buddy',
    },
    buddy: { currentAccountId: options.buddyAccount ?? null },
    workbuddy: { currentAccountId: options.workbuddyAccount ?? null },
    qoder: {
      currentAccountId: options.qoderAccount ?? null,
      endpointPreference: options.endpointPreference ?? 'auto',
    },
    qodercn: { currentAccountId: options.qodercnAccount ?? null },
  }
}

/** configForms 快照的最小结构（与 Host 的 ConfigFormSnapshot 同形）。 */
export interface ConfigFormSnapshotLike<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
}

/** 一个可手动推送快照的 configForms form 替身。 */
export class TestConfigForm<T> {
  private snapshot: ConfigFormSnapshotLike<T>
  private readonly listeners = new Set<() => void>()
  /** 当前快照。 */
  constructor(initial: Partial<ConfigFormSnapshotLike<T>> = {}) {
    this.snapshot = {
      status: initial.status ?? 'ready',
      value: initial.value,
      base: initial.base,
      user: initial.user,
      revision: initial.revision ?? 1,
      writable: initial.writable ?? true,
    }
  }

  /** 返回稳定引用。 */
  readonly getSnapshot = (): ConfigFormSnapshotLike<T> => this.snapshot

  /** 订阅快照替换。 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 推送一份新快照并通知所有订阅者。
   * @param next - 部分快照字段。
   */
  push(next: Partial<ConfigFormSnapshotLike<T>>): void {
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of [...this.listeners]) listener()
  }

  /** 当前订阅者数量，用于验证 dispose 清理。 */
  listenerCount(): number {
    return this.listeners.size
  }
}

/** configForms 服务替身与可供测试更新的 form。 */
export interface ConfigFormsDouble<T> {
  readonly configForms: { get(id: string): TestConfigForm<T> }
  readonly form: TestConfigForm<T>
  readonly getCalls: string[]
}

/**
 * 创建只服务单个设置命名空间的 configForms 替身。
 * @param value - 初始设置快照。
 * @param options - 初始状态与可写性。
 * @returns 服务、form 与 get 调用记录。
 */
export function createConfigFormsDouble<T>(
  value: T | undefined,
  options: { status?: ConfigFormSnapshotLike<T>['status']; writable?: boolean; revision?: number } = {},
): ConfigFormsDouble<T> {
  const form = new TestConfigForm<T>({
    value,
    status: options.status,
    writable: options.writable,
    revision: options.revision,
  })
  const getCalls: string[] = []
  return {
    configForms: {
      get: (id: string) => {
        getCalls.push(id)
        return form
      },
    },
    form,
    getCalls,
  }
}

/** 管理 RPC 的 method/payload 记录。 */
export interface RpcCall {
  readonly method: string
  readonly payload: unknown
}

/** 一次 RPC 响应；返回 Promise 可模拟在飞写入。 */
export type RpcResponder = (call: RpcCall) => RpcResult<unknown> | Promise<RpcResult<unknown>>

/** Connection 替身。 */
export interface ConnectionDouble {
  readonly connection: {
    readonly fetch: { register(): () => Promise<void> }
    readonly rpc: {
      call(
        channel: string,
        endpoint: string,
        payload: unknown,
        signal?: AbortSignal,
      ): Promise<RpcResult<unknown>>
    }
  }
  readonly calls: RpcCall[]
}

/**
 * 创建只实现 Client 调用面的 Connection 替身。
 * @param responder - 收到 method/payload 后返回结果。
 * @returns Connection 与调用记录。
 */
export function createConnectionDouble(responder: RpcResponder): ConnectionDouble {
  const calls: RpcCall[] = []
  return {
    connection: {
      fetch: { register: () => async () => {} },
      rpc: {
        call: async (
          _channel: string,
          _endpoint: string,
          payload: unknown,
        ): Promise<RpcResult<unknown>> => {
          const call = payload as RpcCall
          calls.push(call)
          return await responder(call)
        },
      },
    },
    calls,
  }
}

/** 可手动结算的 Promise。 */
export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

/**
 * 创建一个可由测试控制结算时机的 Promise。
 * @returns Promise 与 resolve/reject。
 */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/** 已挂载的真实 React DOM 根。 */
export interface MountedRoot {
  readonly container: HTMLElement
  readonly root: Root
  rerender(element: ReactElement): Promise<void>
  unmount(): void
}

/**
 * 把真实 React 组件挂到 document.body 下的容器。
 * @param element - 要渲染的元素。
 * @returns 容器、根与清理动作。
 */
export function mount(element: ReactElement): MountedRoot {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => { root.render(element) })
  let active = true
  return {
    container,
    root,
    rerender: async (next) => { await act(async () => { root.render(next) }) },
    unmount: () => {
      if (!active) return
      active = false
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** 等待 React 异步更新与 RPC 微任务稳定。 */
export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/**
 * 在 act 中派发一次鼠标点击。
 * @param element - 点击目标。
 */
export async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

/**
 * 在 act 中派发一次键盘事件。
 * @param element - 事件目标。
 * @param key - `KeyboardEvent.key`。
 * @param options - 可选的 shiftKey/ctrlKey 等。
 */
export async function keydown(
  element: Element,
  key: string,
  options: KeyboardEventInit = {},
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  })
  await act(async () => {
    element.dispatchEvent(event)
  })
  return event
}

/**
 * 在 act 中派发一次 pointerdown（jsdom 没有 PointerEvent 构造器）。
 * @param element - 事件目标。
 */
export async function pointerdown(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
  })
}

/**
 * 按 role/属性取唯一元素，缺失时给出清晰错误。
 * @param container - 查询根。
 * @param selector - CSS 选择器。
 * @returns 匹配元素。
 */
export function query<T extends Element>(container: ParentNode, selector: string): T {
  const element = container.querySelector<T>(selector)
  if (element === null) throw new Error(`找不到元素：${selector}`)
  return element
}

/**
 * 按文本取唯一按钮，用于菜单项断言。
 * @param container - 查询根。
 * @param text - 按钮可访问文本。
 * @returns 匹配按钮。
 */
export function buttonByText<T extends Element = HTMLButtonElement>(
  container: ParentNode,
  text: string,
): T {
  const buttons = [...container.querySelectorAll<HTMLElement>('button')]
  const match = buttons.find(button => button.textContent?.trim() === text)
  if (match === undefined) {
    throw new Error(`找不到文本为「${text}」的按钮；现有：${buttons.map(button => button.textContent).join(' | ')}`)
  }
  return match as unknown as T
}
