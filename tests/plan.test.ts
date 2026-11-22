// Drafting, approving and saving a plan, end to end through the mod: each piece of work gets its
// own run directory when it is first drafted, so a new plan never lands in an old run, and a
// rejected plan does not use up the approval. The disk is in memory.

import { describe, expect, mock, test } from 'claude-code/testing'

import { approvePlan, listRuns, writePlan } from '../hooks/lib/actions'
import { Paths, runWorkerName } from '../hooks/lib/files'
import { rt } from '../hooks/lib/runtime'

const AGENTS = { claude: { launch: 'herdr-kind', kind: 'claude' } }
const CONFIG = {
  profiles: { 'claude-sonnet': { agent: 'claude', family: 'claude', args: [] } },
  categories: { deep: ['claude-sonnet'], reviewer: ['claude-sonnet'] },
}

type Mem = Map<string, string>

function disk(on: any, mem: Mem, run?: (argv: string[]) => { value: unknown } | undefined) {
  const ASSET = /\/skills\/oh-my-herdr\/assets\/(agents|config\.default)\.json$/
  const asset = (p: string) => {
    const m = ASSET.exec(p)?.[1]
    return m === undefined ? undefined : JSON.stringify(m === 'agents' ? AGENTS : CONFIG)
  }
  const dirOf = (p: string) => [...mem.keys()].some(k => k.startsWith(`${p.replace(/\/$/, '')}/`))
  on('fs.read', (_$: any, e: any) => {
    const text = asset(e.path) ?? mem.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$: any, e: any) => {
    mem.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$: any, e: any) => ({ value: asset(e.path) !== undefined || mem.has(e.path) || dirOf(e.path) }))
  on('fs.stat', (_$: any, e: any) => {
    if (mem.has(e.path)) return { value: { kind: 'file', size: mem.get(e.path)!.length } }
    if (dirOf(e.path)) return { value: { kind: 'dir', size: 0 } }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.list', (_$: any, e: any) => {
    const dir = `${e.path.replace(/\/$/, '')}/`
    const names = new Set([...mem.keys()].filter(k => k.startsWith(dir)).map(k => k.slice(dir.length).split('/')[0]!))
    return { value: [...names].map(name => ({ name, kind: mem.has(dir + name) ? 'file' : 'dir', size: 0 })) }
  })
  on('process.run', (_$: any, e: any) => {
    const custom = run?.([...e.argv])
    if (custom !== undefined) return custom
    if (e.argv[0] === 'rm') mem.delete(e.argv[e.argv.length - 1])
    return { value: { exitCode: e.argv[0] === 'rm' ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', () => {
    throw new Error('offline')
  })
}

async function lead($: any, on: any) {
  mock.env(on, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HOME: '/home/u' })
  // 2026-11-17, local time: run ids start with 20261117.
  const clock = mock.clock(on, { now: new Date(2026, 10, 17, 20, 0).getTime() } as never)
  on('tool.register', (_$: any, e: any) => ({ value: { tool: `mcp__oh-my-herdr__${e.name}` } }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()
  return clock
}

function prompts(on: any): string[] {
  const sent: string[] = []
  on('prompt.submit', (_$: any, e: any) => {
    sent.push(e.text)
    return { text: e.text }
  })
  return sent
}

const status = async ($: any, a: Record<string, unknown>) => String(((await $.tool.call({ tool: 'mcp__oh-my-herdr__omh_status', ...a } as never)) as any).result)
const approve = async ($: any) => String(((await $.command.run({ command: 'omh', args: 'approve' } as never)) as any).text)

const PLAN = (category: string) => ({
  goal: 'Model groups',
  waves: [{ id: 1, gate: 'tests pass', tasks: [{ id: 'T1', title: 'backend', intent: 'implement', category, owns: ['a.py'], deps: [] }] }],
})

const OLD = '/work/.omh/runs/20261116-helm-values'
const NEW = '/work/.omh/runs/20261117-model-groups'

/** An earlier run, finished, still named by current-run. */
function seedOldRun(mem: Mem) {
  mem.set('/work/.omh/current-run', '20261116-helm-values\n')
  mem.set(`${OLD}/plan.md`, '# Helm values\n')
  mem.set(`${OLD}/plan.json`, JSON.stringify({ goal: 'Helm', waves: [{ id: 1, gate: 'g', tasks: [{ id: 'T1', title: 'helm', intent: 'implement', category: 'deep', owns: [], deps: [] }] }] }))
  mem.set(`${OLD}/T1/dispatch.json`, '{}')
  mem.set(`${OLD}/finished.json`, '{}') // an open legacy run would be adopted by the unbound lead (it would then hold current-run)
}

describe('planning a run', () => {
  test('a named draft starts its own run; approve renames it to plan.md and wakes the lead with its path', async ($, on) => {
    const mem: Mem = new Map()
    disk(on, mem)
    seedOldRun(mem)
    const sent = prompts(on)
    const clock = await lead($, on)

    const r = await status($, { action: 'draft', name: 'model-groups', markdown: '# Model groups\n\nT1 backend' })
    expect(r).toContain(`${NEW}/draft.md`)
    expect(mem.get('/work/.omh/current-run')).toBe('20261117-model-groups\n')
    expect(JSON.parse(mem.get('/work/.omh/status.json')!)).toMatchObject({ run: '20261117-model-groups', stage: 'draft', line: '✎ plan draft' })

    expect(await status($, { action: 'plan', plan: PLAN('deep') })).toContain('waiting for approval')

    expect(await approve($)).toContain('approved plan.md of run 20261117-model-groups')
    await clock.settle()
    expect(mem.has(`${NEW}/draft.md`)).toBe(false)
    expect(mem.get(`${NEW}/plan.md`)).toContain('# Model groups')
    expect(sent.some(t => t.includes(`${NEW}/plan.md`))).toBe(true)

    expect(await status($, { action: 'plan', plan: PLAN('deep') })).toContain('plan saved for run 20261117-model-groups')
    // The old run is untouched.
    expect(mem.get(`${OLD}/plan.md`)).toBe('# Helm values\n')
    expect(JSON.parse(mem.get(`${OLD}/plan.json`)!).goal).toBe('Helm')
    // The session is bound to the run now: its own progress is in the run's status file.
    expect(JSON.parse(mem.get(`${NEW}/status.json`)!).stage).toBe('running')
  })

  test('a rejected plan keeps the approval: fixed, it saves', async ($, on) => {
    const mem: Mem = new Map()
    disk(on, mem)
    await lead($, on)
    await status($, { action: 'draft', name: 'model-groups', markdown: '# Model groups' })
    await approve($)
    const rejected = await status($, { action: 'plan', plan: PLAN('review') })
    expect(rejected).toContain("did you mean 'reviewer'?")
    expect(rejected).toContain('the approval still stands')
    expect(await status($, { action: 'plan', plan: PLAN('reviewer') })).toContain('plan saved')
  })

  test('the first draft needs a name; a name already taken by another run is refused', async ($, on) => {
    const mem: Mem = new Map()
    disk(on, mem)
    await lead($, on)
    expect(await status($, { action: 'draft', markdown: '# x' })).toContain('needs "name"')
    await status($, { action: 'draft', name: 'one', markdown: '# one' })
    await status($, { action: 'draft', name: 'two', markdown: '# two' })
    expect(await status($, { action: 'draft', name: 'one', markdown: '# one again' })).toContain('already exists')
  })

  test('a draft without a name revises the current run; approving keeps the old plan as plan.v1.md', async ($, on) => {
    const mem: Mem = new Map()
    disk(on, mem)
    await lead($, on)
    await status($, { action: 'draft', name: 'model-groups', markdown: '# v1' })
    await approve($)
    await status($, { action: 'plan', plan: PLAN('deep') })

    await status($, { action: 'draft', markdown: '# v2' })
    expect(mem.get('/work/.omh/current-run')).toBe('20261117-model-groups\n')
    expect(mem.get(`${NEW}/draft.md`)).toBe('# v2\n')
    // Until the revision is approved, the waves stay as they are.
    expect(await status($, { action: 'plan', plan: PLAN('deep') })).toContain('waiting for approval')
    await approve($)
    expect(mem.get(`${NEW}/plan.v1.md`)).toBe('# v1\n')
    expect(mem.get(`${NEW}/plan.md`)).toBe('# v2\n')
    expect(await status($, { action: 'plan', plan: PLAN('deep') })).toContain('plan saved')
  })

  test('plan.md edited by hand after approval needs approving again', async ($, on) => {
    const mem: Mem = new Map()
    disk(on, mem)
    await lead($, on)
    await status($, { action: 'draft', name: 'model-groups', markdown: '# v1' })
    await approve($)
    mem.set(`${NEW}/plan.md`, '# v1, edited\n')
    expect(await status($, { action: 'plan', plan: PLAN('deep') })).toContain('changed after it was approved')
    expect(await approve($)).toContain('approved')
    expect(await status($, { action: 'plan', plan: PLAN('deep') })).toContain('plan saved')
  })
})

// ------------------------------------------------------------------ several runs at once

describe('several runs', () => {
  const cell = <T,>(init: T) => {
    let v = init
    return { get: async () => v, set: async (fn: (old: T) => T) => (v = fn(v)) }
  }

  /** A session facade over an in-memory disk: what approvePlan, listRuns and the run view touch. */
  function fakeHost(mem: Mem) {
    const dirOf = (p: string) => [...mem.keys()].some(k => k.startsWith(`${p.replace(/\/$/, '')}/`))
    return {
      fs: {
        read: async (path: string) => {
          const t = mem.get(path)
          if (t === undefined) throw new Error(`ENOENT ${path}`)
          return t
        },
        write: async (path: string, text: string) => void mem.set(path, text),
        exists: async (path: string) => mem.has(path) || dirOf(path),
        stat: async (path: string) => ({ kind: mem.has(path) ? 'file' : 'dir', size: mem.get(path)?.length ?? 0 }),
        list: async (path: string) => {
          const dir = `${path.replace(/\/$/, '')}/`
          const names = new Set([...mem.keys()].filter(k => k.startsWith(dir)).map(k => k.slice(dir.length).split('/')[0]!))
          return [...names].map(name => ({ name, kind: mem.has(dir + name) ? 'file' : 'dir', size: 0 }))
        },
      },
      process: { run: async (argv: string[]) => (argv[0] === 'rm' ? (mem.delete(argv[argv.length - 1]!), { exitCode: 0, stdout: '', stderr: '' }) : { exitCode: 1, stdout: '', stderr: '' }) },
      clock: { now: async () => Date.UTC(2026, 10, 21), after: () => ({ cancel() {} }), every: () => ({ cancel() {} }) },
      state: { run: cell<unknown>(null), workers: cell<Record<string, unknown>>({}), bound: cell<unknown>(null) },
    }
  }

  const A = '20261121-alpha'
  const B = '20261121-beta'
  const ROOT = '/main/.omh'

  async function session(mem: Mem, bound: string | null = null) {
    const saved = { $: rt.$, paths: rt.paths, cfg: rt.cfg }
    rt.$ = fakeHost(mem) as never
    rt.cfg = null
    rt.paths = new Paths(bound === null ? '/main' : '/wt/b', ROOT, bound)
    return () => Object.assign(rt, saved)
  }

  const seed = (mem: Mem) => {
    mem.set(`${ROOT}/current-run`, `${A}\n`)
    mem.set(`${ROOT}/runs/${A}/draft.md`, '# Alpha work\n\nT1\n')
    mem.set(`${ROOT}/runs/${B}/draft.md`, '# Beta work\n\nT1\n')
  }

  test('two drafts coexist; approving b by id leaves a a draft', async () => {
    const mem: Mem = new Map()
    seed(mem)
    const restore = await session(mem)
    try {
      const r = await approvePlan('beta')
      expect(r).toMatchObject({ ok: true, run: B, file: `${ROOT}/runs/${B}/plan.md` })
      expect(mem.get(`${ROOT}/runs/${B}/plan.md`)).toContain('# Beta work')
      expect(mem.has(`${ROOT}/runs/${B}/draft.md`)).toBe(false)
      expect(mem.has(`${ROOT}/runs/${B}/plan.approved`)).toBe(true)
      // a is untouched, still a draft, still current
      expect(mem.get(`${ROOT}/runs/${A}/draft.md`)).toContain('# Alpha work')
      expect(mem.has(`${ROOT}/runs/${A}/plan.md`)).toBe(false)
      expect(mem.get(`${ROOT}/current-run`)).toBe(`${A}\n`)
    } finally {
      restore()
    }
  })

  test('approve with no id approves this session\'s run; an unknown id lists the drafts', async () => {
    const mem: Mem = new Map()
    seed(mem)
    const restore = await session(mem)
    try {
      const bad = await approvePlan('gamma')
      expect(bad.ok).toBe(false)
      expect(bad.text).toContain(A)
      expect(bad.text).toContain(B)
      const r = await approvePlan()
      expect(r).toMatchObject({ ok: true, run: A })
      expect(mem.get(`${ROOT}/runs/${A}/plan.md`)).toContain('# Alpha work')
      expect(mem.get(`${ROOT}/runs/${B}/draft.md`)).toContain('# Beta work')
    } finally {
      restore()
    }
  })

  test('listRuns shows both runs, their states, goals and whose they are', async () => {
    const mem: Mem = new Map()
    seed(mem)
    const plan = { goal: 'g', waves: [{ id: 1, gate: 'g', tasks: [{ id: 'T1', title: 't', intent: 'implement', category: 'deep', owns: [], deps: [] }] }] }
    const C = '20261120-gamma'
    mem.set(`${ROOT}/runs/${C}/plan.md`, '# Gamma work\n')
    mem.set(`${ROOT}/runs/${C}/plan.json`, JSON.stringify(plan))
    mem.set(`${ROOT}/runs/${C}/gates.json`, JSON.stringify({ passed: [1] }))
    const D = '20261119-delta'
    mem.set(`${ROOT}/runs/${D}/plan.md`, '# Delta work\n')
    mem.set(`${ROOT}/runs/${D}/plan.json`, JSON.stringify(plan))
    mem.set(`${ROOT}/runs/${D}/closed.json`, '{}')
    mem.set(`${ROOT}/runs/_scout/x/brief.md`, 'scout')
    const restore = await session(mem)
    try {
      await approvePlan(B)
      const t = (await listRuns()).text
      const row = (id: string) => t.split('\n').find(l => l.includes(id))!
      expect(row(A)).toContain('draft')
      expect(row(A)).toContain('Alpha work')
      expect(row(A)).toContain('this session')
      expect(row(B)).toContain('approved')
      expect(row(C)).toContain('finished')
      expect(row(C)).toContain('1/1')
      expect(row(D)).toContain('closed')
      expect(t).not.toContain('_scout')
    } finally {
      restore()
    }
  })

  test('a bound session names its workers with the run tag (unbound naming is covered by tests/hc.test.ts)', async ($, on) => {
    const bound = new Map<string, string>()
    const started: string[] = []
    disk(on, bound, argv => {
      const reply = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
      if (argv[0] === 'hc' && argv[1] === 'run') {
        started.push(argv[argv.indexOf('--name') + 1]!)
        return reply('{"address":"t9"}')
      }
      if (argv[0] === 'sh') return reply('idle\n')
      if (argv[0] === 'hc' && argv[1] === 'send') return reply('{"started":true}')
      return undefined
    })
    ;(on as any)('process.spawn', async function* () {
      yield { stream: 'stdout', text: `${JSON.stringify({ name: 'w', status: 'idle', ts: 1 })}\n` }
      await new Promise(() => undefined)
      return { code: 0, signal: null }
    })
    mock.env(on, { HOME: '/home/u', HC_TERMINAL_ID: 't1', OMH_RUN: 'b' })
    const clock = mock.clock(on)
    on('tool.register', (_$: any, e: any) => ({ value: { tool: `mcp__oh-my-herdr__${e.name}` } }))
    on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
    on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await clock.settle()
    const r = String(((await $.tool.call({ tool: 'mcp__oh-my-herdr__omh_dispatch', task: 'scout-auth', intent: 'explore', rationale: 'look-up', brief: 'Find it.', category: 'deep' } as never)) as any).result)
    expect(r).not.toContain('ERROR')
    const tagged = runWorkerName('b', 'scout-auth')
    expect(tagged).not.toBe('scout-auth')
    expect(bound.has(`/work/.omh/agents/${tagged}.json`)).toBe(true)
    expect(bound.has('/work/.omh/agents/scout-auth.json')).toBe(false)
    expect(started.some(n => n.endsWith(tagged))).toBe(true)
  })
})
