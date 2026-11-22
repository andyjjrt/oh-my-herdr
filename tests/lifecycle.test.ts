// The multi-run lifecycle through the mod: approve (it binds the session to its run), finish, close, the
// approvals drop file, the events log, several sessions sharing one .omh; plus recheck's holder and stale
// wake-ups. The disk is in memory and every process (git, mv, rm, hc) is answered by a table.

import { describe, expect, mock, test } from 'claude-code/testing'

import { diagnose } from '../hooks/lib/diagnose'
import { ownsWorker, Paths, runTag, runWorkerName } from '../hooks/lib/files'
import { draftDigest } from '../hooks/lib/plan'
import { closeRun, closeTask, dispatch, draftPlan, approveRun, finishRun, pollApprovals, spawn, status, teardown, writePlan } from '../hooks/lib/actions'
import { currentRun, liveWorkersAll, openRun, optionsOf, paths, queueWake, reconcile, rt } from '../hooks/lib/runtime'

const AGENTS = { claude: { launch: 'herdr-kind', kind: 'claude', bin: 'claude' } }
const CONFIG = {
  profiles: { 'claude-sonnet': { agent: 'claude', family: 'claude', args: [] } },
  categories: { deep: ['claude-sonnet'], explore: ['claude-sonnet'] },
}

type Mem = Map<string, string>
type Run = { exitCode: number; stdout: string }

const RUN = '20261121-feat'
const WT = '/work.worktrees/feat' // a worktree the user made

/** The disk, and the processes: `calls` records every argv, `git` answers by its tail. */
function world(on: any, mem: Mem, opts: { hc?: (argv: string[]) => Run | undefined; lists?: string[] } = {}) {
  const ASSET = /\/skills\/oh-my-herdr\/assets\/(agents|config\.default)\.json$/
  const asset = (p: string) => {
    const m = ASSET.exec(p)?.[1]
    return m === undefined ? undefined : JSON.stringify(m === 'agents' ? AGENTS : CONFIG)
  }
  const dirOf = (p: string) => [...mem.keys()].some(k => k.startsWith(`${p.replace(/\/$/, '')}/`))
  on('fs.read', (_$: any, e: any) => {
    const t = asset(e.path) ?? mem.get(e.path)
    if (t === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: t }
  })
  on('fs.write', (_$: any, e: any) => (mem.set(e.path, e.text), { value: undefined }))
  on('fs.exists', (_$: any, e: any) => ({ value: asset(e.path) !== undefined || mem.has(e.path) || dirOf(e.path) }))
  on('fs.stat', (_$: any, e: any) => {
    if (mem.has(e.path)) return { value: { kind: 'file', size: mem.get(e.path)!.length } }
    if (dirOf(e.path)) return { value: { kind: 'dir', size: 0 } }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.list', (_$: any, e: any) => {
    opts.lists?.push(e.path.replace(/\/$/, ''))
    const dir = `${e.path.replace(/\/$/, '')}/`
    const names = new Set([...mem.keys()].filter(k => k.startsWith(dir)).map(k => k.slice(dir.length).split('/')[0]!))
    return { value: [...names].map(name => ({ name, kind: mem.has(dir + name) ? 'file' : 'dir', size: 0 })) }
  })
  on('http.fetch', () => {
    throw new Error('offline')
  })
  const calls: string[][] = []
  on('process.run', (_$: any, e: any) => {
    const argv = [...e.argv] as string[]
    calls.push(argv)
    const out = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'rm') return (mem.delete(argv[argv.length - 1]!), out())
    if (argv[0] === 'mv') {
      const from = argv[1]!
      if (!mem.has(from)) return out('', 1)
      mem.set(argv[2]!, mem.get(from)!)
      mem.delete(from)
      return out()
    }
    if (argv[0] === 'sh' && String(argv[2] ?? '').includes('cat >>')) {
      const path = argv[5]!
      mem.set(path, (mem.get(path) ?? '') + String(e.init?.stdin ?? ''))
      return out()
    }
    if (argv[0] === 'git') {
      const tail = argv.slice(argv[1] === '-C' ? 3 : 1).join(' ')
      if (tail.startsWith('rev-parse --verify --quiet')) return out('', 1)
      if (tail.startsWith('rev-parse --verify HEAD')) return out('abc1234567890\n')
      return out('', 1)
    }
    if (argv[0] === 'sh' && argv[1] === '-c' && opts.hc) return opts.hc(argv) ? out(opts.hc(argv)!.stdout, opts.hc(argv)!.exitCode) : out()
    const r = opts.hc?.(argv)
    return r ? out(r.stdout, r.exitCode) : out('', 1)
  })
  return calls
}

async function lead($: any, on: any, env: Record<string, string> = {}, cwd = '/work') {
  mock.env(on, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HOME: '/home/u', ...env })
  const clock = mock.clock(on, { now: new Date(2026, 10, 21, 20, 0).getTime() } as never)
  on('tool.register', (_$: any, e: any) => ({ value: { tool: `mcp__oh-my-herdr__${e.name}` } }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd })
  await clock.settle()
  return clock
}

function prompts(on: any): string[] {
  const sent: string[] = []
  on('prompt.submit', (_$: any, e: any) => (sent.push(e.text), { text: e.text }))
  return sent
}

const tool = async ($: any, a: Record<string, unknown>, name = 'omh_status') => String(((await $.tool.call({ tool: `mcp__oh-my-herdr__${name}`, ...a } as never)) as any).result)
const omh = async ($: any, args: string) => String(((await $.command.run({ command: 'omh', args } as never)) as any).text)

const PLAN = { goal: 'Feature', waves: [{ id: 1, gate: 'tests pass', tasks: [{ id: 'T1', title: 'do', intent: 'implement', category: 'deep', owns: ['a.ts'], deps: [] }] }] }
const fresh = (): Mem => new Map()

const events = (mem: Mem) => (mem.get('/work/.omh/events.jsonl') ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as { event: string; run: string | null; session: string })

const OMH_DIR = '/work/.omh'
const leadJson = (mem: Mem, run = RUN) => JSON.parse(mem.get(`${OMH_DIR}/runs/${run}/lead.json`)!) as { pane: string | null; root: string }

describe('approve binds this session to the run', () => {
  test('unbound, no id: approves current-run, binds, writes lead.json {pane, root}, wakes the lead', async ($, on) => {
    const mem = fresh()
    const calls = world(on, mem)
    const sent = prompts(on)
    const clock = await lead($, on)
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    const text = await omh($, 'approve')
    await clock.settle()
    expect(text).toContain(`approved plan.md of run ${RUN}`)
    expect(text).toContain('this session now leads')
    expect(leadJson(mem)).toEqual({ pane: 'w1:p1', root: '/work' })
    expect(sent.some(t => t.includes('plan.md approved (/omh approve)') && t.includes('Derive the waves'))).toBe(true)
    expect(calls.some(c => c.includes('worktree'))).toBe(false)
    expect(mem.has(`${OMH_DIR}/runs/${RUN}/mode.json`)).toBe(false)
    expect(events(mem).map(e => e.event)).toEqual(['draft', 'approved', 'bound'])
  })

  test('unbound, with an id: approves that run and binds to it, wherever current-run points', async ($, on) => {
    const mem = fresh()
    world(on, mem)
    const sent = prompts(on)
    const clock = await lead($, on)
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    mem.set(`${OMH_DIR}/runs/20261121-two/draft.md`, '# Two\n')
    const text = await omh($, 'approve two')
    await clock.settle()
    expect(text).toContain('approved plan.md of run 20261121-two')
    expect(mem.get(`${OMH_DIR}/runs/20261121-two/plan.md`)).toContain('# Two')
    expect(leadJson(mem, '20261121-two')).toEqual({ pane: 'w1:p1', root: '/work' })
    expect(mem.has(`${OMH_DIR}/runs/${RUN}/lead.json`)).toBe(false)
    expect(mem.get(`${OMH_DIR}/current-run`)).toBe(`${RUN}\n`) // the shared pointer is left alone
    expect(mem.get(`${OMH_DIR}/runs/${RUN}/draft.md`)).toContain('# Feature') // the other draft is untouched
    expect(sent.some(t => t.includes('20261121-two'))).toBe(true)
    // It is this session's run now, whatever current-run says.
    mem.set(`${OMH_DIR}/current-run`, `${RUN}\n`)
    expect(await omh($, 'runs')).toMatch(/20261121-two.*this session, bound/)
  })

  test('bound: no id (or its own id) approves its run again and keeps the binding', async ($, on) => {
    const mem = fresh()
    world(on, mem)
    const sent = prompts(on)
    const clock = await lead($, on)
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    await omh($, 'approve')
    await clock.settle()
    sent.length = 0
    mem.set(`${OMH_DIR}/runs/${RUN}/plan.md`, '# Feature, edited by hand\n')
    expect(await omh($, 'approve')).toContain(`approved plan.md of run ${RUN}`)
    expect(await omh($, `approve ${RUN}`)).toContain(`approved plan.md of run ${RUN}`)
    await clock.settle()
    expect(sent.filter(t => t.includes('approved again'))).toHaveLength(2)
    expect(events(mem).filter(e => e.event === 'bound')).toHaveLength(1)
    expect(await omh($, 'runs')).toMatch(/feat.*this session, bound/)
  })

  test('bound: approve <other> is refused while its run is neither finished nor closed; allowed once finished, or closed', async ($, on) => {
    const mem = fresh()
    world(on, mem)
    prompts(on)
    const clock = await lead($, on)
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    await omh($, 'approve')
    await clock.settle()
    await tool($, { action: 'plan', plan: PLAN })
    mem.set(`${OMH_DIR}/runs/20261121-two/draft.md`, '# Two\n')
    mem.set(`${OMH_DIR}/runs/20261121-three/draft.md`, '# Three\n')
    const r = await omh($, 'approve two')
    expect(r).toContain(`bound to run ${RUN}`)
    expect(r).toContain('finish')
    expect(r).toContain('another Claude')
    expect(mem.has(`${OMH_DIR}/runs/20261121-two/plan.md`)).toBe(false)
    expect(mem.get(`${OMH_DIR}/runs/20261121-two/draft.md`)).toBe('# Two\n')
    // Finished (not yet closed): it rebinds.
    mem.set(`${OMH_DIR}/runs/${RUN}/gates.json`, JSON.stringify({ passed: [1] }))
    await tool($, { action: 'finish' })
    expect(await omh($, 'approve two')).toContain('this session now leads 20261121-two')
    expect(leadJson(mem, '20261121-two').root).toBe('/work')
    // Bound to two, which is neither finished nor closed: three is refused; once two is closed it works.
    expect(await omh($, 'approve three')).toContain('bound to run 20261121-two')
    expect(await omh($, 'close two force')).toContain('closed')
    expect(await omh($, 'approve three')).toContain('this session now leads 20261121-three')
  })

  test('a bound session drafts another name: the draft is written, the binding and current-run stay, the reply says how to approve it', async ($, on) => {
    const mem = fresh()
    world(on, mem)
    prompts(on)
    const clock = await lead($, on)
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    await omh($, 'approve')
    await clock.settle()
    await tool($, { action: 'plan', plan: PLAN })
    const d = await tool($, { action: 'draft', name: 'next', markdown: '# Next' })
    expect(d).toContain('draft written for run 20261121-next')
    expect(d).toContain(`stays bound to ${RUN}`)
    expect(d).toContain('/omh approve 20261121-next')
    expect(d).toContain('END YOUR TURN')
    expect(mem.get(`${OMH_DIR}/runs/20261121-next/draft.md`)).toContain('# Next')
    expect(mem.get(`${OMH_DIR}/current-run`)).toBe(`${RUN}\n`)
    // Still its own run: a draft without a name revises it, and dispatch goes to it.
    expect(await tool($, { action: 'draft', markdown: '# Feature v2' })).toContain(`draft written for run ${RUN}`)
    expect(mem.get(`${OMH_DIR}/current-run`)).toBe(`${RUN}\n`)
    expect(await omh($, 'runs')).toMatch(/feat.*this session, bound/)
  })

  test('a closed run is never this session\'s run: after /omh close, approve <new id> binds to it', async ($, on) => {
    const mem = fresh()
    world(on, mem)
    prompts(on)
    const clock = await lead($, on)
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    await omh($, 'approve')
    await clock.settle()
    await tool($, { action: 'plan', plan: PLAN })
    mem.set(`${OMH_DIR}/runs/20261121-two/draft.md`, '# Two\n')
    mem.set(`${OMH_DIR}/runs/${RUN}/gates.json`, JSON.stringify({ passed: [1] }))
    await tool($, { action: 'finish' })
    expect(await omh($, 'close')).toContain(`run ${RUN} closed`)
    // current-run still names the closed run: it is nobody's.
    expect(mem.get(`${OMH_DIR}/current-run`)).toBe(`${RUN}\n`)
    expect(await omh($, 'runs')).not.toMatch(/feat.*this session/)
    const r = await omh($, 'approve two')
    expect(r).not.toContain('another run')
    expect(r).toContain('this session now leads 20261121-two')
    expect(leadJson(mem, '20261121-two').pane).toBe('w1:p1')
    // A closed run cannot be approved again, and no id with only a closed current-run has nothing to approve.
    expect(await omh($, `approve ${RUN}`)).toContain('is closed')
    await omh($, 'close two force')
    expect(await omh($, 'approve')).toContain('no plan to approve')
  })

  test('close unbinds; after a reload the session stays unbound, even with OMH_RUN naming an open run', async ($, on) => {
    const mem = fresh()
    world(on, mem)
    prompts(on)
    const clock = await lead($, on, { OMH_RUN: RUN })
    mem.set(`${OMH_DIR}/runs/${RUN}/plan.json`, JSON.stringify(PLAN))
    mem.set(`${OMH_DIR}/runs/${RUN}/gates.json`, JSON.stringify({ passed: [1] }))
    expect(await tool($, { action: 'draft', name: 'x', markdown: '# X' })).toContain('stays bound')
    await tool($, { action: 'finish' })
    expect(await omh($, 'close')).toContain('closed')
    expect(events(mem).map(e => e.event)).toContain('unbound')
    // Unbound now: a named draft moves current-run again.
    expect(await tool($, { action: 'draft', name: 'next', markdown: '# next' })).not.toContain('stays bound')
    expect(mem.get(`${OMH_DIR}/current-run`)).toBe('20261121-next\n')
    // Reload (a new session.start in the same engine keeps $.state): still unbound.
    mem.delete(`${OMH_DIR}/runs/${RUN}/closed.json`) // even though its run is open again
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await clock.settle()
    expect(await omh($, 'runs')).not.toMatch(/this session, bound/)
    expect(await tool($, { action: 'draft', name: 'after', markdown: '# after' })).not.toContain('stays bound')
  })

  test('a binding survives a reload; one whose run was closed meanwhile (from another session) does not', async ($, on) => {
    const mem = fresh()
    world(on, mem)
    prompts(on)
    const clock = await lead($, on)
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    await omh($, 'approve')
    await clock.settle()
    const start = async () => {
      await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
      await clock.settle()
    }
    await start()
    expect(await tool($, { action: 'draft', name: 'one', markdown: '# one' })).toContain(`stays bound to ${RUN}`)
    mem.set(`${OMH_DIR}/runs/${RUN}/closed.json`, '{}')
    await start()
    expect(await tool($, { action: 'draft', name: 'two', markdown: '# two' })).not.toContain('stays bound')
  })

  test('lead.json records the session\'s own root: a worktree the user made', async ($, on) => {
    const mem = fresh()
    world(on, mem, { hc: herdrAnswers() })
    prompts(on)
    const clock = await lead($, on, { OMH_DIR }, WT)
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    await omh($, 'approve')
    await clock.settle()
    expect(leadJson(mem)).toEqual({ pane: 'w1:p1', root: WT })
    expect(await omh($, 'runs')).toContain(WT)
    await tool($, { action: 'plan', plan: PLAN })
    await tool($, { task: 'T1', intent: 'implement', rationale: 'x', brief: 'do it' }, 'omh_dispatch')
    const w = [...mem.entries()].find(([k]) => k.startsWith(`${OMH_DIR}/agents/`))!
    expect(JSON.parse(w[1])).toMatchObject({ cwd: WT, run: RUN, lead: 'w1:p1' })
  })

  test('/omh runs shows the lead and root per run; a closed run shows none', async ($, on) => {
    const mem = fresh()
    mem.set(`${OMH_DIR}/runs/20261121-a/draft.md`, '# A\n')
    mem.set(`${OMH_DIR}/runs/20261121-b/plan.md`, '# B\n')
    mem.set(`${OMH_DIR}/runs/20261121-b/lead.json`, JSON.stringify({ pane: 'w7:p7', root: '/elsewhere' }))
    mem.set(`${OMH_DIR}/runs/20261121-c/plan.md`, '# C\n')
    mem.set(`${OMH_DIR}/runs/20261121-c/lead.json`, JSON.stringify({ pane: 'w8:p8', root: '/gone' }))
    mem.set(`${OMH_DIR}/runs/20261121-c/closed.json`, '{}')
    world(on, mem)
    prompts(on)
    await lead($, on)
    const t = await omh($, 'runs')
    expect(t).toContain('| lead')
    expect(t).toMatch(/20261121-b.*w7:p7.*\/elsewhere/)
    expect(t).not.toContain('/gone')
  })
})

describe('finish and close', () => {
  async function bound($: any, on: any, mem: Mem) {
    const calls = world(on, mem)
    const sent = prompts(on)
    const clock = await lead($, on)
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    await omh($, `approve ${RUN}`)
    await clock.settle()
    await tool($, { action: 'plan', plan: PLAN })
    return { calls, sent, clock }
  }

  test('finish refuses with an open gate, then records finished.json', async ($, on) => {
    const mem = fresh()
    await bound($, on, mem)
    expect(await tool($, { action: 'finish' })).toContain('no passed gate')
    mem.set(`${OMH_DIR}/runs/${RUN}/gates.json`, JSON.stringify({ passed: [1] }))
    expect(await tool($, { action: 'finish' })).toContain('finished')
    expect(JSON.parse(mem.get(`${OMH_DIR}/runs/${RUN}/finished.json`)!)).toHaveProperty('at')
  })

  test('close needs finish (or force), unbinds, writes closed.json and touches no git', async ($, on) => {
    const mem = fresh()
    const { calls } = await bound($, on, mem)
    expect(await omh($, 'close')).toContain('not finished')
    mem.set(`${OMH_DIR}/runs/${RUN}/gates.json`, JSON.stringify({ passed: [1] }))
    await tool($, { action: 'finish' })
    const text = await omh($, 'close')
    expect(text).toContain(`run ${RUN} closed`)
    expect(text).not.toContain('worktree')
    expect(text).not.toContain('git ')
    expect(calls.some(c => c[0] === 'git')).toBe(true) // boot reads the toplevel only
    expect(calls.filter(c => c[0] === 'git').every(c => c.includes('rev-parse'))).toBe(true)
    expect(JSON.parse(mem.get(`${OMH_DIR}/runs/${RUN}/closed.json`)!)).toMatchObject({ forced: false })
    expect(await tool($, { action: 'draft', name: 'next', markdown: '# next' })).toContain('draft written for run 20261121-next')
    expect(mem.get(`${OMH_DIR}/current-run`)).toBe('20261121-next\n')
    expect(events(mem).map(e => e.event)).toEqual(expect.arrayContaining(['draft', 'approved', 'bound', 'finished', 'closed', 'unbound']))
  })

  test('close force tears the run\'s workers down even when it is not finished', async ($, on) => {
    const mem = fresh()
    mem.set(`${OMH_DIR}/agents/rtag-w.json`, wf('rtag-w', { run: RUN, lead: 'w1:p1' }))
    await bound($, on, mem)
    expect(await omh($, `close ${RUN}`)).toContain('not finished')
    expect(await omh($, `close ${RUN} force`)).toContain('closed')
    expect(JSON.parse(mem.get(`${OMH_DIR}/runs/${RUN}/closed.json`)!)).toMatchObject({ forced: true })
    expect(mem.has(`${OMH_DIR}/agents/rtag-w.json`)).toBe(false)
  })
})

describe('approvals drop file', () => {
  test('a good digest approves the run and deletes the file; a bad one is renamed .rejected', async ($, on) => {
    const mem: Mem = fresh()
    world(on, mem)
    const sent = prompts(on)
    const clock = await lead($, on)
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    mem.set(`${OMH_DIR}/runs/20261121-bad/draft.md`, '# Bad\n')
    mem.set(`${OMH_DIR}/approvals/20261121-bad`, 'deadbeef\n')
    mem.set(`${OMH_DIR}/approvals/${RUN}`, `${draftDigest('# Feature')}\n`)
    await clock.advance(8_000)
    await clock.settle()
    expect(mem.get(`${OMH_DIR}/runs/${RUN}/plan.md`)).toContain('# Feature')
    expect(mem.has(`${OMH_DIR}/approvals/${RUN}`)).toBe(false)
    expect([...mem.keys()].some(k => k.includes('.claimed-'))).toBe(false)
    expect(mem.has(`${OMH_DIR}/approvals/20261121-bad.rejected`)).toBe(true)
    expect(mem.has(`${OMH_DIR}/approvals/20261121-bad`)).toBe(false)
    expect(mem.has(`${OMH_DIR}/runs/20261121-bad/plan.md`)).toBe(false)
    // The drafting session's own run: approved, bound and woken. A run nobody drafts stays unbound.
    expect(leadJson(mem)).toEqual({ pane: 'w1:p1', root: '/work' })
    expect(sent.some(t => t.includes('plan.md approved (/omh approve)') && t.includes(RUN))).toBe(true)
  })

  test('a run nobody is bound to is approved without binding; the session that later runs approve <id> binds', async ($, on) => {
    const mem: Mem = fresh()
    world(on, mem)
    const sent = prompts(on)
    const clock = await lead($, on)
    mem.set(`${OMH_DIR}/runs/20261121-b/draft.md`, '# B\n')
    mem.set(`${OMH_DIR}/approvals/20261121-b`, `${draftDigest('# B')}\n`)
    await clock.advance(8_000)
    expect(mem.get(`${OMH_DIR}/runs/20261121-b/plan.md`)).toContain('# B')
    expect(mem.has(`${OMH_DIR}/approvals/20261121-b`)).toBe(false)
    expect(mem.has(`${OMH_DIR}/runs/20261121-b/lead.json`)).toBe(false)
    expect(sent).toEqual([])
    expect(events(mem).find(e => e.event === 'approved')).toMatchObject({ run: '20261121-b', drop: true })
    expect(events(mem).some(e => e.event === 'bound')).toBe(false)
    expect(await omh($, 'approve b')).toContain('this session now leads 20261121-b')
    expect(leadJson(mem, '20261121-b').pane).toBe('w1:p1')
  })

  test('a run whose lead is gone (dead pane, or closed lead.json) counts as nobody\'s', async ($, on) => {
    const mem: Mem = fresh()
    mem.set(`${OMH_DIR}/runs/20261121-b/draft.md`, '# B\n')
    mem.set(`${OMH_DIR}/runs/20261121-b/lead.json`, JSON.stringify({ pane: 'w7:p7', root: '/x' }))
    mem.set(`${OMH_DIR}/approvals/20261121-b`, `${draftDigest('# B')}\n`)
    world(on, mem, { hc: herdrAnswers(['w7:p7']) })
    prompts(on)
    const clock = await lead($, on)
    await clock.advance(8_000)
    expect(mem.has(`${OMH_DIR}/runs/20261121-b/plan.md`)).toBe(true)
  })

  test('a bound session\'s poller approves a run nobody leads without rebinding', async ($, on) => {
    const mem: Mem = fresh()
    world(on, mem)
    const sent = prompts(on)
    const clock = await lead($, on)
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    await omh($, 'approve')
    await clock.settle()
    sent.length = 0
    mem.set(`${OMH_DIR}/runs/20261121-b/draft.md`, '# B\n')
    mem.set(`${OMH_DIR}/approvals/20261121-b`, `${draftDigest('# B')}\n`)
    await clock.advance(8_000)
    expect(mem.get(`${OMH_DIR}/runs/20261121-b/plan.md`)).toContain('# B')
    expect(mem.has(`${OMH_DIR}/runs/20261121-b/lead.json`)).toBe(false)
    expect(sent).toEqual([])
    expect(await omh($, 'runs')).toMatch(/feat.*this session, bound/)
  })

  test('the same file for the run this session is bound to: re-approved, the lead woken', async ($, on) => {
    const mem: Mem = fresh()
    world(on, mem)
    const sent = prompts(on)
    const clock = await lead($, on)
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    await omh($, 'approve')
    await clock.settle()
    sent.length = 0
    mem.set(`${OMH_DIR}/runs/${RUN}/draft.md`, '# Feature v2\n')
    mem.set(`${OMH_DIR}/approvals/${RUN}`, `${draftDigest('# Feature v2')}\n`)
    await clock.advance(8_000)
    expect(mem.get(`${OMH_DIR}/runs/${RUN}/plan.md`)).toContain('# Feature v2')
    expect(sent.some(t => t.includes('approved again'))).toBe(true)
  })
})

describe('events', () => {
  test('draft, approved and bound lines carry at, run, event and session', async ($, on) => {
    const mem: Mem = fresh()
    world(on, mem)
    prompts(on)
    const clock = await lead($, on, { HC_TERMINAL_ID: 't1' })
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    await omh($, 'approve')
    await clock.settle()
    const lines = (mem.get(`${OMH_DIR}/events.jsonl`) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
    expect(lines.map((l: { event: string }) => l.event)).toEqual(['draft', 'approved', 'bound'])
    // m6: the session tag is leadId() (the pane first), the same value as lead.json's pane
    expect(lines[0]).toMatchObject({ run: RUN, session: 'w1:p1' })
    expect(leadJson(mem).pane).toBe(lines[0].session)
    expect(typeof lines[0].at).toBe('string')
  })
})


describe('bugs found in this run', () => {
  test('recheck uses the worker the dispatch names now, not an older one that once held the task', async ($, on) => {
    const worker = (name: string, pane: string) => JSON.stringify({ name, category: 'deep', profile: 'claude-sonnet', family: 'claude', agent: 'claude', pane, cwd: '/work', run: RUN, task: 'T1', task_dir: `/work/.omh/runs/${RUN}/T1`, lead: 'w1:p1' })
    const mem: Mem = new Map([
      ['/work/.omh/current-run', `${RUN}\n`],
      [`/work/.omh/runs/${RUN}/plan.json`, JSON.stringify(PLAN)],
      [`/work/.omh/runs/${RUN}/T1/dispatch.json`, JSON.stringify({ task: 'T1', worker: 'w1-r1-2', profile: 'claude-sonnet', family: 'claude', intent: 'implement', category: 'deep', outcome: null })],
      ['/work/.omh/agents/w1-r1.json', worker('w1-r1', 'hc:t5')],
      ['/work/.omh/agents/w1-r1-2.json', worker('w1-r1-2', 'hc:t6')],
    ])
    world(on, mem, {
      hc: argv => {
        if (argv[0] === 'hc' && argv[1] === 'get') return { exitCode: 0, stdout: JSON.stringify({ address: argv.at(-1), state: 'live', status: { state: 'working' } }) }
        return undefined
      },
    })
    prompts(on)
    await lead($, on, { HC_TERMINAL_ID: 't1' })
    const r = await tool($, { action: 'recheck', task: 'T1' })
    expect(r).toContain('T1 → w1-r1-2')
  })

  test('a queued wake-up whose worker no longer holds the task is dropped; a settle table is rebuilt when sent', async () => {
    const sent: string[] = []
    const timers: (() => void)[] = []
    let wake = { sections: [] as string[], settleKey: '' }
    const saved = { $: rt.$, options: rt.options, timer: rt.wakeTimer }
    rt.$ = {
      state: { wake: { get: async () => wake, set: async (fn: (o: typeof wake) => typeof wake) => (wake = fn(wake)) } },
      prompt: { submit: async ({ text }: { text: string }) => void sent.push(text) },
      clock: { after: (_ms: number, fn: () => void) => (timers.push(fn), { cancel() {} }) },
      ui: { log() {} },
    } as never
    rt.options = optionsOf({})
    rt.wakeTimer = null
    try {
      let holds = true
      await queueWake('ALERT old worker', async () => (holds ? 'ALERT still holds' : null))
      await queueWake('SETTLE old', async () => 'SETTLE rebuilt')
      holds = false
      timers.shift()!()
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(sent).toEqual(['SETTLE rebuilt'])
      // Nothing left to say: nothing is sent.
      rt.wakeTimer = null
      await queueWake('ALERT gone', async () => null)
      timers.shift()!()
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(sent).toEqual(['SETTLE rebuilt'])
    } finally {
      Object.assign(rt, { $: saved.$, options: saved.options, wakeTimer: saved.timer })
    }
  })

  test('startup that timed out with no status report on hc is diagnosed as no-status-report', () => {
    const d = diagnose({ agent: 'senpi', phase: 'blocked', screen: 'Update Available\n', hasResult: false, quotaExhausted: null, neverReported: true, at: 1 })
    expect(d.verdict).toBe('no-status-report')
    expect(d.hint).toContain('upgrade')
    expect(diagnose({ agent: 'senpi', phase: 'blocked', screen: 'Update Available\n', hasResult: false, quotaExhausted: null, at: 1 }).verdict).toBe('unknown')
  })
})


// ---------------------------------------------------------------- hardening: several leads, one .omh

const wf = (name: string, o: Record<string, unknown> = {}) =>
  JSON.stringify({ name, category: 'deep', profile: 'claude-sonnet', family: 'claude', agent: 'claude', pane: `w9:${name}`, cwd: '/work', run: null, task: null, task_dir: null, lead: 'w1:p1', ...o })

/** herdr answers: every pane exists and is idle, `tab create` returns ids; `gone` panes do not exist. */
function herdrAnswers(gone: string[] = []) {
  return (argv: string[]): Run | undefined => {
    if (argv[0] !== 'herdr') return undefined
    if (argv[1] === 'pane' && argv[2] === 'get') return gone.includes(argv[3]!) ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: '{}' }
    if (argv[1] === 'agent' && argv[2] === 'get') return { exitCode: 0, stdout: JSON.stringify({ result: { agent: { agent_status: 'idle' } } }) }
    if (argv[1] === 'tab' && argv[2] === 'create') return { exitCode: 0, stdout: JSON.stringify({ result: { tab: { tab_id: 'T9' }, root_pane: { pane_id: 'P9' } } }) }
    return { exitCode: 0, stdout: '{}' }
  }
}

describe('ownsWorker', () => {
  const unbound = new Paths('/work', '/work/.omh')
  const bound = new Paths('/work.worktrees/r1', '/work/.omh', 'r1')
  const w = (o: Partial<Parameters<typeof ownsWorker>[0]>) => ({ name: 'w', category: null, profile: 'p', family: 'f', agent: 'a', pane: 'x', cwd: '/work', run: null, task: null, task_dir: null, ...o })
  test('a file with lead is ours exactly when it names this session; cwd, run and name do not matter', () => {
    expect(ownsWorker(w({ lead: 'w1:p1', run: 'r9', cwd: '/elsewhere' }), unbound, 'w1:p1')).toBe(true)
    expect(ownsWorker(w({ lead: 'w1:p1', name: runWorkerName('r1', 'x'), cwd: '/work.worktrees/r1/' }), bound, 'w1:p1')).toBe(true)
    expect(ownsWorker(w({ lead: 'w2:p2' }), unbound, 'w1:p1')).toBe(false)
    expect(ownsWorker(w({ lead: 'w1:p1' }), unbound, null)).toBe(false)
  })
  test('a file without lead is owned only by a session outside herdr and hc, from its own checkout (trailing slash aside)', () => {
    expect(ownsWorker(w({}), unbound, null)).toBe(true)
    expect(ownsWorker(w({ cwd: '/work/' }), unbound, null)).toBe(true)
    expect(ownsWorker(w({ cwd: '/work/packages/api' }), unbound, null)).toBe(false)
    expect(ownsWorker(w({ run: 'r9' }), unbound, null)).toBe(true)
    expect(ownsWorker(w({}), unbound, 'w1:p1')).toBe(false)
    // No "run-less worker in a bound checkout" rule any more.
    expect(ownsWorker(w({ cwd: '/work.worktrees/r1' }), bound, 'w1:p1')).toBe(false)
  })
})

describe('two leads, one .omh', () => {
  test('B2: dispatch reuses its own free worker, never another lead\'s', async ($, on) => {
    const mem: Mem = new Map([
      ['/work/.omh/current-run', `${RUN}\n`],
      [`/work/.omh/runs/${RUN}/plan.json`, JSON.stringify(PLAN)],
      ['/work/.omh/agents/rabcd-free.json', wf('rabcd-free', { lead: 'w2:p2' })], // the other lead's idle worker
      ['/work/.omh/agents/stray.json', wf('stray', { cwd: '/elsewhere' })], // another checkout
      ['/work/.omh/agents/free1.json', wf('free1')], // this session's
    ])
    const calls = world(on, mem, { hc: herdrAnswers() })
    prompts(on)
    const clock = await lead($, on)
    await clock.settle()
    const out = await tool($, { task: 'T1', intent: 'implement', rationale: 'x', brief: 'do it' }, 'omh_dispatch')
    expect(out).not.toContain('rabcd-free')
    expect(out).not.toContain('stray')
    expect(calls.some(c => c.includes('w9:rabcd-free') && c.includes('send'))).toBe(false)
    expect(out).toContain('→ free1')
    // The prompt a pane worker gets names the brief, the report path and the one-line reply.
    const prompt = calls.find(c => c.includes('prompt') && c.includes('free1'))!.at(-1)!
    expect(prompt).toContain(`/work/.omh/runs/${RUN}/T1/brief.md`)
    expect(prompt).toContain('You own: a.ts')
    expect(prompt).toContain(`write your report to /work/.omh/runs/${RUN}/T1/result.md`)
    expect(prompt).toContain(`DONE /work/.omh/runs/${RUN}/T1/result.md or BLOCKED <one-sentence reason>`)
    expect(prompt).not.toContain('Follow its reporting instructions')
  })

  test('B3: teardown with no names closes only this session\'s workers; names still reach any', async ($, on) => {
    const mem: Mem = new Map([
      ['/work/.omh/agents/mine.json', wf('mine')],
      ['/work/.omh/agents/rabcd-theirs.json', wf('rabcd-theirs', { lead: 'w2:p2' })],
      ['/work/.omh/agents/rabcd-elsewhere.json', wf('rabcd-elsewhere', { cwd: '/work.worktrees/x', lead: 'w2:p2' })],
    ])
    const calls = world(on, mem, { hc: herdrAnswers() })
    prompts(on)
    await lead($, on)
    const text = await tool($, {}, 'omh_teardown')
    expect(text).toContain('mine')
    expect(text).not.toContain('rabcd-theirs')
    expect(mem.has('/work/.omh/agents/mine.json')).toBe(false)
    expect(mem.has('/work/.omh/agents/rabcd-theirs.json')).toBe(true)
    expect(mem.has('/work/.omh/agents/rabcd-elsewhere.json')).toBe(true)
    expect(calls.some(c => c.includes('close') && c.includes('w9:rabcd-theirs'))).toBe(false)
    await tool($, { workers: ['rabcd-theirs'] }, 'omh_teardown')
    expect(mem.has('/work/.omh/agents/rabcd-theirs.json')).toBe(false)
  })

  test('S5: a bound lead collects its own scout dir, not the other lead\'s of the same name', async ($, on) => {
    const bare = 'scout-auth'
    const mine = `${runTag(RUN)}-${bare}`
    const theirs = `${runTag('20261121-other')}-${bare}`
    const dispatchOf = (id: string) => JSON.stringify({ task: id, worker: 'x', profile: 'claude-sonnet', family: 'claude', intent: 'explore', category: 'explore', outcome: null })
    const mem = fresh()
    world(on, mem, { hc: herdrAnswers() })
    prompts(on)
    const clock = await lead($, on)
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    await omh($, `approve ${RUN}`)
    await clock.settle()
    mem.set(`/work/.omh/runs/_scout/${mine}/dispatch.json`, dispatchOf(mine))
    mem.set(`/work/.omh/runs/_scout/${mine}/result.md`, 'MY FINDINGS')
    mem.set(`/work/.omh/runs/_scout/${theirs}/dispatch.json`, dispatchOf(theirs))
    mem.set(`/work/.omh/runs/_scout/${theirs}/result.md`, 'THEIR FINDINGS')
    mem.set(`/work/.omh/runs/_scout/${bare}/result.md`, 'UNTAGGED')
    const got = await tool($, { task: bare }, 'omh_collect')
    expect(got).toContain('MY FINDINGS')
    expect(got).not.toContain('THEIR')
    expect(mem.has(`/work/.omh/runs/_scout/${mine}/collected.json`)).toBe(true)
    expect(mem.has(`/work/.omh/runs/_scout/${theirs}/collected.json`)).toBe(false)
    // The tagged id a wake-up lists works too; abandon resolves the same way.
    expect(await tool($, { action: 'abandon', task: mine, quality: 'meh' })).toContain('abandoned')
    expect(mem.has(`/work/.omh/runs/_scout/${theirs}/collected.json`)).toBe(false)
  })


  test('S7: close refuses a run whose lead is live in another pane; force closes it', async ($, on) => {
    const mem = new Map<string, string>([
      [`/work/.omh/runs/${RUN}/plan.json`, JSON.stringify(PLAN)],
      [`/work/.omh/runs/${RUN}/finished.json`, '{}'],
      // lead.json of an older oh-my-herdr carries worktree fields too; only pane and root are read
      [`/work/.omh/runs/${RUN}/lead.json`, JSON.stringify({ worktree: WT, branch: `omh/${RUN}`, base: 'abc1234567890', pane: 'w7:p7', root: WT, at: 'x' })],
      ['/work/.omh/agents/rtag-w.json', wf('rtag-w', { run: RUN, cwd: WT })],
    ])
    world(on, mem, { hc: herdrAnswers() })
    prompts(on)
    await lead($, on)
    // 1. The other lead's pane is live: refused, nothing torn down.
    const refused = await omh($, `close ${RUN}`)
    expect(refused).toContain('live session')
    expect(mem.has(`/work/.omh/runs/${RUN}/closed.json`)).toBe(false)
    expect(mem.has('/work/.omh/agents/rtag-w.json')).toBe(true)
    // 2. force closes it.
    expect(await omh($, `close ${RUN} force`)).toContain('closed')
    expect(mem.has(`/work/.omh/runs/${RUN}/closed.json`)).toBe(true)
  })

  test('S7: once the other lead\'s pane is gone, close needs no force', async ($, on) => {
    const mem = new Map<string, string>([
      [`/work/.omh/runs/${RUN}/plan.json`, JSON.stringify(PLAN)],
      [`/work/.omh/runs/${RUN}/finished.json`, '{}'],
      [`/work/.omh/runs/${RUN}/lead.json`, JSON.stringify({ pane: 'w7:p7', root: WT })],
    ])
    world(on, mem, { hc: herdrAnswers(['w7:p7']) })
    prompts(on)
    await lead($, on)
    expect(await omh($, `close ${RUN}`)).toContain('closed')
  })

})

describe('sessions and approvals', () => {
  test('S1: OMH_RUN binds a fresh session, but not to a closed run', async ($, on) => {
    const mem: Mem = fresh()
    mem.set(`/work/.omh/runs/${RUN}/closed.json`, '{}')
    world(on, mem)
    prompts(on)
    await lead($, on, { OMH_RUN: RUN })
    // Not bound: drafting another named run switches current-run.
    expect(await tool($, { action: 'draft', name: 'next', markdown: '# next' })).toContain('draft written for run 20261121-next')
    expect(mem.get('/work/.omh/current-run')).toBe('20261121-next\n')
  })

  test('S1: OMH_RUN of an open run binds the session, and writes its lead.json', async ($, on) => {
    const mem: Mem = fresh()
    mem.set(`/work/.omh/runs/${RUN}/plan.json`, JSON.stringify(PLAN))
    world(on, mem)
    prompts(on)
    await lead($, on, { OMH_RUN: RUN })
    expect(await tool($, { action: 'draft', name: 'next', markdown: '# next' })).toContain(`stays bound to ${RUN}`)
    expect(mem.has('/work/.omh/current-run')).toBe(false)
    expect(leadJson(mem)).toEqual({ pane: 'w1:p1', root: '/work' })
  })

  test('N3: only a (no status) timeout counts as never reported', () => {
    const base = { agent: 'senpi', phase: 'blocked', screen: 'Update Available\n', hasResult: false, quotaExhausted: null, at: 1 } as const
    expect(diagnose({ ...base, neverReported: /\(no status\)/.test('hc never heard the agent report ready (no status)') }).verdict).toBe('no-status-report')
    expect(diagnose({ ...base, neverReported: /\(no status\)/.test('hc never heard the agent report ready (working)') }).verdict).toBe('unknown')
  })
})


describe('spawned workers and teardown (bound vs unbound)', () => {
  const spawnArgs = { name: 'wb', category: 'deep' }

  test('a bound session spawns a worker with its run recorded, and /omh teardown closes it', async ($, on) => {
    const mem = fresh()
    const calls = world(on, mem, { hc: herdrAnswers() })
    prompts(on)
    const clock = await lead($, on)
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    await omh($, `approve ${RUN}`)
    await clock.settle()
    await tool($, spawnArgs, 'omh_spawn')
    const file = JSON.parse(mem.get('/work/.omh/agents/wb.json')!)
    expect(file).toMatchObject({ name: 'wb', run: RUN, cwd: '/work' })
    const text = await omh($, 'teardown')
    expect(text).toContain('wb')
    expect(text).not.toContain('no workers on record')
    expect(mem.has('/work/.omh/agents/wb.json')).toBe(false)
    expect(calls.some(c => c[0] === 'herdr' && c.includes('close'))).toBe(true)
  })

  test('a run-less worker of this lead is still its own once the session is bound', async ($, on) => {
    const mem = fresh()
    mem.set('/work/.omh/agents/wb.json', wf('wb', { cwd: '/work' }))
    world(on, mem, { hc: herdrAnswers() })
    prompts(on)
    const clock = await lead($, on)
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    await omh($, `approve ${RUN}`)
    await clock.settle()
    expect(await omh($, 'teardown')).toContain('wb')
    expect(mem.has('/work/.omh/agents/wb.json')).toBe(false)
  })

  test('an unbound session\'s teardown leaves the bound session\'s spawned worker alone', async ($, on) => {
    const mem: Mem = new Map([
      ['/work/.omh/agents/wb.json', wf('wb', { cwd: WT, run: RUN, lead: 'w2:p2' })],
      ['/work/.omh/agents/wa.json', wf('wa')],
    ])
    world(on, mem, { hc: herdrAnswers() })
    prompts(on)
    await lead($, on)
    const text = await omh($, 'teardown')
    expect(text).toContain('wa')
    expect(text).not.toContain('wb')
    expect(mem.has('/work/.omh/agents/wb.json')).toBe(true)
    expect(mem.has('/work/.omh/agents/wa.json')).toBe(false)
  })
})

const THIS = 'w1:p1' // the lead's pane (HERDR_PANE_ID in lead())

describe('ownership by the lead field (NEW-1..3)', () => {
  test('NEW-1: two sessions spawn the same name: the second is refused, the first\'s file is untouched; a dead pane may be replaced', async ($, on) => {
    const theirs = wf('impl', { lead: 'w2:p2', pane: 'w9:impl' })
    const mem: Mem = new Map([['/work/.omh/agents/impl.json', theirs]])
    world(on, mem, { hc: herdrAnswers(['w9:dead']) })
    prompts(on)
    await lead($, on)
    const r = await tool($, { name: 'impl', category: 'deep' }, 'omh_spawn')
    expect(r).toContain("taken by another lead's live worker")
    expect(mem.get('/work/.omh/agents/impl.json')).toBe(theirs)
    // Its pane is gone: nothing is overwritten that is alive.
    mem.set('/work/.omh/agents/old.json', wf('old', { lead: 'w2:p2', pane: 'w9:dead' }))
    expect(await tool($, { name: 'old', category: 'deep' }, 'omh_spawn')).not.toContain('taken by another')
    expect(JSON.parse(mem.get('/work/.omh/agents/old.json')!)).toMatchObject({ lead: THIS })
  })

  test('NEW-1: a name taken on disk by another lead is skipped when dispatch picks a worker name', async ($, on) => {
    const mem: Mem = new Map([
      ['/work/.omh/current-run', `${RUN}\n`],
      [`/work/.omh/runs/${RUN}/plan.json`, JSON.stringify(PLAN)],
      ['/work/.omh/agents/w1-t1.json', wf('w1-t1', { lead: 'w2:p2' })],
    ])
    world(on, mem, { hc: herdrAnswers() })
    prompts(on)
    const clock = await lead($, on)
    await clock.settle()
    const out = await tool($, { task: 'T1', intent: 'implement', rationale: 'x', brief: 'do it' }, 'omh_dispatch')
    expect(out).toContain('→ w1-t1-2')
    expect(JSON.parse(mem.get('/work/.omh/agents/w1-t1.json')!)).toMatchObject({ lead: 'w2:p2' })
    expect(JSON.parse(mem.get('/work/.omh/agents/w1-t1-2.json')!)).toMatchObject({ lead: THIS, run: RUN, task: 'T1' })
  })

  test('NEW-2: an unbound lead finishes run X, then in run Y reuses the idle X worker (its file was freed)', async ($, on) => {
    const Y = '20261122-next'
    const mem: Mem = new Map([
      ['/work/.omh/current-run', `${RUN}\n`],
      [`/work/.omh/runs/${RUN}/plan.json`, JSON.stringify(PLAN)],
      [`/work/.omh/runs/${RUN}/T1/result.md`, 'done'],
      ['/work/.omh/agents/wk.json', wf('wk', { lead: THIS, run: RUN, task: 'T1', task_dir: `/work/.omh/runs/${RUN}/T1` })],
    ])
    const calls = world(on, mem, { hc: herdrAnswers() })
    prompts(on)
    const clock = await lead($, on)
    await clock.settle()
    expect(await tool($, { action: 'verified', task: 'T1', quality: 'ok' })).toContain('marked verified')
    expect(JSON.parse(mem.get('/work/.omh/agents/wk.json')!)).toMatchObject({ run: null, task: null, task_dir: null, lead: THIS })
    // Run Y becomes current.
    mem.set('/work/.omh/current-run', `${Y}\n`)
    mem.set(`/work/.omh/runs/${Y}/plan.json`, JSON.stringify(PLAN))
    const out = await tool($, { task: 'T1', intent: 'implement', rationale: 'x', brief: 'do it' }, 'omh_dispatch')
    expect(out).toContain('→ wk')
    expect(calls.some(c => c.includes('tab') && c.includes('create'))).toBe(false)
    expect(JSON.parse(mem.get('/work/.omh/agents/wk.json')!)).toMatchObject({ run: Y, task: 'T1' })
  })

  test('NEW-3: a worker started in a subfolder is torn down by its lead; the other lead\'s is not', async ($, on) => {
    const mem: Mem = new Map([
      ['/work/.omh/agents/sub.json', wf('sub', { lead: THIS, cwd: '/work/packages/api' })],
      ['/work/.omh/agents/other.json', wf('other', { lead: 'w2:p2', cwd: '/work/packages/api' })],
    ])
    world(on, mem, { hc: herdrAnswers() })
    prompts(on)
    await lead($, on)
    const text = await tool($, {}, 'omh_teardown')
    expect(text).toContain('sub')
    expect(text).not.toContain('other')
    expect(mem.has('/work/.omh/agents/sub.json')).toBe(false)
    expect(mem.has('/work/.omh/agents/other.json')).toBe(true)
  })

  test('a file without lead is not ours inside herdr, whatever its cwd, and is never torn down by no-name teardown', async ($, on) => {
    const mem: Mem = new Map([
      ['/work/.omh/agents/old.json', wf('old', { lead: undefined })],
      ['/work/.omh/agents/mine.json', wf('mine')],
    ])
    world(on, mem, { hc: herdrAnswers() })
    prompts(on)
    await lead($, on)
    await tool($, {}, 'omh_teardown')
    expect(mem.has('/work/.omh/agents/old.json')).toBe(true)
    expect(mem.has('/work/.omh/agents/mine.json')).toBe(false)
  })
})

// ---------------------------------------------------------------- several sessions, one .omh
// Each session is its own host (state, pane) over a shared disk, swapped into the module's runtime:
// what two Claudes sharing a project would hold. The actions are called directly.

describe('several sessions, one .omh', () => {
  const A = '20261121-a'
  const B = '20261121-b'
  const OMH = '/work/.omh'
  const PLAN2 = {
    goal: 'Two',
    waves: [
      {
        id: 1,
        gate: 'tests pass',
        tasks: [
          { id: 'T1', title: 'one', intent: 'implement', category: 'deep', owns: ['a.ts'], deps: [] },
          { id: 'T2', title: 'two', intent: 'implement', category: 'deep', owns: ['b.ts'], deps: [] },
        ],
      },
    ],
  }
  const dispatchT = (task: string) => ({ task, intent: 'implement' as const, rationale: 'x', brief: 'do it' })

  const cellOf = <T,>(init: T) => {
    let v = init
    return { get: async () => v, set: async (fn: (old: T) => T) => (v = fn(v)) }
  }

  type Sess = { host: any; pane: string; root: string; paths: Paths }

  function newSession(mem: Mem, pane: string, root: string): Sess {
    const ASSET = /\/skills\/oh-my-herdr\/assets\/(agents|config\.default)\.json$/
    const asset = (p: string) => {
      const m = ASSET.exec(p)?.[1]
      return m === undefined ? undefined : JSON.stringify(m === 'agents' ? AGENTS : CONFIG)
    }
    const dirOf = (p: string) => [...mem.keys()].some(k => k.startsWith(`${p.replace(/\/$/, '')}/`))
    const host = {
      plugin: { root: '/plug', name: 'oh-my-herdr' },
      env: { get: async (n: string) => ({ HERDR_ENV: '1', HERDR_PANE_ID: pane, HOME: '/home/u' } as Record<string, string>)[n] },
      fs: {
        read: async (p: string) => {
          const t = asset(p) ?? mem.get(p)
          if (t === undefined) throw new Error(`ENOENT ${p}`)
          return t
        },
        write: async (p: string, t: string) => void mem.set(p, t),
        exists: async (p: string) => asset(p) !== undefined || mem.has(p) || dirOf(p),
        stat: async (p: string) => {
          if (mem.has(p)) return { kind: 'file', size: mem.get(p)!.length }
          if (dirOf(p)) return { kind: 'dir', size: 0 }
          throw new Error(`ENOENT ${p}`)
        },
        list: async (p: string) => {
          const dir = `${p.replace(/\/$/, '')}/`
          const names = new Set([...mem.keys()].filter(k => k.startsWith(dir)).map(k => k.slice(dir.length).split('/')[0]!))
          return [...names].map(name => ({ name, kind: mem.has(dir + name) ? 'file' : 'dir', size: 0 }))
        },
      },
      process: {
        run: async (argv: string[], init?: { stdin?: string }) => {
          const out = (stdout = '', exitCode = 0) => ({ exitCode, stdout, stderr: '' })
          if (argv[0] === 'rm') return (mem.delete(argv[argv.length - 1]!), out())
          if (argv[0] === 'mv') {
            if (!mem.has(argv[1]!)) return out('', 1)
            mem.set(argv[2]!, mem.get(argv[1]!)!)
            mem.delete(argv[1]!)
            return out()
          }
          if (argv[0] === 'sh' && String(argv[2] ?? '').includes('cat >>')) {
            mem.set(argv[5]!, (mem.get(argv[5]!) ?? '') + String(init?.stdin ?? ''))
            return out()
          }
          const r = herdrAnswers()(argv)
          return r ? out(r.stdout, r.exitCode) : out('', 1)
        },
        spawn: () => (async function* () {})(),
      },
      clock: { now: async () => new Date(2026, 10, 21, 20, 0).getTime(), after: () => ({ cancel() {} }), every: () => ({ cancel() {} }) },
      http: {
        fetch: async () => {
          throw new Error('offline')
        },
      },
      prompt: { submit: async () => ({}) },
      agent: { list: async () => [], spawn: async () => ({}) },
      ui: { log() {}, status() {} },
      session: { append: async () => undefined },
      state: {
        run: cellOf<unknown>(null),
        workers: cellOf<Record<string, unknown>>({}),
        quota: cellOf<Record<string, unknown>>({}),
        continueCount: cellOf(0),
        wake: cellOf({ sections: [] as string[], settleKey: '' }),
        bound: cellOf<unknown>(null),
      },
    }
    return { host, pane, root, paths: new Paths(root, OMH) }
  }

  const KEYS = ['$', 'paths', 'cfg', 'selfPane', 'selfTerminal', 'paneSeen', 'wakeGuards', 'watchers', 'options', 'wakeTimer'] as const
  function useSessions() {
    const saved = Object.fromEntries(KEYS.map(k => [k, rt[k]])) as Record<string, any>
    // Make this session the live one; whatever it bound in the meantime stays in its own record.
    const enter = (s: Sess) => {
      rt.$ = s.host
      rt.paths = s.paths
      rt.selfPane = s.pane
      rt.selfTerminal = null
      rt.cfg = null
      rt.paneSeen = new Map()
      rt.wakeGuards = new Map()
      rt.watchers = new Map()
    }
    const leave = (s: Sess) => {
      s.paths = rt.paths!
    }
    return { enter, leave, restore: () => Object.assign(rt, saved) }
  }

  const files = (mem: Mem): Array<{ file: string } & Record<string, any>> =>
    [...mem.entries()].filter(([k]) => k.startsWith(`${OMH}/agents/`)).map(([k, v]) => ({ file: k, ...(JSON.parse(v) as Record<string, any>) }))
  const ownedBy = (mem: Mem, pane: string) => files(mem).filter(f => f.lead === pane)

  /** Run `fn` as session `s`. */
  async function as<T>(sx: ReturnType<typeof useSessions>, s: Sess, fn: () => Promise<T>): Promise<T> {
    sx.enter(s)
    try {
      return await fn()
    } finally {
      sx.leave(s)
    }
  }

  /** A and B, each unbound at first: draft, approve (which binds), plan. */
  async function setup(mem: Mem, rootB: string) {
    const sx = useSessions()
    const a = newSession(mem, 'w1:p1', '/work')
    const b = newSession(mem, 'w2:p2', rootB)
    await as(sx, a, async () => {
      expect((await draftPlan('# A', 'a')).ok).toBe(true)
      const r = await approveRun()
      expect(r.ok).toBe(true)
      expect((await writePlan(PLAN2)).ok).toBe(true)
    })
    await as(sx, b, async () => {
      expect((await draftPlan('# B', 'b')).ok).toBe(true) // B is unbound: it moves the shared current-run
      const r = await approveRun(B)
      expect(r.ok).toBe(true)
      expect((await writePlan(PLAN2)).ok).toBe(true)
    })
    expect(mem.get(`${OMH}/current-run`)).toBe(`${B}\n`)
    return { sx, a, b }
  }

  test('two roots: each binds its own run in its own root; dispatch, status and teardown are independent', async () => {
    const mem: Mem = new Map()
    const { sx, a, b } = await setup(mem, WT)
    try {
      expect(JSON.parse(mem.get(`${OMH}/runs/${A}/lead.json`)!)).toEqual({ pane: 'w1:p1', root: '/work' })
      expect(JSON.parse(mem.get(`${OMH}/runs/${B}/lead.json`)!)).toEqual({ pane: 'w2:p2', root: WT })
      await as(sx, b, async () => expect((await dispatch(dispatchT('T1'))).text).toContain('dispatched T1'))
      await as(sx, a, async () => expect((await dispatch(dispatchT('T1'))).text).toContain('dispatched T1'))
      const bw = ownedBy(mem, 'w2:p2')
      const aw = ownedBy(mem, 'w1:p1')
      expect(bw).toHaveLength(1)
      expect(aw).toHaveLength(1)
      expect(bw[0]).toMatchObject({ cwd: WT, run: B, task: 'T1' })
      expect(aw[0]).toMatchObject({ cwd: '/work', run: A, task: 'T1' })
      expect(bw[0]!.name.startsWith(`${runTag(B)}-`)).toBe(true)
      expect(aw[0]!.name.startsWith(`${runTag(A)}-`)).toBe(true)
      // Status: each shows its own run only.
      const sa = await as(sx, a, async () => (await status()).text)
      const sb = await as(sx, b, async () => (await status()).text)
      expect(sa).toContain(A)
      expect(sa).not.toContain(B)
      expect(sb).toContain(B)
      expect(sb).not.toContain(A)
      // B's teardown closes only B's worker.
      const t = await as(sx, b, async () => (await teardown(undefined)).text)
      expect(t).toContain(bw[0]!.name)
      expect(t).not.toContain(aw[0]!.name)
      expect(ownedBy(mem, 'w2:p2')).toHaveLength(0)
      expect(ownedBy(mem, 'w1:p1')).toHaveLength(1)
      // Closing B (forced) unbinds B only: A stays bound to its run and its worker lives.
      await as(sx, b, async () => {
        expect((await closeRun(B, true)).text).toContain('closed')
        expect(paths().boundRun).toBe(null)
      })
      expect(mem.has(`${OMH}/runs/${B}/closed.json`)).toBe(true)
      expect(mem.has(`${OMH}/runs/${A}/closed.json`)).toBe(false)
      expect(ownedBy(mem, 'w1:p1')).toHaveLength(1)
      await as(sx, a, async () => expect(paths().boundRun).toBe(A))
    } finally {
      sx.restore()
    }
  })

  test('the same root: each dispatches into its own run, and reuse stays within its own lead', async () => {
    const mem: Mem = new Map()
    const { sx, a, b } = await setup(mem, '/work')
    try {
      expect(JSON.parse(mem.get(`${OMH}/runs/${A}/lead.json`)!).root).toBe('/work')
      expect(JSON.parse(mem.get(`${OMH}/runs/${B}/lead.json`)!).root).toBe('/work')
      const idle = (name: string, lead: string) => mem.set(`${OMH}/agents/${name}.json`, wf(name, { lead, pane: `w9:${name}` }))
      // B's idle worker is in the same checkout: A does not take it, it starts its own.
      idle('bidle', 'w2:p2')
      await as(sx, b, async () => reconcile())
      const first = await as(sx, a, async () => (await dispatch(dispatchT('T1'))).text)
      expect(first).toContain('dispatched T1')
      expect(first).not.toContain('→ bidle')
      const aw = ownedBy(mem, 'w1:p1')
      expect(aw).toHaveLength(1)
      expect(aw[0]).toMatchObject({ run: A, task: 'T1', cwd: '/work' })
      expect(JSON.parse(mem.get(`${OMH}/agents/bidle.json`)!)).toMatchObject({ run: null, task: null, lead: 'w2:p2' })
      // Both have an idle worker of their own now: each takes its own, whatever the order.
      idle('aidle', 'w1:p1')
      await as(sx, a, async () => reconcile())
      const second = await as(sx, a, async () => (await dispatch(dispatchT('T2'))).text)
      expect(second).toContain('→ aidle')
      const third = await as(sx, b, async () => (await dispatch(dispatchT('T1'))).text)
      expect(third).toContain('→ bidle')
      expect(JSON.parse(mem.get(`${OMH}/agents/aidle.json`)!)).toMatchObject({ run: A, task: 'T2', lead: 'w1:p1' })
      expect(JSON.parse(mem.get(`${OMH}/agents/bidle.json`)!)).toMatchObject({ run: B, task: 'T1', lead: 'w2:p2' })
      expect(mem.has(`${OMH}/runs/${A}/T2/dispatch.json`)).toBe(true)
      expect(mem.has(`${OMH}/runs/${B}/T1/dispatch.json`)).toBe(true)
      expect(mem.has(`${OMH}/runs/${B}/T2/dispatch.json`)).toBe(false)
      // Teardown with no names: only its own.
      const t = await as(sx, a, async () => (await teardown(undefined)).text)
      expect(t).toContain('aidle')
      expect(t).not.toContain('bidle')
      expect(mem.has(`${OMH}/agents/bidle.json`)).toBe(true)
      expect(mem.has(`${OMH}/agents/aidle.json`)).toBe(false)
    } finally {
      sx.restore()
    }
  })

  test('the same root: a name the other session holds live is refused to spawn', async () => {
    const mem: Mem = new Map()
    const { sx, a, b } = await setup(mem, '/work')
    try {
      await as(sx, b, async () => expect((await spawn({ name: 'shared', category: 'deep', avoidFamilies: [] }) as any).worker?.name).toBe('shared'))
      const r = await as(sx, a, async () => spawn({ name: 'shared', category: 'deep', avoidFamilies: [] }))
      expect((r as any).text).toContain("taken by another lead's live worker")
    } finally {
      sx.restore()
    }
  })

  test('a bound session approving another run is refused; the other session approves it and binds it', async () => {
    const mem: Mem = new Map()
    const { sx, a, b } = await setup(mem, WT)
    try {
      mem.set(`${OMH}/runs/20261121-c/draft.md`, '# C\n')
      const r = await as(sx, a, async () => approveRun('c'))
      expect(r.ok).toBe(false)
      expect(r.text).toContain('another Claude')
      // B finishes and closes its run, then takes c.
      mem.set(`${OMH}/runs/${B}/gates.json`, JSON.stringify({ passed: [1] }))
      await as(sx, b, async () => {
        expect((await finishRun()).ok).toBe(true)
        expect((await closeRun()).ok).toBe(true)
        const ok = await approveRun('c')
        expect(ok.text).toContain('this session now leads 20261121-c')
        expect(paths().boundRun).toBe('20261121-c')
        expect(paths().root).toBe(WT)
      })
      expect(JSON.parse(mem.get(`${OMH}/runs/20261121-c/lead.json`)!)).toEqual({ pane: 'w2:p2', root: WT })
      await as(sx, a, async () => expect(paths().boundRun).toBe(A))
    } finally {
      sx.restore()
    }
  })

  test('drop file: a run another live session is bound to is left for it; its own poller re-approves it and wakes itself', async () => {
    const mem: Mem = new Map()
    const { sx, a, b } = await setup(mem, WT)
    try {
      mem.set(`${OMH}/runs/${B}/draft.md`, '# B v2\n')
      mem.set(`${OMH}/approvals/${B}`, `${draftDigest('# B v2')}\n`)
      expect(await as(sx, a, async () => pollApprovals())).toEqual([])
      expect(mem.has(`${OMH}/approvals/${B}`)).toBe(true)
      expect(mem.has(`${OMH}/runs/${B}/draft.md`)).toBe(true)
      const done = await as(sx, b, async () => pollApprovals())
      expect(done).toHaveLength(1)
      expect(done[0]).toMatchObject({ run: B })
      expect(done[0]!.wake).toContain('approved again')
      expect(mem.get(`${OMH}/runs/${B}/plan.md`)).toContain('# B v2')
      expect(mem.has(`${OMH}/approvals/${B}`)).toBe(false)
      // A run nobody is bound to: whichever session polls first approves it, binding nobody.
      mem.set(`${OMH}/runs/20261121-c/draft.md`, '# C\n')
      mem.set(`${OMH}/approvals/20261121-c`, `${draftDigest('# C')}\n`)
      const c = await as(sx, a, async () => pollApprovals())
      expect(c).toHaveLength(1)
      expect(c[0]!.wake).toBeUndefined()
      expect(c[0]!.text).toContain('No session leads')
      expect(mem.get(`${OMH}/runs/20261121-c/plan.md`)).toContain('# C')
      expect(mem.has(`${OMH}/runs/20261121-c/lead.json`)).toBe(false)
      await as(sx, a, async () => expect(paths().boundRun).toBe(A))
    } finally {
      sx.restore()
    }
  })

  // ---- S3 fixes: B1, M1, M3, M4 and the minors that reach the sessions

  /** A drafts and approves run `a` (bound, lead.json w1:p1) and derives its plan; C is a second session in the same checkout, unbound. */
  async function aLeadsC(mem: Mem) {
    const sx = useSessions()
    const a = newSession(mem, 'w1:p1', '/work')
    const c = newSession(mem, 'w3:p3', '/work')
    await as(sx, a, async () => {
      expect((await draftPlan('# A', 'a')).ok).toBe(true)
      expect((await approveRun()).ok).toBe(true)
      expect((await writePlan(PLAN2)).ok).toBe(true)
    })
    return { sx, a, c }
  }

  test('B1: a second unbound session neither follows nor steals a run a live lead is bound to; approve X force takes it over', async () => {
    const mem: Mem = new Map()
    const { sx, a, c } = await aLeadsC(mem)
    try {
      expect(mem.get(`${OMH}/current-run`)).toBe(`${A}\n`)
      await as(sx, c, async () => {
        // It does not follow current-run into A's run: no status, no plan view, no dispatch, no approve.
        expect(await openRun()).toBe(null)
        expect(await currentRun()).toBe(null)
        expect((await status()).text).not.toContain(A)
        const d = await dispatch(dispatchT('T1'))
        expect(d.ok).toBe(false)
        expect(d.text).not.toContain('dispatched T1')
        expect((await approveRun()).ok).toBe(false)
        const named = await approveRun(A)
        expect(named.ok).toBe(false)
        expect(named.text).toContain('w1:p1')
        expect(named.text).toContain(`approve ${A} force`)
        expect((await dispatch(dispatchT('T1'))).ok).toBe(false)
      })
      expect(JSON.parse(mem.get(`${OMH}/runs/${A}/lead.json`)!)).toEqual({ pane: 'w1:p1', root: '/work' })
      await as(sx, a, async () => expect(paths().boundRun).toBe(A))
      // force takes it over: lead.json now names C, and A, still bound in memory, loses the run at its next refresh.
      await as(sx, c, async () => {
        const r = await approveRun(A, true)
        expect(r.ok).toBe(true)
        expect(r.text).toContain('this session now leads')
        expect(paths().boundRun).toBe(A)
      })
      expect(JSON.parse(mem.get(`${OMH}/runs/${A}/lead.json`)!).pane).toBe('w3:p3')
      await as(sx, a, async () => {
        await status()
        expect(paths().boundRun).toBe(null)
        expect(JSON.stringify(await rt.$!.state.wake.get())).toContain('taken over by the session in w3:p3')
        // and A's own close no longer reaches into C's run
        expect((await closeRun(A)).ok).toBe(false)
      })
      expect(mem.has(`${OMH}/runs/${A}/closed.json`)).toBe(false)
    } finally {
      sx.restore()
    }
  })

  test('B1: after /omh close unbinds a session, it does not fall back into another live lead\'s current-run', async () => {
    const mem: Mem = new Map()
    const { sx, c } = await aLeadsC(mem)
    try {
      await as(sx, c, async () => {
        expect((await draftPlan('# C', 'c')).ok).toBe(true)
        expect((await approveRun()).ok).toBe(true)
        expect(paths().boundRun).toBe('20261121-c')
        // A's draft moves the shared current-run back to A's run while C is bound to its own
        await rt.$!.fs.write(`${OMH}/current-run`, `${A}\n`)
        expect((await closeRun(undefined, true)).ok).toBe(true)
        expect(paths().boundRun).toBe(null)
        expect(await openRun()).toBe(null)
        expect(await currentRun()).toBe(null)
      })
    } finally {
      sx.restore()
    }
  })

  test('M1: a closed run leaves .omh/status.json and its own status.json goes', async () => {
    const mem: Mem = new Map()
    const { sx, a, b } = await setup(mem, WT)
    try {
      const rows = () => (JSON.parse(mem.get(`${OMH}/status.json`) ?? '{"runs":[]}').runs as { id: string }[]).map(r => r.id)
      await as(sx, a, async () => void (await status()))
      expect(rows()).toContain(B)
      expect(mem.has(`${OMH}/runs/${B}/status.json`)).toBe(true)
      await as(sx, b, async () => expect((await closeRun(B, true)).ok).toBe(true)) // unfinished: forced
      expect(mem.has(`${OMH}/runs/${B}/status.json`)).toBe(false)
      expect(rows()).not.toContain(B)
      await as(sx, a, async () => void (await status()))
      expect(rows()).toEqual([A])
    } finally {
      sx.restore()
    }
  })

  test('M3: a run closed from another session unbinds the lead bound to it, with one wake-up', async () => {
    const mem: Mem = new Map()
    const { sx, a, c } = await aLeadsC(mem)
    try {
      await as(sx, c, async () => expect((await closeRun(A, true)).ok).toBe(true))
      expect(mem.has(`${OMH}/runs/${A}/closed.json`)).toBe(true)
      await as(sx, a, async () => {
        expect(paths().boundRun).toBe(A) // not told yet
        await status()
        expect(paths().boundRun).toBe(null)
        const wake = JSON.stringify(await rt.$!.state.wake.get())
        expect(wake).toContain(`Run ${A} was closed from another session`)
        await status()
        expect(JSON.stringify(await rt.$!.state.wake.get()).split('was closed from another session').length).toBe(2) // once
        expect(await currentRun()).toBe(null)
      })
    } finally {
      sx.restore()
    }
  })

  test('M4: a dropped approval for the drafting lead\'s own run binds and wakes it; a bound session leaves that draft alone', async () => {
    const mem: Mem = new Map()
    const sx = useSessions()
    const a = newSession(mem, 'w1:p1', '/work')
    const b = newSession(mem, 'w2:p2', '/work')
    try {
      // B is bound to its own run b.
      await as(sx, b, async () => {
        expect((await draftPlan('# B', 'b')).ok).toBe(true)
        expect((await approveRun()).ok).toBe(true)
      })
      // A (unbound) drafts x: current-run is x, nobody leads it.
      await as(sx, a, async () => expect((await draftPlan('# X', 'x')).ok).toBe(true))
      expect(mem.get(`${OMH}/current-run`)).toBe('20261121-x\n')
      mem.set(`${OMH}/approvals/20261121-x`, `${draftDigest('# X')}\n`)
      // B is bound elsewhere: it must not approve the drafting lead's run behind its back.
      expect(await as(sx, b, async () => pollApprovals())).toEqual([])
      expect(mem.has(`${OMH}/approvals/20261121-x`)).toBe(true)
      const done = await as(sx, a, async () => {
        const d = await pollApprovals()
        expect(paths().boundRun).toBe('20261121-x')
        return d
      })
      expect(done).toHaveLength(1)
      expect(done[0]!.wake).toContain('You now lead run 20261121-x')
      expect(JSON.parse(mem.get(`${OMH}/runs/20261121-x/lead.json`)!).pane).toBe('w1:p1')
      expect(mem.get(`${OMH}/runs/20261121-x/plan.md`)).toContain('# X')
    } finally {
      sx.restore()
    }
  })

  test('m4: a drop file for a closed run is rejected, not re-approved', async () => {
    const mem: Mem = new Map()
    const { sx, a, c } = await aLeadsC(mem)
    try {
      await as(sx, c, async () => expect((await closeRun(A, true)).ok).toBe(true))
      mem.set(`${OMH}/runs/${A}/draft.md`, '# A again\n')
      mem.set(`${OMH}/approvals/${A}`, `${draftDigest('# A again')}\n`)
      const done = await as(sx, c, async () => pollApprovals())
      expect(done[0]!.text).toContain('closed')
      expect(mem.has(`${OMH}/approvals/${A}.rejected`)).toBe(true)
      expect(mem.has(`${OMH}/approvals/${A}`)).toBe(false)
      expect(mem.get(`${OMH}/runs/${A}/plan.md`)).not.toContain('again')
    } finally {
      sx.restore()
    }
  })

  test('m6: re-approving a run that has a plan.json wakes with "continue the current wave"', async () => {
    const mem: Mem = new Map()
    const { sx, a } = await aLeadsC(mem)
    try {
      await as(sx, a, async () => {
        const r = await approveRun()
        expect(r.wake).toContain('continue the current wave')
        expect(r.wake).not.toContain('Derive the waves')
      })
    } finally {
      sx.restore()
    }
  })

  test('m8: a bound session resets the stale top-level status it wrote while unbound', async () => {
    const mem: Mem = new Map()
    const { sx, a } = await aLeadsC(mem)
    try {
      const top = JSON.parse(mem.get(`${OMH}/status.json`)!)
      expect(top.run).toBe('') // not "a": the summary's own fields belong to no bound session
      expect(top.runs.map((r: { id: string }) => r.id)).toEqual([A])
      await as(sx, a, async () => void (await status()))
    } finally {
      sx.restore()
    }
  })
})

describe('fixes from the F6 spot-check', () => {
  const holderOf = async ($: any, on: any, mem: Mem) => {
    world(on, mem, { hc: herdrAnswers() })
    prompts(on)
    const clock = await lead($, on)
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    await omh($, 'approve')
    await clock.settle()
    await tool($, { action: 'plan', plan: PLAN })
    return { clock }
  }

  test('B1: approve binds without moving the root: the lead\'s idle run-less worker in it is reused', async ($, on) => {
    const mem = fresh()
    mem.set('/work/.omh/agents/scoutw.json', wf('scoutw', { lead: THIS })) // idle, in this checkout, run-less
    world(on, mem, { hc: herdrAnswers() })
    prompts(on)
    const clock = await lead($, on)
    await tool($, { action: 'draft', name: 'feat', markdown: '# Feature' })
    await omh($, `approve ${RUN}`)
    await clock.settle()
    await tool($, { action: 'plan', plan: PLAN })
    const out = await tool($, { task: 'T1', intent: 'implement', rationale: 'x', brief: 'do it' }, 'omh_dispatch')
    expect(out).toContain('→ scoutw')
    expect(JSON.parse(mem.get('/work/.omh/agents/scoutw.json')!)).toMatchObject({ run: RUN, task: 'T1', lead: THIS, cwd: '/work' })
  })

  test('m5: a worker this lead started in a subfolder is still its own (teardown) but is not reused for a root task', async ($, on) => {
    const mem: Mem = new Map([
      ['/work/.omh/current-run', `${RUN}\n`],
      [`/work/.omh/runs/${RUN}/plan.json`, JSON.stringify(PLAN)],
      ['/work/.omh/agents/sub.json', wf('sub', { lead: THIS, cwd: '/work/packages/api' })],
    ])
    world(on, mem, { hc: herdrAnswers() })
    prompts(on)
    const clock = await lead($, on)
    await clock.settle()
    const out = await tool($, { task: 'T1', intent: 'implement', rationale: 'x', brief: 'do it' }, 'omh_dispatch')
    expect(out).not.toContain('→ sub')
    expect(JSON.parse(mem.get('/work/.omh/agents/sub.json')!)).toMatchObject({ task: null })
    expect(ownsWorker(JSON.parse(mem.get('/work/.omh/agents/sub.json')!), new Paths('/work', '/work/.omh'), THIS)).toBe(true)
  })


  test('M4: finish, then /omh close with no id closes its own run even when current-run points elsewhere', async ($, on) => {
    const mem = fresh()
    await holderOf($, on, mem)
    mem.set(`/work/.omh/runs/${RUN}/gates.json`, JSON.stringify({ passed: [1] }))
    expect(await tool($, { action: 'finish' })).toContain('finished')
    // Another lead drafts Y and moves the shared current-run.
    mem.set('/work/.omh/runs/20261121-y/draft.md', '# Y\n')
    mem.set('/work/.omh/current-run', '20261121-y\n')
    expect(await omh($, 'runs')).toContain('this session')
    const r = await omh($, 'close')
    expect(r).toContain(`run ${RUN} closed`)
    expect(mem.has(`/work/.omh/runs/${RUN}/closed.json`)).toBe(true)
    expect(mem.has('/work/.omh/runs/20261121-y/closed.json')).toBe(false)
  })

  test('m4: liveWorkersAll skips a gone name only when it is the same pane; another lead\'s live worker under that name counts', async () => {
    const mem: Mem = new Map([['/work/.omh/agents/impl.json', wf('impl', { lead: 'w2:p2', pane: 'p-new' })]])
    const saved = { $: rt.$, paths: rt.paths, paneSeen: rt.paneSeen }
    let state: Record<string, unknown> = {}
    rt.$ = {
      fs: {
        exists: async (p: string) => mem.has(p) || p === '/work/.omh/agents',
        read: async (p: string) => mem.get(p) ?? '',
        list: async () => [{ name: 'impl.json', kind: 'file', size: 0 }],
      },
      state: { workers: { get: async () => state } },
      clock: { now: async () => 1 },
      process: { run: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }) },
    } as never
    rt.paths = new Paths('/work', '/work/.omh')
    rt.paneSeen = new Map()
    try {
      state = { impl: { name: 'impl', pane: 'p-old', phase: 'gone' } }
      expect(await liveWorkersAll()).toBe(1)
      state = { impl: { name: 'impl', pane: 'p-new', phase: 'gone' } }
      expect(await liveWorkersAll()).toBe(0)
    } finally {
      Object.assign(rt, saved)
    }
  })
})
