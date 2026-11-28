// Host-only logic formerly shared with the pure suite: markdown drawing and tool rows, plus booting
// through the Claude Code mod. The pure tests now live in core/tests/logic.test.ts.

import { describe, expect, mock, test } from 'claude-code/testing'

import { callSummary, firstLine, OMH_TOOL, resultText } from '../hooks/lib/toolrow'
import { drawMarkdown, hasPrismantis, looksLikeMarkdown, splitCollected } from '../hooks/lib/prismantis'

describe('prismantis', () => {
  test('a collected report splits into header, body and closing note', () => {
    const parts = splitCollected('===== T1 (/r/T1/result.md) =====\n## Done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n=====\nThis report is the claim.')
    expect(parts).toEqual({ header: 'T1 (/r/T1/result.md)', body: '## Done\n\n| a | b |\n|---|---|\n| 1 | 2 |', footer: 'This report is the claim.' })
    expect(splitCollected('dispatched T3 to w2')).toBe(null)
  })
  test('only tables, fences and headings count as markdown', () => {
    expect(looksLikeMarkdown('| Task | Status |\n|---|---|\n| T1 | done |')).toBe(true)
    expect(looksLikeMarkdown('x\n```ts\ncode\n```')).toBe(true)
    expect(looksLikeMarkdown('## Findings')).toBe(true)
    expect(looksLikeMarkdown('Run r1 — goal\n  ✅ T1         verified  title')).toBe(false)
    expect(looksLikeMarkdown('a | b')).toBe(false)
  })
  test('absent prismantis draws nothing; present, its drawing comes back', async () => {
    expect(await drawMarkdown({} as never, 'terminal', '# x', 80)).toBe(null)
    expect(await hasPrismantis({} as never, 'terminal')).toBe(false)
    const seen: { columns: number }[] = []
    const fake = { prismantis: { markdown: async (a: { columns: number }) => (seen.push(a), 'drawn') } }
    expect(await drawMarkdown(fake as never, 'terminal', '# x', 4)).toBe('drawn')
    expect(seen[0]!.columns).toBe(20)
    expect(await drawMarkdown(fake as never, 'terminal', '  ', 80)).toBe(null)
    expect(await hasPrismantis({ prismantis: { markdown: async () => undefined } } as never, 'terminal')).toBe(false)
  })
})

describe('tool rows', () => {
  const T = (n: string) => `mcp__oh-my-herdr__omh_${n}`
  test('a call shows a few fields, never the brief or plan body', () => {
    expect(OMH_TOOL.test(T('status'))).toBe(true)
    expect(OMH_TOOL.test('mcp__other__omh_status')).toBe(false)
    expect(callSummary(T('dispatch'), { task: 'T3', intent: 'implement', category: 'deep', rationale: 'r', brief: 'long brief' })).toBe('T3 · implement · deep')
    expect(callSummary(T('status'), { action: 'draft', markdown: '# Plan: gateways UI\n\n## Goal\nx' })).toBe('draft · Plan: gateways UI · 4 lines')
    expect(callSummary(T('status'), { action: 'draft', name: 'gateways-ui', markdown: '# Plan: gateways UI' })).toBe('draft · new run gateways-ui · Plan: gateways UI · 1 line')
    expect(callSummary(T('status'), { action: 'plan', plan: { goal: 'g', waves: [{ tasks: [1, 2] }, { tasks: [3] }] } })).toBe('plan · 2 waves, 3 tasks')
    expect(callSummary(T('status'), { action: 'gate', wave: 2 })).toBe('gate · W2')
    expect(callSummary(T('status'), {})).toBe('show')
    expect(callSummary(T('teardown'), {})).toBe('all')
  })
  test('a result shows its first line and how many follow', () => {
    expect(resultText([{ type: 'text', text: 'a\nb' }])).toBe('a\nb')
    expect(resultText({ content: [{ type: 'text', text: 'x' }] })).toBe('x')
    expect(firstLine('\nplan.md written\nNow give\nDo not')).toEqual({ line: 'plan.md written', more: 2 })
    expect(firstLine('x'.repeat(120)).line.length).toBe(80)
  })
})

describe('booting in a worktree', () => {
  const GIT: Record<string, string> = {
    'rev-parse --show-toplevel': '/wt/repo-b',
    'rev-parse --path-format=absolute --git-common-dir': '/main/repo/.git',
  }
  const PLAN = JSON.stringify({ goal: 'goal b', waves: [{ id: 1, gate: 'g', tasks: [{ id: 'T1', title: 't', intent: 'implement', category: 'deep', owns: [], deps: [] }] }] })

  async function boot($: any, on: any, mem: Map<string, string>, env: Record<string, string>) {
    const dirOf = (p: string) => [...mem.keys()].some(k => k.startsWith(`${p.replace(/\/$/, '')}/`))
    const asset = (p: string) => {
      const m = /\/skills\/oh-my-herdr\/assets\/(agents|config\.default)\.json$/.exec(p)?.[1]
      if (m === undefined) return undefined
      return JSON.stringify(m === 'agents' ? { claude: { launch: 'herdr-kind', kind: 'claude' } } : { profiles: { s: { agent: 'claude', family: 'claude', args: [] } }, categories: { deep: ['s'] } })
    }
    on('fs.read', (_$: any, e: any) => {
      const t = asset(e.path) ?? mem.get(e.path)
      if (t === undefined) throw new Error(`ENOENT ${e.path}`)
      return { value: t }
    })
    on('fs.write', (_$: any, e: any) => (mem.set(e.path, e.text), { value: undefined }))
    on('fs.exists', (_$: any, e: any) => ({ value: asset(e.path) !== undefined || mem.has(e.path) || dirOf(e.path) }))
    on('fs.stat', (_$: any, e: any) => {
      if (mem.has(e.path)) return { value: { kind: 'file', size: 1 } }
      if (dirOf(e.path)) return { value: { kind: 'dir', size: 0 } }
      throw new Error(`ENOENT ${e.path}`)
    })
    on('fs.list', (_$: any, e: any) => {
      const dir = `${e.path.replace(/\/$/, '')}/`
      const names = new Set([...mem.keys()].filter(k => k.startsWith(dir)).map(k => k.slice(dir.length).split('/')[0]!))
      return { value: [...names].map(name => ({ name, kind: mem.has(dir + name) ? 'file' : 'dir', size: 0 })) }
    })
    on('process.run', (_$: any, e: any) => {
      const out = e.argv[0] === 'git' ? GIT[e.argv.slice(1).join(' ')] : undefined
      return { value: { exitCode: out === undefined ? 1 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('http.fetch', () => {
      throw new Error('offline')
    })
    mock.env(on, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HOME: '/home/u', ...env })
    const clock = mock.clock(on, { now: new Date(2026, 10, 21, 20, 0).getTime() } as never)
    on('tool.register', (_$: any, e: any) => ({ value: { tool: `mcp__oh-my-herdr__${e.name}` } }))
    on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
    on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/wt/repo-b' })
    await clock.settle()
  }

  test('.omh is the main repo\'s, found through the git common dir; OMH_RUN binds the lead to its run', async ($, on) => {
    const mem = new Map<string, string>([
      ['/main/repo/.omh/current-run', 'a\n'],
      ['/main/repo/.omh/runs/a/draft.md', '# a\n'],
      ['/main/repo/.omh/runs/b/plan.json', PLAN],
    ])
    await boot($, on, mem, { OMH_RUN: 'b' })
    // Nothing is written under the worktree; the bound run's files land in the central .omh.
    expect([...mem.keys()].some(k => k.startsWith('/wt/'))).toBe(false)
    expect(JSON.parse(mem.get('/main/repo/.omh/runs/b/status.json')!)).toMatchObject({ run: 'b', goal: 'goal b' })
    // A bound session leaves the summary's top level to the main checkout's own session; it only lists itself in `runs`.
    const summary = JSON.parse(mem.get('/main/repo/.omh/status.json')!)
    expect(summary.run).toBe('')
    expect(summary.runs.map((r: { id: string }) => r.id)).toContain('b')
    expect(mem.get('/main/repo/.omh/current-run')).toBe('a\n')
  })

  test('OMH_DIR still names where .omh lives', async ($, on) => {
    const mem = new Map<string, string>([
      ['/custom/omh/current-run', 'b\n'],
      ['/custom/omh/runs/b/plan.json', PLAN],
    ])
    await boot($, on, mem, { OMH_DIR: '/custom/omh' })
    expect(JSON.parse(mem.get('/custom/omh/status.json')!).run).toBe('b')
    expect([...mem.keys()].some(k => k.startsWith('/main/'))).toBe(false)
  })
})
