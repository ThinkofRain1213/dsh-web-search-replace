/**
 * 真实 ConfigEditor + 隔离临时 profile 的合同证据。
 *
 * Loader reconcile 是唯一替换的边界（本测试不启动 Loader）；ConfigEditor 自身、
 * file lock、change callback、YAML 与 writeFileAtomic 都执行真实实现。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SettingsService } from '../../src/host/settings/service.ts'
import { createSettingsDouble } from '../unit/support/settings-double.ts'

vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  composeEntries: (groups: unknown[][]) => groups.flat(),
  loadProfileDirectory: () => ({ layers: [], patches: [] }),
  readProfilePatches: (_name: string, _profile: unknown, loaded?: { patches: unknown[] }) => loaded?.patches ?? [],
  reconcileProfilePatches: async () => [],
}))

const { ConfigEditor } = await import('@deepseek-ai/dsh-config-editor')

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'task15-config-editor-'))
  roots.push(root)
  await writeFile(join(root, 'package.json'), '{}\n', 'utf8')
  const double = createSettingsDouble()
  const entry = {
    options: {
      id: 'dsh-web-search-channels',
      name: 'dsh-web-search-channels',
      config: structuredClone(double.getState()) as unknown as Record<string, unknown>,
    },
    parent: { tree: { ctx: { fiber: { entry: { id: 'include' } } } } },
    fiber: {
      // Cordis const enum FiberState.ACTIVE（运行时无 enum 对象）。
      state: 2,
      resolveConfig(next: Record<string, unknown>) {
        entry.options.config = structuredClone(next)
      },
    },
  }
  const ctx = new Context()
  Object.assign(ctx, {
    profileContext: {
      dir: root,
      home: root,
      patchPath: join(root, 'cordis.patch.yml'),
      installAnchor: root,
      overlays: [],
      telemetryDisabledEnv: undefined,
    },
    loader: { entries: () => [entry] },
  })
  const configEditor = new ConfigEditor(ctx)
  const settings = new SettingsService({
    configEditor,
    entry: entry as never,
    config: double.config,
  })
  return { root, entry, settings }
}

describe('真实 ConfigEditor（隔离临时 profile）', () => {
  it('change callback 前的 abort 不写；callback 返回后的 abort 只能 await 物理提交', async () => {
    const first = await createFixture()
    const before = new AbortController()
    before.abort()
    await expect(first.settings.updateLastSuccessfulHost('api2.qoder.sh', before.signal))
      .rejects.toMatchObject({ code: 'settings/cancelled' })
    await expect(readFile(join(first.root, 'cordis.patch.yml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const second = await createFixture()
    const after = new AbortController()
    const originalResolve = second.entry.fiber.resolveConfig
    second.entry.fiber.resolveConfig = (next) => {
      originalResolve(next)
      // change 已返回，进入真实 ConfigEditor 的后续校验/物理提交阶段。
      after.abort()
    }
    await second.settings.updateLastSuccessfulHost('api2.qoder.sh', after.signal)
    expect(after.signal.aborted).toBe(true)
    const document = await readFile(join(second.root, 'cordis.patch.yml'), 'utf8')
    expect(document).toContain('lastSuccessfulHost: api2.qoder.sh')
    expect(JSON.stringify(second.settings.getSnapshot())).not.toContain('lastSuccessfulHost')
  })
})
