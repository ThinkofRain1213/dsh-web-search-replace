/**
 * Task 15 切片 1：真实 LocalCredentialProvider 的隔离临时文件合同。
 *
 * 只写入 mkdtemp 创建的 fixture；不读取用户 profile、真实凭据或网络。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { afterEach, describe, expect, it } from 'vitest'

import { buildCredentialKey } from '../../src/host/accounts/store.ts'

const roots: string[] = []

afterEach(async () => {
  // 临时测试目录可按项目规则直接删除；绝不指向真实 profile。
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createProvider() {
  const root = await mkdtemp(join(tmpdir(), 'task15-credentials-'))
  roots.push(root)
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, {
    path: join(root, 'credentials.yaml'),
    dshHome: root,
    watch: false,
  })
  await fiber
  return {
    provider: ctx.credentials,
    path: join(root, 'credentials.yaml'),
    dispose: async () => { await fiber.dispose() },
  }
}

describe('真实 credentials provider（隔离临时文件）', () => {
  it('missing→undefined、list 不含 payload、modify 排他且 undefined no-op', async () => {
    const { provider, path, dispose } = await createProvider()
    try {
      const key = buildCredentialKey('dsh-web-search-channels', 'qoder-fixture')
      expect(await provider.readRecord(key)).toBeUndefined()

      let releaseFirst!: () => void
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
      let firstEntered = 0
      let secondEntered = 0
      const first = provider.modifyRecord(key, async () => {
        firstEntered += 1
        await firstGate
        return { kind: 'grant', payload: { sequence: 1 } }
      })
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      const second = provider.modifyRecord(key, async (current) => {
        secondEntered += 1
        expect(current).toEqual({ kind: 'grant', payload: { sequence: 1 } })
        return { kind: 'grant', payload: { sequence: 2 } }
      })
      await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
      expect(firstEntered).toBe(1)
      expect(secondEntered).toBe(0)
      releaseFirst()
      await Promise.all([first, second])
      expect(secondEntered).toBe(1)

      const before = await readFile(path, 'utf8')
      const unchanged = await provider.modifyRecord(key, async () => undefined)
      expect(unchanged).toEqual({ kind: 'grant', payload: { sequence: 2 } })
      expect(await readFile(path, 'utf8')).toBe(before)
      const entries = await provider.listRecords()
      expect(entries).toEqual([{ key, kind: 'grant' }])
      expect(JSON.stringify(entries)).not.toContain('sequence')
    } finally {
      await dispose()
    }
  })

  it('mutate 错误传播且不写；pre-callback abort 可阻止，post-callback abort 只能 await 物理提交', async () => {
    const { provider, dispose } = await createProvider()
    try {
      const failedKey = buildCredentialKey('dsh-web-search-channels', 'buddy-failure')
      const sentinel = new Error('fixture mutation failed')
      await expect(provider.modifyRecord(failedKey, async () => { throw sentinel })).rejects.toBe(sentinel)
      expect(await provider.readRecord(failedKey)).toBeUndefined()

      const cancelledKey = buildCredentialKey('dsh-web-search-channels', 'buddy-cancelled')
      const beforeCallback = new AbortController()
      beforeCallback.abort()
      await expect(provider.modifyRecord(cancelledKey, async () => {
        if (beforeCallback.signal.aborted) throw new Error('settings/cancelled')
        return { kind: 'grant', payload: { mustNotWrite: true } }
      })).rejects.toThrow('settings/cancelled')
      expect(await provider.readRecord(cancelledKey)).toBeUndefined()

      const committedKey = buildCredentialKey('dsh-web-search-channels', 'buddy-committed')
      const afterCallback = new AbortController()
      const committed = await provider.modifyRecord(committedKey, async () => {
        const next = { kind: 'grant', payload: { physicallyCommitted: true } } as const
        // callback 即将返回；此后 AbortSignal 不属于 provider 合同，不能回滚写入。
        afterCallback.abort()
        return next
      })
      expect(afterCallback.signal.aborted).toBe(true)
      expect(committed).toEqual({ kind: 'grant', payload: { physicallyCommitted: true } })
      expect(await provider.readRecord(committedKey)).toEqual({
        kind: 'grant', payload: { physicallyCommitted: true },
      })
    } finally {
      await dispose()
    }
  })
})
