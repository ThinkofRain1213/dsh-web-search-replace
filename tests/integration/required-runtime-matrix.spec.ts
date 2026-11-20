/**
 * 必测运行矩阵门禁（静态阶段）：
 *
 * 发布证据文档必须逐项列出 Global Constraints 的最低验收矩阵，且每项都带有
 * 明确状态与证据/边界说明。当前只完成自动化静态阶段时，真实 Desktop、
 * Web GUI、Native/PTC、指定模型、四个厂商账号与浏览器量取都必须如实保持
 * `NOT RUN` / `PENDING`，不能通过 skip、删项或虚构 PASS 冒充真实运行。
 *
 * 当文档阶段切换为 `real-acceptance` 后，PASS/FAIL 行才被允许，但仍必须提供
 * 实际执行证据；本门禁不会把“写了 PASS”当成通过。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const DOC = path.join(ROOT, 'docs', 'verification', '2026-11-18-0.1.0.md')
const RELEASE_GATES = path.join(ROOT, 'tests', 'integration', 'release-gates.spec.ts')
const THIS_SPEC = path.join(ROOT, 'tests', 'integration', 'required-runtime-matrix.spec.ts')
const CONFIG = path.join(ROOT, 'vitest.config.ts')
const MANIFEST = path.join(ROOT, 'package.json')

interface RuntimeItem {
  readonly id: string
  readonly keywords: readonly string[]
}

/** Global Constraints 最低验收矩阵的必测项；缺任一项都阻断发布。 */
const REQUIRED_RUNTIME: readonly RuntimeItem[] = [
  { id: 'RM-01', keywords: ['0.2.2-rc.3', 'Web GUI'] },
  { id: 'RM-02', keywords: ['Native'] },
  { id: 'RM-03', keywords: ['PTC'] },
  { id: 'RM-04', keywords: ['Kimi-K3.1 Pro'] },
  { id: 'RM-05', keywords: ['DeepSeek V4.1 Flash'] },
  { id: 'RM-06', keywords: ['官方路由', 'OFF'] },
  { id: 'RM-07', keywords: ['CodeBuddy'] },
  { id: 'RM-08', keywords: ['WorkBuddy'] },
  { id: 'RM-09', keywords: ['Qoder 国际版'] },
  { id: 'RM-10', keywords: ['Qoder 中国版'] },
  { id: 'RM-11', keywords: ['计算样式'] },
  { id: 'RM-12', keywords: ['键盘', 'Escape'] },
  { id: 'RM-13', keywords: ['390px', 'zh/en'] },
  { id: 'RM-14', keywords: ['CSS', '交集'] },
  { id: 'RM-15', keywords: ['安装', '插件详情'] },
]

interface StaticItem {
  readonly id: string
  readonly commandTokens: readonly string[]
}

/** 本任务必须实际执行并记录的静态命令（`pnpm verify` 在跑通后另行补记）。 */
const REQUIRED_STATIC: readonly StaticItem[] = [
  {
    id: 'SC-01',
    commandTokens: [
      'vitest run tests/integration/release-gates.spec.ts',
      'tests/integration/required-runtime-matrix.spec.ts',
    ],
  },
  { id: 'SC-02', commandTokens: ['DSH_TEST_EXPECTED_VERSION=0.2.2-rc.5', 'pnpm test'] },
  { id: 'SC-03', commandTokens: ['pnpm test:integration'] },
  { id: 'SC-04', commandTokens: ['pnpm typecheck'] },
  { id: 'SC-05', commandTokens: ['pnpm build'] },
  { id: 'SC-06', commandTokens: ['node scripts/verify-build.mjs'] },
  { id: 'SC-07', commandTokens: ['node scripts/verify-css-isolation.mjs'] },
  { id: 'SC-08', commandTokens: ['node scripts/verify-package.mjs'] },
  { id: 'SC-10', commandTokens: ['git diff --check'] },
]

interface EvidenceRow {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly evidence: string
}

/** 解析四列表格中指定前缀的证据行。 */
function parseEvidenceRows(markdown: string, prefix: string): EvidenceRow[] {
  const rows: EvidenceRow[] = []
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length !== 4) continue
    const [id, title, status, evidence] = cells
    if (id === undefined || title === undefined || status === undefined || evidence === undefined) continue
    if (!new RegExp(`^${prefix}-\\d{2}$`).test(id)) continue
    rows.push({ id, title, status, evidence })
  }
  return rows
}

/** 读取当前文档阶段；未声明阶段视为不合格。 */
function readPhase(markdown: string): string {
  const match = /^-\s*阶段[：:]\s*([a-z-]+)\s*$/m.exec(markdown)
  return match?.[1] ?? ''
}

describe('必测运行矩阵与发布证据', () => {
  it('证据文档存在，声明阶段并明确 0.1.0 尚未完成发布验收', async () => {
    const markdown = await readFile(DOC, 'utf8').catch(() => '')
    expect(markdown, '缺少 docs/verification/2026-11-18-0.1.0.md').not.toBe('')
    const phase = readPhase(markdown)
    expect(['static-only', 'real-acceptance'], '证据文档必须声明阶段').toContain(phase)
    expect(markdown).toContain('0.1.0 尚未完成发布验收')
    expect(markdown).toContain('NOT RUN')
    expect(markdown).toContain('PENDING')
    expect(markdown).toContain('R46')
  })

  it('必测矩阵逐项存在，静态阶段不得把真实项写成 PASS/SKIP', async () => {
    const markdown = await readFile(DOC, 'utf8').catch(() => '')
    const phase = readPhase(markdown)
    expect(phase).not.toBe('')
    const rows = parseEvidenceRows(markdown, 'RM')
    const byId = new Map(rows.map(row => [row.id, row]))
    expect(new Set(rows.map(row => row.id)).size, '矩阵存在重复 ID').toBe(rows.length)

    for (const required of REQUIRED_RUNTIME) {
      const row = byId.get(required.id)
      expect(row, `必测矩阵缺少 ${required.id}`).toBeDefined()
      for (const keyword of required.keywords) {
        expect(row?.title, `${required.id} 未描述必测项 ${keyword}`).toContain(keyword)
      }
      expect(
        ['NOT RUN', 'PENDING', 'PASS', 'FAIL'],
        `${required.id} 状态非法：${row?.status ?? ''}`,
      ).toContain(row?.status)
      expect(row?.evidence.length ?? 0, `${required.id} 缺少证据/边界说明`).toBeGreaterThan(10)
      expect(row?.status, `${required.id} 不得使用 SKIP 状态`).not.toMatch(/SKIP/i)
      if (phase === 'static-only') {
        expect(
          ['NOT RUN', 'PENDING'],
          `${required.id} 在静态阶段只能如实记为 NOT RUN/PENDING，不能虚构 PASS：${row?.status ?? ''}`,
        ).toContain(row?.status)
      } else {
        expect(markdown, '真实验收阶段缺少执行记录章节').toContain('## 真实验收执行记录')
      }
    }
  })

  it('静态自动化证据逐项记录命令、PASS 与实际结果', async () => {
    const markdown = await readFile(DOC, 'utf8').catch(() => '')
    const rows = parseEvidenceRows(markdown, 'SC')
    const byId = new Map(rows.map(row => [row.id, row]))
    for (const required of REQUIRED_STATIC) {
      const row = byId.get(required.id)
      expect(row, `静态证据缺少 ${required.id}`).toBeDefined()
      for (const token of required.commandTokens) {
        expect(row?.title, `${required.id} 命令缺少 ${token}`).toContain(token)
      }
      expect(row?.status, `${required.id} 状态应为 PASS`).toBe('PASS')
      expect(row?.evidence.length ?? 0, `${required.id} 缺少实际结果`).toBeGreaterThan(8)
    }
  })

  it('门禁测试自身未被 skip/todo/only，且 Vitest 不排除集成测试', async () => {
    for (const file of [RELEASE_GATES, THIS_SPEC]) {
      const text = await readFile(file, 'utf8')
      expect(text, `${path.basename(file)} 不得 skip/todo`).not.toMatch(
        /\b(?:it|test|describe)\.(?:skip|todo|only)\s*\(/,
      )
      expect(text, `${path.basename(file)} 不得使用 xit/xdescribe`).not.toMatch(
        /\b(?:xit|xdescribe|xtest)\s*\(/,
      )
    }
    const config = await readFile(CONFIG, 'utf8')
    expect(config).not.toMatch(/\bexclude\s*:/)
    const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(manifest.scripts['test:integration']).toContain('tests/integration')
    expect(manifest.scripts.test).toBe('vitest run')
  })
})
