// Drafting, approving and saving a plan, end to end through the mod: each piece of work gets its
// own run directory when it is first drafted, so a new plan never lands in an old run, and a
// rejected plan does not use up the approval. The disk is in memory.

import { describe, expect, mock, test } from 'claude-code/testing'

const AGENTS = { claude: { launch: 'herdr-kind', kind: 'claude' } }
const CONFIG = {
  profiles: { 'claude-sonnet': { agent: 'claude', family: 'claude', args: [] } },
  categories: { deep: ['claude-sonnet'], reviewer: ['claude-sonnet'] },
}

type Mem = Map<string, string>

function disk(on: any, mem: Mem) {
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
    expect(JSON.parse(mem.get('/work/.omh/status.json')!).stage).toBe('running')
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
