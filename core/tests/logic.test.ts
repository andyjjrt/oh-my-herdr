// The pure parts: state machine, routing, plan validation, quota parsing, diagnosis, guards.

import { describe, expect, mock, test } from 'bun:test'

import { normalizeConfig } from '../config'
import { diagnose } from '../diagnose'
import { currentRunId, openRunId, Paths, runWorkerName } from '../files'
import { ownerOf, relativeTo } from '../guards'
import { closestName, draftDigest, findTask, isApproved, isScout, parsePlan, planningStatusFile, planRunId, SCOUT_ID, runView, statusFile, taskStatus, unknownCategory, waveProgress, type TaskFacts } from '../plan'
import { evaluate, formatQuota, parseClaude, parseCommandQuota, parseOpencodeGo, probe, providerOf, providersOf, quotaAllows } from '../quota'
import { cell, table } from '../md'
import { isUsualPair, pickProfile } from '../route'
import { newWorker, step, type SettleFacts } from '../settle'
import { scoutsText, statusBrief, statusText, ulwPrompt } from '../text'
import { endStatusOf, isSubagentWorker, settleStatusOf, subagentIdOf, subagentPane, subagentScreen } from '../subagent'
import { configProblems, isSubagentProfile } from '../config'
import { place } from '../layout'
import { bindRun, decodeWake, encodeWake, flushWake, host, liveWorkersAll, paths, queueWake, reconcile, refreshRun, rt, unbindRun, type WakeSpec } from '../runtime'
import { fakeHost as makeFakeHost } from '../testing/fake-host'
import type { OmhQuota } from '../types'
import { CLAUDE_USAGE, OPENCODE_GO_USAGE } from './fixtures/quota'

const AGENTS = {
  claude: { launch: 'herdr-kind', kind: 'claude', bin: 'claude' },
  senpi: { launch: 'command', command: ['senpi'], detect_as: 'pi', bin: 'senpi' },
}

const CFG = normalizeConfig(
  '/cfg/config.json',
  {
    quota: { threshold: 95, on_unknown: 'allow' },
    profiles: {
      'claude-sonnet': { agent: 'claude', family: 'claude', args: ['--model', 'sonnet'] },
      'claude-review': { agent: 'claude', family: 'claude', args: ['--model', 'opus'] },
      'go-deepseek': { agent: 'senpi', family: 'deepseek', args: ['--provider', 'opencode-go', '--model', 'deepseek-v4.1-flash'] },
    },
    categories: {
      deep: ['go-deepseek', 'claude-sonnet'],
      reviewer: ['claude-review', 'go-deepseek'],
      quick: 'go-deepseek',
      writing: { profiles: ['go-deepseek'], preamble: 'preambles/w.md' },
    },
  },
  AGENTS,
)

const FACTS: SettleFacts = { hasResult: false, stallMs: 30_000, graceMs: 45_000 }
const base = () => newWorker({ name: 'w1-a', pane: 'w1:p2', profile: 'go-deepseek', family: 'deepseek', agent: 'senpi' })

describe('settle', () => {
  test('idle right after a dispatch is not completion', () => {
    let w = step(base(), { kind: 'dispatch', at: 0, task: 'T1', run: 'r' }, FACTS).worker
    const r = step(w, { kind: 'status', at: 100, status: 'idle' }, FACTS)
    expect(r.worker.phase).toBe('dispatched')
    expect(r.effects).toEqual([])
    w = step(r.worker, { kind: 'status', at: 500, status: 'working' }, FACTS).worker
    expect(w.phase).toBe('running')
  })

  test('working then idle with result.md finishes', () => {
    let w = step(base(), { kind: 'dispatch', at: 0, task: 'T1', run: 'r' }, FACTS).worker
    w = step(w, { kind: 'status', at: 1, status: 'working' }, FACTS).worker
    const r = step(w, { kind: 'status', at: 2, status: 'idle' }, { ...FACTS, hasResult: true })
    expect(r.worker.phase).toBe('finished')
    expect(r.effects).toEqual([{ type: 'settled', phase: 'finished' }])
  })

  test('working then idle without result.md waits the grace period, then alerts', () => {
    let w = step(base(), { kind: 'dispatch', at: 0, task: 'T1', run: 'r' }, FACTS).worker
    w = step(w, { kind: 'status', at: 1000, status: 'working' }, FACTS).worker
    const idle = step(w, { kind: 'status', at: 2000, status: 'done' }, FACTS)
    expect(idle.worker.phase).toBe('checking')
    expect(idle.effects).toEqual([{ type: 'timer', ms: 45_000 }])
    const early = step(idle.worker, { kind: 'tick', at: 30_000 }, FACTS)
    expect(early.worker.phase).toBe('checking')
    const late = step(early.worker, { kind: 'tick', at: 47_000 }, FACTS)
    expect(late.worker.phase).toBe('idle-no-result')
    expect(late.effects).toEqual([{ type: 'alert', phase: 'idle-no-result' }])
  })

  test('result.md landing during the grace period finishes on the next tick', () => {
    let w = step(base(), { kind: 'dispatch', at: 0, task: 'T1', run: 'r' }, FACTS).worker
    w = step(w, { kind: 'status', at: 1, status: 'working' }, FACTS).worker
    w = step(w, { kind: 'status', at: 2, status: 'idle' }, FACTS).worker
    const r = step(w, { kind: 'tick', at: 10_000 }, { ...FACTS, hasResult: true })
    expect(r.worker.phase).toBe('finished')
  })

  test('no working within the stall time is a stall; working later recovers', () => {
    const d = step(base(), { kind: 'dispatch', at: 0, task: 'T1', run: 'r' }, FACTS)
    expect(d.effects).toEqual([{ type: 'timer', ms: 30_000 }])
    const s = step(d.worker, { kind: 'tick', at: 30_000 }, FACTS)
    expect(s.worker.phase).toBe('stalled')
    expect(s.effects).toEqual([{ type: 'alert', phase: 'stalled' }])
    const r = step(s.worker, { kind: 'status', at: 31_000, status: 'working' }, FACTS)
    expect(r.worker.phase).toBe('running')
    expect(r.effects).toEqual([{ type: 'recovered' }])
  })

  test('blocked alerts once, and counts as the prompt having arrived', () => {
    const d = step(base(), { kind: 'dispatch', at: 0, task: 'T1', run: 'r' }, FACTS).worker
    const b = step(d, { kind: 'status', at: 1, status: 'blocked' }, FACTS)
    expect(b.worker.phase).toBe('blocked')
    expect(b.effects).toEqual([{ type: 'alert', phase: 'blocked' }])
    expect(step(b.worker, { kind: 'status', at: 2, status: 'blocked' }, FACTS).effects).toEqual([])
    const idle = step(b.worker, { kind: 'status', at: 3, status: 'idle' }, FACTS)
    expect(idle.worker.phase).toBe('checking')
  })

  test('the pane going away mid-task alerts, unless the result is there', () => {
    let w = step(base(), { kind: 'dispatch', at: 0, task: 'T1', run: 'r' }, FACTS).worker
    w = step(w, { kind: 'status', at: 1, status: 'working' }, FACTS).worker
    expect(step(w, { kind: 'status', at: 2, status: 'gone' }, FACTS).effects).toEqual([{ type: 'alert', phase: 'gone' }])
    expect(step(w, { kind: 'status', at: 2, status: 'gone' }, { ...FACTS, hasResult: true }).worker.phase).toBe('finished')
    expect(step(base(), { kind: 'status', at: 2, status: 'gone' }, FACTS).effects).toEqual([])
  })

  test('a stalled worker whose `working` was missed finishes on idle with its report', () => {
    const d = step(base(), { kind: 'dispatch', at: 0, task: 'T1', run: 'r' }, FACTS).worker
    const stalled = step(d, { kind: 'tick', at: 31_000 }, FACTS).worker
    expect(stalled.phase).toBe('stalled')
    expect(step(stalled, { kind: 'status', at: 40_000, status: 'idle' }, FACTS).worker.phase).toBe('stalled')
    const r = step(stalled, { kind: 'status', at: 40_000, status: 'idle' }, { ...FACTS, hasResult: true })
    expect(r.worker.phase).toBe('finished')
    expect(r.effects).toEqual([{ type: 'recovered' }, { type: 'settled', phase: 'finished' }])
  })

  test('idle-no-result recovers when the worker works again or its report lands', () => {
    let w = step(base(), { kind: 'dispatch', at: 0, task: 'T1', run: 'r' }, FACTS).worker
    w = step(w, { kind: 'status', at: 1, status: 'working' }, FACTS).worker
    w = step(w, { kind: 'status', at: 2, status: 'idle' }, FACTS).worker
    w = step(w, { kind: 'tick', at: 50_000 }, FACTS).worker
    expect(w.phase).toBe('idle-no-result')
    const back = step(w, { kind: 'status', at: 60_000, status: 'working' }, FACTS)
    expect(back.worker.phase).toBe('running')
    expect(back.effects).toEqual([{ type: 'recovered' }])
    const late = step(w, { kind: 'tick', at: 60_000 }, { ...FACTS, hasResult: true })
    expect(late.worker.phase).toBe('finished')
    expect(late.effects).toEqual([{ type: 'recovered' }, { type: 'settled', phase: 'finished' }])
    // Without a task (closed by the lead) nothing comes back.
    expect(step({ ...w, task: null }, { kind: 'status', at: 60_000, status: 'working' }, FACTS).worker.phase).toBe('idle-no-result')
  })
})

describe('route', () => {
  const allOk = () => true as const
  test('takes the first profile in order', () => {
    const r = pickProfile(CFG, 'deep', { intent: 'implement', avoidFamilies: [], quotaOk: allOk })
    expect(r.ok && r.profile).toBe('go-deepseek')
  })
  test('skips a provider out of quota', () => {
    const r = pickProfile(CFG, 'deep', { intent: 'implement', avoidFamilies: [], quotaOk: p => (p === 'go-deepseek' ? 'opencode-go quota exhausted' : true) })
    expect(r.ok && r.profile).toBe('claude-sonnet')
  })
  test('a reviewer avoids the author family', () => {
    const r = pickProfile(CFG, 'deep', { intent: 'review', avoidFamilies: ['deepseek'], quotaOk: allOk })
    expect(r.ok && r.profile).toBe('claude-sonnet')
  })
  test('falls back to an avoided family with a warning when nothing else has quota', () => {
    const r = pickProfile(CFG, 'quick', { intent: 'implement', avoidFamilies: ['deepseek'], quotaOk: allOk })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.warnings.join(' ')).toContain('outside families')
  })
  test('fails when every candidate is out', () => {
    const r = pickProfile(CFG, 'quick', { intent: 'implement', avoidFamilies: [], quotaOk: () => false })
    expect(r.ok).toBe(false)
  })
  test('unknown category', () => {
    expect(pickProfile(CFG, 'nope', { intent: null, avoidFamilies: [], quotaOk: allOk }).ok).toBe(false)
  })
  test('intent gate pairs', () => {
    expect(isUsualPair('implement', 'deep')).toBe(true)
    expect(isUsualPair('explore', 'deep')).toBe(false)
  })
  test('category shapes normalize', () => {
    expect(CFG.categories.quick).toEqual({ profiles: ['go-deepseek'], preamble: null })
    expect(CFG.categories.writing!.preamble).toBe('preambles/w.md')
  })
})

describe('plan', () => {
  const cats = Object.keys(CFG.categories)
  const good = {
    goal: 'add orders',
    waves: [
      { id: 1, gate: 'tests pass', tasks: [
        { id: 'T1', title: 'api', intent: 'implement', category: 'deep', owns: ['./src/api/'], deps: [] },
        { id: 'T2', title: 'db', intent: 'implement', category: 'quick', owns: ['src/db.ts'] },
      ] },
      { id: 2, gate: 'review ok', tasks: [{ id: 'T3', title: 'review', intent: 'review', category: 'reviewer', deps: ['T1'] }] },
    ],
  }
  test('accepts a valid plan and normalizes paths', () => {
    const r = parsePlan(good, cats)
    expect('plan' in r).toBe(true)
    if ('plan' in r) expect(findTask(r.plan, 'T1')?.task.owns).toEqual(['src/api'])
  })
  test('the scout- prefix is reserved for scouts', () => {
    const bad = { goal: 'x', waves: [{ id: 1, gate: 'g', tasks: [{ id: 'scout-api', intent: 'explore', category: 'explore' }] }] }
    const r = parsePlan(bad, cats)
    expect('errors' in r && r.errors.join('\n')).toContain('reserved for scouts')
    expect(isScout('scout-api')).toBe(true)
    expect(isScout('T1')).toBe(false)
    expect(SCOUT_ID.test('scout-api.v2')).toBe(true)
    expect(SCOUT_ID.test('scout-')).toBe(false)
    expect(SCOUT_ID.test('scout-a/b')).toBe(false)
  })
  test('rejects overlapping ownership in one wave', () => {
    const bad = { ...good, waves: [{ id: 1, gate: 'g', tasks: [
      { id: 'A', intent: 'implement', category: 'deep', owns: ['src'] },
      { id: 'B', intent: 'implement', category: 'deep', owns: ['src/x.ts'] },
    ] }] }
    const r = parsePlan(bad, cats)
    expect('errors' in r && r.errors.join('\n')).toContain('owned by both')
  })
  test('rejects deps on the same or a later wave, unknown categories and intents, missing gates', () => {
    const bad = { goal: 'x', waves: [{ id: 1, gate: '', tasks: [
      { id: 'A', intent: 'build', category: 'nope', deps: ['B'] },
      { id: 'B', intent: 'implement', category: 'deep' },
    ] }] }
    const r = parsePlan(bad, cats)
    const text = 'errors' in r ? r.errors.join('\n') : ''
    expect(text).toContain('"gate" is required')
    expect(text).toContain('"intent" must be one of')
    expect(text).toContain("unknown category 'nope'")
    expect(text).toContain('must be in an earlier wave')
  })
  test('plan.md counts as approved only as it was when approved', () => {
    const md = '# Orders API\n\n- T1 orders endpoint: npm test passes\n'
    const digest = draftDigest(md)
    expect(isApproved(md, `${digest}\n`)).toBe(true)
    // Whitespace at the ends does not matter; any other change does.
    expect(isApproved(`\n${md}\n\n`, digest)).toBe(true)
    expect(isApproved(md.replace('T1', 'T2'), digest)).toBe(false)
    expect(isApproved(md, null)).toBe(false)
    expect(isApproved(null, digest)).toBe(false)
    expect(isApproved('   ', draftDigest('   '))).toBe(false)
  })
  test('task status and wave progress', () => {
    const r = parsePlan(good, cats)
    if (!('plan' in r)) throw new Error('plan')
    const facts: Record<string, Partial<TaskFacts>> = {
      T1: { dispatched: true, hasResult: true },
      T2: { dispatched: true, phase: 'blocked' },
    }
    const view = runView('r1', '/x', r.plan, new Set(), id => ({ dispatched: false, hasResult: false, verified: false, abandoned: false, worker: null, profile: null, phase: null, note: null, ...facts[id] }))
    expect(view.current).toBe(1)
    expect(view.waves[0]!.tasks.map(t => t.status)).toEqual(['reported', 'blocked'])
    expect(waveProgress(view)).toEqual({ wave: 1, done: 1, total: 2, alerts: 1 })
    expect(taskStatus({ dispatched: true, hasResult: false, verified: false, abandoned: false, worker: null, profile: null, phase: null, note: null })).toBe('alert')
    const passed = runView('r1', '/x', r.plan, new Set([1]), () => ({ dispatched: false, hasResult: false, verified: false, abandoned: false, worker: null, profile: null, phase: null, note: null }))
    expect(passed.current).toBe(2)
  })
  test('the status file a custom status line reads', () => {
    const r = parsePlan(good, cats)
    if (!('plan' in r)) throw new Error('plan')
    const none = { dispatched: false, hasResult: false, verified: false, abandoned: false, worker: null, profile: null, phase: null, note: null }
    const facts: Record<string, Partial<TaskFacts>> = { T1: { dispatched: true, hasResult: true }, T2: { dispatched: true, phase: 'blocked' } }
    const view = runView('r1', '/x', r.plan, new Set(), id => ({ ...none, ...facts[id] }))
    const total = view.waves.flatMap(w => w.tasks).length
    const file = statusFile(view, new Date('2026-11-14T00:00:00Z'))
    expect(file).toEqual({
      version: 1,
      run: 'r1',
      goal: view.goal,
      wave: 1,
      waves: view.waves.length,
      done: 0,
      total,
      alerts: 1,
      wave_done: 1,
      wave_total: 2,
      line: `░░░░░░ 0/${total} ⚠1`,
      updated_at: '2026-11-14T00:00:00.000Z',
      stage: 'running',
    })
    // Every task closed but the last gate open: the run is not done yet.
    const lastOpen = new Set(view.waves.slice(0, -1).map(w => w.id))
    const closed = statusFile(runView('r1', '/x', r.plan, lastOpen, () => ({ ...none, dispatched: true, hasResult: true, verified: true })), new Date())!
    const last = view.waves[view.waves.length - 1]!.tasks.length
    expect(closed.done).toBe(total - last)
    expect(closed.line.endsWith(` ${total - last}/${total}`)).toBe(true)
    expect(closed.wave_done).toBe(last)
    // Every gate passed: nothing to show, and the mod removes the file.
    const gates = new Set(view.waves.map(w => w.id))
    expect(statusFile(runView('r1', '/x', r.plan, gates, () => none), new Date())).toBe(null)
  })
})

describe('runs and categories by name', () => {
  const now = new Date(2026, 10, 17, 20, 5)
  test('a draft name becomes a dated run id; a dated one is kept', () => {
    expect(planRunId('Model groups & inheritance', now)).toBe('20261117-model-groups-inheritance')
    expect(planRunId('20261116-helm-values', now)).toBe('20261116-helm-values')
    expect(planRunId('  ---  ', now)).toBe(null)
    expect(planRunId('x'.repeat(80), now)!.length).toBe(9 + 40)
  })

  test('an unknown category names the closest one, and says when it is an intent', () => {
    const known = ['oracle', 'deep', 'visual-engineering', 'reviewer', 'quick']
    expect(closestName('review', known)).toBe('reviewer')
    expect(closestName('qiuck', known)).toBe('quick')
    expect(closestName('frontend', known)).toBe(null)
    const msg = unknownCategory('review', known)
    expect(msg).toContain("did you mean 'reviewer'?")
    expect(msg).toContain("'review' is an intent")
    expect(unknownCategory('frontend', known)).not.toContain('did you mean')
  })

  test('parsePlan carries the hint', () => {
    const r = parsePlan({ goal: 'g', waves: [{ id: 1, gate: 'tests', tasks: [{ id: 'T1', title: 't', intent: 'review', category: 'review', owns: [], deps: [] }] }] }, ['deep', 'reviewer'])
    expect('errors' in r && r.errors.join('\n')).toContain("did you mean 'reviewer'?")
  })

  test('a run being planned has a status file too', () => {
    const f = planningStatusFile('20261117-x', 'Plan: x', 'draft', new Date('2026-11-17T00:00:00Z'))
    expect(f).toMatchObject({ run: '20261117-x', goal: 'Plan: x', stage: 'draft', line: '✎ plan draft', total: 0 })
    expect(planningStatusFile('r', 'g', 'approved', new Date()).line).toBe('✓ plan approved')
  })
})

describe('quota', () => {
  const claude = parseClaude(CLAUDE_USAGE)
  const go = parseOpencodeGo(OPENCODE_GO_USAGE)
  const snap = (provider: string, p: ReturnType<typeof parseClaude>): OmhQuota => ({ provider, checkedAt: 0, error: null, source: 'test', ...p })

  test('parses the Claude usage response', () => {
    expect(claude.windows.find(w => w.name === '5h')?.usedPercent).toBe(29)
    expect(claude.windows.find(w => w.name === 'weekly_scoped')?.scope).toBe('fable')
  })
  test('parses the OpenCode Go usage response', () => {
    expect(go.windows.map(w => w.name)).toEqual(['rolling', 'weekly', 'monthly'])
    expect(go.limitReached).toBe(false)
    expect(parseOpencodeGo({ usage: { rolling: { status: 'exceeded', percent: 100 } } }).limitReached).toBe(true)
  })
  test('per-model windows only count for that model', () => {
    const q = snap('claude', { windows: [...claude.windows, { name: '7d-opus', usedPercent: 99, resetsAt: null, scope: 'opus' }], limitReached: false })
    expect(evaluate(q, 95, '--model sonnet').status).toBe('ok')
    expect(evaluate(q, 95, '--model opus').status).toBe('exhausted')
  })
  test('providers and permission', () => {
    expect(providerOf(CFG.profiles['go-deepseek']!)).toBe('opencode-go')
    expect(providerOf(CFG.profiles['claude-sonnet']!)).toBe('claude')
    const hot = snap('opencode-go', { windows: [{ name: 'weekly', usedPercent: 97, resetsAt: null, scope: null }], limitReached: false })
    expect(quotaAllows(CFG, { 'opencode-go': hot }, 'go-deepseek')).toContain('exhausted')
    expect(quotaAllows(CFG, {}, 'go-deepseek')).toBe(true) // unknown + on_unknown=allow
    const strict = { ...CFG, quota: { ...CFG.quota, onUnknown: 'block' as const } }
    expect(quotaAllows(strict, {}, 'go-deepseek')).toContain('on_unknown=block')
  })
})

describe('diagnose', () => {
  const run = (agent: string, screen: string, extra: Partial<Parameters<typeof diagnose>[0]> = {}) =>
    diagnose({ agent, phase: 'blocked', screen, hasResult: false, quotaExhausted: null, at: 0, ...extra })

  test('the folder-trust prompt of a fresh Claude worker', () => {
    const screen = [
      ' Accessing workspace:',
      ' /home/u/codes/github/oh-my-herdr',
      ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open',
      ' ❯ No, exit',
      '   Yes, I trust this folder',
    ].join('\n')
    expect(run('claude', screen).verdict).toBe('permission-prompt')
  })
  test('quota messages win over everything else', () => {
    expect(run('claude', "You've hit your usage limit · resets 3pm\nDo you want to proceed?").verdict).toBe('quota-exhausted')
  })
  test('config errors', () => {
    expect(run('senpi', 'Error: Unknown model "deepseek-v9"').verdict).toBe('config-error')
  })
  test('a senpi worker on a model that does not exist (its extension list mentions pi-quotas)', () => {
    const screen = [
      '[Extensions]',
      '  @latentminds/pi-quotas:src/extensions/command-quotas, @latentminds/pi-quotas:src/extensions/command-tokens,',
      '@latentminds/pi-quotas:src/extensions/core, @latentminds/pi-quotas:src/extensions/quota-warnings,',
      ' Warning: Thinking level "low" is not available on opencode-go/deepseek-does-not-exist; using "max".',
      ' Error: 400: {"type":"server_error","message":"Upstream request failed: Model is unavailable."}',
      ' The model provider could not complete the request after 5 retries. Try again or choose another model with',
      ' /model. (ctrl+o for details)',
      ' Error: The provider rejected the request as invalid. Action: report it with the code.',
      '5h:$0.00 · wk:$0.00 · mo:$0.00 usage unavailable',
    ].join('\n')
    const d = run('senpi', screen, { phase: 'idle-no-result' })
    expect(d.verdict).toBe('config-error')
    expect(d.evidence).toContain('Model is unavailable')
  })
  test('quota snapshot when the screen says nothing', () => {
    expect(run('senpi', 'just some output', { quotaExhausted: 'opencode-go weekly 99%' }).verdict).toBe('quota-exhausted')
  })
  test('a result that arrived late', () => {
    expect(run('senpi', '', { hasResult: true }).verdict).toBe('finished-late')
  })
  test('gone without anything recognisable is a crash; otherwise unknown with the screen', () => {
    expect(run('senpi', '', { phase: 'gone' }).verdict).toBe('crashed')
    const u = run('senpi', 'thinking about it')
    expect(u.verdict).toBe('unknown')
    expect(u.evidence).toContain('thinking')
  })
  test('rules from agents.json extend the defaults', () => {
    expect(run('senpi', 'BUDGET GONE', { rules: { 'quota-exhausted': ['BUDGET GONE'] } }).verdict).toBe('quota-exhausted')
  })
})

describe('guards', () => {
  test('relative paths', () => {
    expect(relativeTo('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/repo', '/elsewhere/a.ts')).toBe(null)
    expect(relativeTo('/repo', './src/a.ts')).toBe('src/a.ts')
  })
  test('a running task owns its files; a reported one does not', () => {
    const r = parsePlan({ goal: 'g', waves: [{ id: 1, gate: 'g', tasks: [{ id: 'T1', intent: 'implement', category: 'deep', owns: ['src/api'] }] }] }, ['deep'])
    if (!('plan' in r)) throw new Error('plan')
    const mk = (f: Partial<TaskFacts>) => runView('r', '/x', r.plan, new Set(), () => ({ dispatched: true, hasResult: false, verified: false, abandoned: false, worker: 'w1', profile: 'p', phase: 'running', note: null, ...f }))
    expect(ownerOf('src/api/x.ts', r.plan, mk({}))?.task).toBe('T1')
    expect(ownerOf('src/other.ts', r.plan, mk({}))).toBe(null)
    expect(ownerOf('src/api/x.ts', r.plan, mk({ hasResult: true }))).toBe(null)
  })
})

describe('status', () => {
  test('the short form: current wave in detail, other waves and idle workers folded', () => {
    const run = {
      id: '20261114-1200-orders',
      dir: '/work/.omh/runs/20261114-1200-orders',
      goal: 'Orders API',
      current: 2,
      waves: [
        { id: 1, gate: 'explore done', gatePassed: true, tasks: [{ id: 'T1', title: 'map', category: 'explore', status: 'verified' as const, worker: 'w1', profile: 'go-fast', note: 'solid' }] },
        {
          id: 2,
          gate: 'npm test passes',
          gatePassed: false,
          tasks: [
            { id: 'T2', title: 'endpoint', category: 'deep', status: 'working' as const, worker: 'w2', profile: 'go-deepseek', note: null },
            { id: 'T3', title: 'docs', category: 'writing', status: 'alert' as const, worker: 'w3', profile: 'go-deepseek', note: 'crashed' },
          ],
        },
        { id: 3, gate: 'review clean', gatePassed: false, tasks: [{ id: 'T4', title: 'review', category: 'reviewer', status: 'pending' as const, worker: null, profile: null, note: null }] },
      ],
    }
    const base = { pane: 'p', profile: 'go-fast', family: 'deepseek', agent: 'senpi' }
    const workers = {
      w1: newWorker({ name: 'w1', ...base }),
      w2: { ...newWorker({ name: 'w2', ...base }), phase: 'running' as const, task: 'T2' },
    }
    expect(statusBrief(run, workers)).toBe(
      [
        '**Orders API** · W2/3 · 1/4 closed · ⚠ 1',
        '',
        '- ✓ W1 gate passed (1 task)',
        '- ▶ **W2** 0/2 · gate: npm test passes',
        '  - 🔄 T2 endpoint → w2',
        '  - ❗ T3 docs → w3 · crashed',
        '- · W3 0/1',
        '',
        'Workers: w2 running, 1 idle',
      ].join('\n'),
    )
    expect(statusBrief(null, {})).toBe('No run in progress. /ulw <goal> starts one.')
  })
})

describe('scouts and ulw', () => {
  test('the scouts wake-up lists each scout and what to do next', () => {
    const text = scoutsText([
      { id: 'scout-api', worker: 'scout-api (go-fast)', state: 'reported', detail: 'result.md written' },
      { id: 'scout-docs', worker: 'scout-docs (go-fast)', state: 'idle-no-result', detail: 'crashed: a|b' },
    ])
    expect(text).toContain('| scout-api | scout-api (go-fast) | reported | result.md written |')
    expect(text).toContain('crashed: a/b')
    expect(text).toContain('`omh_collect` each one (scout-api)')
    expect(text).toContain('Without a report: scout-docs')
  })
  test('the ulw prompt invites parallel Explore subagents and scouts', () => {
    const text = ulwPrompt('orders')
    expect(text).toContain('Goal: orders')
    expect(text).toContain('`Explore`')
    expect(text).toContain('scout-<name>')
  })
  test('the ulw prompt names only the subagents the config allows, or none', () => {
    expect(ulwPrompt('o', ['Explore · haiku'])).toContain('only these (type · model, as the config routes them): Explore · haiku')
    const none = ulwPrompt('o', [])
    expect(none).toContain('No Claude Code subagents')
    expect(none).toContain('scout-<name>')
  })
})

describe('quota of your own (a command)', () => {
  const OWN = normalizeConfig(
    '/cfg/config.json',
    {
      quota: { threshold: 90, providers: { openrouter: '~/q/openrouter.sh', claude: { enabled: true }, off: { enabled: false } } },
      profiles: {
        'or-qwen': { agent: 'senpi', family: 'qwen', quota: 'openrouter', args: ['--provider', 'openrouter'] },
        typo: { agent: 'senpi', family: 'x', quota: 'openroutr' },
      },
      categories: { quick: ['or-qwen'] },
    },
    AGENTS,
  )

  test('a string is the command; the provider joins the built-in ones', () => {
    expect(OWN.quota.providers.openrouter).toEqual({ command: '~/q/openrouter.sh' })
    expect(OWN.quota.providers.claude).toEqual({ enabled: true })
    expect(providersOf(OWN)).toEqual(['claude', 'opencode-go', 'openrouter'])
    expect(providerOf(OWN.profiles['or-qwen']!)).toBe('openrouter')
    expect(configProblems(OWN)).toEqual([`profile 'typo' bills quota 'openroutr', which is neither built in nor given a "command" under quota.providers`])
  })

  test('the command prints a percent, or windows by name', () => {
    expect(parseCommandQuota('42\n').windows).toEqual([{ name: 'usage', usedPercent: 42, resetsAt: null, scope: null }])
    expect(parseCommandQuota('{"daily": 42.5, "weekly": 9, "note": "x"}').windows.map(w => `${w.name}=${w.usedPercent}`)).toEqual(['daily=42.5', 'weekly=9'])
    expect(() => parseCommandQuota('{}')).toThrow()
    expect(() => parseCommandQuota('"lots"')).toThrow()
    expect(() => parseCommandQuota('not json')).toThrow()
  })

  test('routing skips a profile whose command reports it over the threshold', () => {
    const now = Date.now()
    const snap = (pct: number): Record<string, OmhQuota> => ({
      openrouter: { provider: 'openrouter', checkedAt: now, windows: [{ name: 'daily', usedPercent: pct, resetsAt: null, scope: null }], limitReached: false, error: null, source: 'command' },
    })
    expect(quotaAllows(OWN, snap(40), 'or-qwen')).toBe(true)
    expect(quotaAllows(OWN, snap(95), 'or-qwen')).toBe('openrouter quota exhausted: daily 95% (resets ?)')
    expect(formatQuota(OWN, snap(40))).toContain('| openrouter | ✅ ok | daily 40% | command |')
  })

  test('probe runs the command with sh -c; a failure is unknown with its reason', async () => {
    const ran: string[][] = []
    const engine = (exitCode: number, stdout: string, stderr = '') =>
      ({ clock: { now: async () => 1 }, process: { run: async (argv: string[]) => (ran.push(argv), { exitCode, stdout, stderr }) } }) as never
    const ok = await probe(engine(0, '{"daily": 12}'), 'openrouter', '~/q/openrouter.sh')
    expect(ran[0]).toEqual(['sh', '-c', '~/q/openrouter.sh'])
    expect(ok.error).toBe(null)
    expect(ok.windows[0]!.usedPercent).toBe(12)
    expect((await probe(engine(2, '', 'no API key\nmore'), 'openrouter', 'x')).error).toBe('command exited 2: no API key')
    expect((await probe(engine(0, 'hello'), 'openrouter', 'x')).error).toContain('command printed no usage')
    expect((await probe(engine(0, '1'), 'nameless')).error).toBe(`no "command" for 'nameless' under quota.providers`)
  })
})

describe('markdown answers', () => {
  test('cells never break a row', () => {
    expect(cell('a | b\nc')).toBe('a \\| b c')
    expect(cell('')).toBe(' ')
    expect(table(['A', 'B'], [['1', 'x|y']])).toBe('| A | B |\n|---|---|\n| 1 | x\\|y |')
  })

  test('/omh quota: a settings line, then a table a plugin prefix cannot break', () => {
    const now = Date.now()
    const q: Record<string, OmhQuota> = {
      claude: { provider: 'claude', checkedAt: now, windows: [{ name: '5h', usedPercent: 57, resetsAt: null, scope: null }], limitReached: false, error: null, source: 'Claude Code' },
    }
    const lines = formatQuota(CFG, q).split('\n')
    expect(lines[0]).toBe('Quota · skip a provider at 95% · cached 120s · unknown usage: allow')
    expect(lines[1]).toBe('')
    expect(lines[2]).toBe('| Provider | Status | Usage | Read via |')
    expect(lines.find(l => l.startsWith('| claude |'))).toContain('| ✅ ok | 5h 57%')
    expect(lines.find(l => l.startsWith('| claude |'))).toContain('| Claude Code |')
  })

  test('the full board is a table per wave and one of workers', () => {
    const run = {
      id: 'r1', dir: '/w/.omh/runs/r1', goal: 'Orders API', current: 1,
      waves: [{ id: 1, gate: 'tests pass', gatePassed: false, tasks: [{ id: 'T1', title: 'a | b', category: 'quick', status: 'working' as const, worker: 'w1', profile: 'sub-haiku', note: null }] }],
    }
    const w1 = { ...newWorker({ name: 'w1', pane: 'agent:ag1', profile: 'sub-haiku', family: 'claude', agent: 'subagent' }), phase: 'running' as const, task: 'T1' }
    const text = statusText(run, { w1 })
    expect(text.split('\n')[0]).toBe('Run `r1`: Orders API')
    expect(text).toContain('### Wave 1 · 0/1 closed · ◀ current')
    expect(text).toContain('| 🔄 T1 | working | a \\| b | w1 (sub-haiku) |')
    expect(text).toContain('| w1 | running | sub-haiku | claude | ◆ subagent ag1 | T1 |')
  })
})

describe('worker pane layout', () => {
  const tab = (id: string, count: number | null, freeRoot: string | null = null) => ({ tab: id, freeRoot, count, lastPane: count ? `${id}:last` : null })
  test('no tab yet: open omh-workers', () => {
    expect(place([], 4)).toEqual({ kind: 'new-tab', label: 'omh-workers' })
  })
  test('a fresh tab hands out its root pane first', () => {
    expect(place([tab('t1', 1, 'w1:p9')], 4)).toEqual({ kind: 'root', tab: 't1', pane: 'w1:p9' })
  })
  test('then splits the last pane, right and down in turn', () => {
    expect(place([tab('t1', 1)], 4)).toEqual({ kind: 'split', tab: 't1', anchor: 't1:last', direction: 'right' })
    expect(place([tab('t1', 2)], 4)).toEqual({ kind: 'split', tab: 't1', anchor: 't1:last', direction: 'down' })
    expect(place([tab('t1', 3)], 4)).toEqual({ kind: 'split', tab: 't1', anchor: 't1:last', direction: 'right' })
  })
  test('a full tab sends the next worker to the next tab with room, else a new one', () => {
    expect(place([tab('t1', 4), tab('t2', 2)], 4)).toEqual({ kind: 'split', tab: 't2', anchor: 't2:last', direction: 'down' })
    expect(place([tab('t1', 4)], 4)).toEqual({ kind: 'new-tab', label: 'omh-workers-2' })
    expect(place([tab('t1', 4), tab('t2', 4)], 4)).toEqual({ kind: 'new-tab', label: 'omh-workers-3' })
  })
  test('room freed by a torn-down worker is used again; a closed tab is skipped', () => {
    expect(place([tab('t1', 3), tab('t2', 4)], 4).kind === 'split' && (place([tab('t1', 3), tab('t2', 4)], 4) as any).tab).toBe('t1')
    expect(place([tab('t1', null), tab('t2', 1)], 4)).toEqual({ kind: 'split', tab: 't2', anchor: 't2:last', direction: 'right' })
    expect(place([tab('t1', null)], 4)).toEqual({ kind: 'new-tab', label: 'omh-workers' })
  })
  test('a cap of 1 gives every worker a tab of its own', () => {
    expect(place([tab('t1', 1)], 1)).toEqual({ kind: 'new-tab', label: 'omh-workers-2' })
    expect(place([tab('t1', 1)], 0)).toEqual({ kind: 'new-tab', label: 'omh-workers-2' })
  })
})

describe('subagent workers', () => {
  const SUB_CFG = normalizeConfig(
    '/cfg/config.json',
    {
      profiles: {
        'sub-explore': { agent: 'subagent', family: 'claude', subagent_type: 'Explore', model: 'haiku' },
        'sub-any': { agent: 'subagent', family: 'claude' },
        'go-fast': { agent: 'senpi', family: 'deepseek', args: ['--provider', 'opencode-go'] },
      },
      categories: { explore: ['sub-explore', 'go-fast'] },
    },
    { ...AGENTS, subagent: { launch: 'subagent' } },
  )

  test('a subagent profile reads its model and type, defaults the type, and bills claude', () => {
    expect(SUB_CFG.agents.subagent!.launch).toBe('subagent')
    expect(SUB_CFG.profiles['sub-explore']).toEqual({ agent: 'subagent', family: 'claude', args: [], model: 'haiku', subagentType: 'Explore' })
    expect(SUB_CFG.profiles['sub-any']!.subagentType).toBe('general-purpose')
    expect(SUB_CFG.profiles['go-fast']!.subagentType).toBe(undefined)
    expect(isSubagentProfile(SUB_CFG, 'sub-explore')).toBe(true)
    expect(isSubagentProfile(SUB_CFG, 'go-fast')).toBe(false)
    expect(providerOf(SUB_CFG.profiles['sub-explore']!)).toBe('claude')
    expect(configProblems(SUB_CFG)).toEqual([])
  })

  test("a subagent's model meets its per-model window", () => {
    const now = Date.now()
    const q: Record<string, OmhQuota> = {
      claude: { provider: 'claude', checkedAt: now, windows: [{ name: '5h', usedPercent: 10, resetsAt: null, scope: null }, { name: '7d-opus', usedPercent: 99, resetsAt: null, scope: 'opus' }], limitReached: false, error: null, source: 'x' },
    }
    const cfg = normalizeConfig('/c.json', { profiles: { 'sub-review': { agent: 'subagent', family: 'claude', model: 'opus' }, 'sub-haiku': { agent: 'subagent', family: 'claude', model: 'haiku' } } }, { subagent: { launch: 'subagent' } })
    expect(quotaAllows(cfg, q, 'sub-review')).toContain('7d-opus 99%')
    expect(quotaAllows(cfg, q, 'sub-haiku')).toBe(true)
  })

  test('routing takes a subagent first, and skips it when Claude is out of quota', () => {
    const first = pickProfile(SUB_CFG, 'explore', { intent: 'explore', avoidFamilies: [], quotaOk: () => true })
    expect(first.ok && first.profile).toBe('sub-explore')
    const out = pickProfile(SUB_CFG, 'explore', { intent: 'explore', avoidFamilies: [], quotaOk: p => (isSubagentProfile(SUB_CFG, p) ? 'claude at 97%' : true) })
    expect(out.ok && out.profile).toBe('go-fast')
  })

  test('the pane spells the agent id', () => {
    const w = newWorker({ name: 'scout-a', pane: subagentPane('a1b2'), profile: 'sub-explore', family: 'claude', agent: 'subagent' })
    expect(isSubagentWorker(w)).toBe(true)
    expect(subagentIdOf(w)).toBe('a1b2')
    expect(subagentIdOf({ pane: 'w1:p3' })).toBe(null)
  })

  test('agent statuses and end reasons map onto the state machine', () => {
    expect(['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed', undefined, 'odd'].map(settleStatusOf)).toEqual([
      'working', 'working', 'blocked', 'done', 'done', 'gone', 'gone', 'gone', 'unknown',
    ])
    expect(endStatusOf('answer')).toBe('done')
    expect(endStatusOf('aborted')).toBe('gone')
  })

  test('a subagent that ends without a report finishes as checking, then alerts; one with a report finishes', () => {
    const w = newWorker({ name: 's', pane: subagentPane('x'), profile: 'sub-any', family: 'claude', agent: 'subagent' })
    const facts = (hasResult: boolean): SettleFacts => ({ hasResult, stallMs: 30_000, graceMs: 45_000 })
    let s = step(w, { kind: 'dispatch', at: 0, task: 'scout-a', run: '_scouts' }, facts(false))
    s = step(s.worker, { kind: 'status', status: 'working', at: 1 }, facts(false))
    const done = step(s.worker, { kind: 'status', status: endStatusOf('answer'), at: 2 }, facts(true))
    expect(done.worker.phase).toBe('finished')
    const dead = step(s.worker, { kind: 'status', status: endStatusOf('aborted'), at: 2 }, facts(false))
    expect(dead.worker.phase).toBe('gone')
    expect(dead.effects).toEqual([{ type: 'alert', phase: 'gone' }])
  })

  test('diagnosis reads the end reason and the answer instead of a screen', () => {
    const at = 1
    const base = { agent: 'subagent', phase: 'gone' as const, hasResult: false, quotaExhausted: null, at }
    expect(diagnose({ ...base, screen: subagentScreen({ reason: 'aborted', answer: '' }, undefined) }).verdict).toBe('interrupted')
    expect(diagnose({ ...base, screen: subagentScreen({ reason: 'error', answer: 'API Error' }, 'failed') }).verdict).toBe('crashed')
    expect(diagnose({ ...base, screen: subagentScreen({ reason: 'answer', answer: "You've hit your limit · resets 5pm" }, 'completed') }).verdict).toBe('quota-exhausted')
    expect(diagnose({ ...base, phase: 'blocked', screen: subagentScreen(undefined, 'waiting') }).verdict).toBe('permission-prompt')
    expect(diagnose({ ...base, screen: subagentScreen({ reason: 'answer', answer: 'BLOCKED: no access to the repo' }, 'completed') }).evidence).toContain('BLOCKED')
  })
})

describe('run binding', () => {
  type Mem = Map<string, string>

  /** A run-binding host over the shared fake: herdr answers for the panes and tabs a test names. */
  function fakeHost(mem: Mem, opts: { panes?: Set<string>; tabs?: Record<string, string[]> } = {}) {
    return makeFakeHost({
      files: mem,
      subagent: { list: async () => [], spawn: async () => ({ deny: 'no subagents' }) },
      process: argv => {
        if (argv[0] !== 'herdr') return undefined
        const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })
        const no = { exitCode: 1, stdout: '', stderr: '' }
        const [, a, b, c] = argv
        if (a === 'pane' && b === 'get') return opts.panes?.has(c!) ? ok('{}') : no
        if (a === 'tab' && b === 'get') return opts.tabs?.[c!] ? ok(JSON.stringify({ result: { tab: { workspace_id: 'w1' } } })) : no
        if (a === 'pane' && b === 'list') {
          const panes = Object.entries(opts.tabs ?? {}).flatMap(([tab, ps]) => ps.map(pane_id => ({ tab_id: tab, pane_id })))
          return ok(JSON.stringify({ result: { panes } }))
        }
        return no
      },
    })
  }

  const plan = (id: string) => JSON.stringify({ goal: `goal ${id}`, waves: [{ id: 1, gate: 'g', tasks: [{ id: 'T1', title: 't', intent: 'implement', category: 'deep', owns: [], deps: [] }] }] })

  /** Two runs in the central .omh; current-run names a. */
  async function session(mem: Mem, opts: Parameters<typeof fakeHost>[1] = {}) {
    mem.set('/main/repo/.omh/current-run', 'a\n')
    for (const id of ['a', 'b']) {
      mem.set(`/main/repo/.omh/runs/${id}/draft.md`, `# Run ${id}\n`)
      mem.set(`/main/repo/.omh/runs/${id}/plan.json`, plan(id))
    }
    const saved = { $: rt.$, paths: rt.paths, cfg: rt.cfg, paneSeen: rt.paneSeen, wakeGuards: rt.wakeGuards, watchers: rt.watchers, options: rt.options, wakeTimer: rt.wakeTimer }
    rt.$ = fakeHost(mem, opts) as never
    rt.paneSeen = new Map()
    rt.wakeGuards = new Map()
    rt.watchers = new Map()
    rt.cfg = null
    rt.paths = new Paths('/main/repo', '/main/repo/.omh')
    return () => {
      for (const w of rt.watchers.values()) w.stopped = true
      Object.assign(rt, saved)
    }
  }

  test('Paths: .omh stays central while the root and the workers tab follow the bound run', () => {
    const p = new Paths('/wt/repo-b', '/main/repo/.omh', 'b')
    expect(p.root).toBe('/wt/repo-b')
    expect(p.omh).toBe('/main/repo/.omh')
    expect(p.tab).toBe('/main/repo/.omh/runs/b/tab.json')
    expect(p.runStatus('b')).toBe('/main/repo/.omh/runs/b/status.json')
    expect(p.status).toBe('/main/repo/.omh/status.json')
    expect(new Paths('/main/repo', '/main/repo/.omh').tab).toBe('/main/repo/.omh/tab.json')
  })

  test('a bound run wins in openRunId and currentRunId; unbound, current-run does', async () => {
    const mem: Mem = new Map([
      ['/m/.omh/current-run', 'a\n'],
      ['/m/.omh/runs/a/plan.json', plan('a')],
      ['/m/.omh/runs/b/draft.md', '# b'],
    ])
    const $ = fakeHost(mem) as never
    expect(await openRunId($, new Paths('/m', '/m/.omh'))).toBe('a')
    expect(await currentRunId($, new Paths('/m', '/m/.omh'))).toBe('a')
    const bound = new Paths('/wt', '/m/.omh', 'b')
    expect(await openRunId($, bound)).toBe('b')
    expect(await currentRunId($, bound)).toBe(null) // b has no plan.json yet
    mem.set('/m/.omh/runs/b/plan.json', plan('b'))
    expect(await currentRunId($, bound)).toBe('b')
    expect(await currentRunId($, new Paths('/m', '/m/.omh'))).toBe('a')
  })

  test('bindRun: a session bound to run b sees b while current-run names a; rebinding re-roots paths().root', async () => {
    const mem: Mem = new Map()
    const restore = await session(mem)
    try {
      expect(await openRunId(host(), paths())).toBe('a')
      await bindRun('b', '/wt/repo-b')
      expect(paths().root).toBe('/wt/repo-b')
      expect(paths().omh).toBe('/main/repo/.omh')
      expect(paths().tab).toBe('/main/repo/.omh/runs/b/tab.json')
      expect(await openRunId(host(), paths())).toBe('b')
      expect(await currentRunId(host(), paths())).toBe('b')
      expect(await host().state.bound.get()).toEqual({ run: 'b', root: '/wt/repo-b' })
      expect(mem.get('/main/repo/.omh/current-run')).toBe('a\n')

      await bindRun('a', '/wt/repo-a')
      expect(paths().root).toBe('/wt/repo-a')
      expect(await openRunId(host(), paths())).toBe('a')

      await unbindRun() // the same checkout as before: only the binding goes
      expect(paths().root).toBe('/wt/repo-a')
      expect(paths().boundRun).toBe(null)
      expect(paths().tab).toBe('/main/repo/.omh/tab.json')
      expect(await host().state.bound.get()).toEqual({ run: null })
    } finally {
      restore()
    }
  })

  test('.omh/status.json: only an unbound session writes the top-level fields; a bound one updates `runs` only', async () => {
    const mem: Mem = new Map()
    const restore = await session(mem)
    try {
      await refreshRun() // unbound: main's run (current-run = a) is on top
      expect(JSON.parse(mem.get('/main/repo/.omh/status.json')!).run).toBe('a')
      await bindRun('b', '/wt/repo-b')
      const summary = JSON.parse(mem.get('/main/repo/.omh/status.json')!)
      expect(summary.run).toBe('a') // not overwritten by the bound session
      expect(summary.goal).toBe('goal a')
      expect(summary.runs.map((r: { id: string }) => r.id)).toEqual(['a', 'b'])
      expect(summary.runs.find((r: { id: string }) => r.id === 'a')).toMatchObject({ goal: 'goal a', state: 'running', total: 1, done: 0 })
      expect(JSON.parse(mem.get('/main/repo/.omh/runs/b/status.json')!).run).toBe('b')
    } finally {
      restore()
    }
  })

  test('a bound session with no summary yet writes one with an empty top and its runs', async () => {
    const mem: Mem = new Map()
    const restore = await session(mem)
    try {
      await bindRun('b', '/wt/repo-b')
      const summary = JSON.parse(mem.get('/main/repo/.omh/status.json')!)
      expect(summary.run).toBe('')
      expect(summary.runs.map((r: { id: string }) => r.id)).toEqual(['a', 'b'])
    } finally {
      restore()
    }
  })

  test('unbindRun stores an explicit { run: null }', async () => {
    const mem: Mem = new Map()
    const restore = await session(mem)
    try {
      await bindRun('b', '/wt/repo-b')
      await unbindRun()
      expect(await host().state.bound.get()).toEqual({ run: null })
    } finally {
      restore()
    }
  })

  test('liveWorkersAll counts the agent files of every run, skipping gone workers and vanished panes', async () => {
    const mem: Mem = new Map()
    const panes = new Set(['p1', 'p2', 'p3'])
    const restore = await session(mem, { panes })
    try {
      const worker = (run: string, pane: string) => JSON.stringify({ pane, profile: 'x', family: 'claude', agent: 'claude', task: 'T1', run })
      mem.set('/main/repo/.omh/agents/ra.json', worker('a', 'p1'))
      mem.set('/main/repo/.omh/agents/rb.json', worker('b', 'p2'))
      mem.set('/main/repo/.omh/agents/rc.json', worker('b', 'p3'))
      mem.set('/main/repo/.omh/agents/rd.json', worker('b', 'p-stale')) // its pane is gone: a stale file
      await host().state.workers.set(() => ({ rc: { name: 'rc', phase: 'gone' } as never }))
      expect(await liveWorkersAll()).toBe(2)
      // Answers are cached (~30 s): a pane closing a moment later is not asked about again.
      panes.delete('p1')
      expect(await liveWorkersAll()).toBe(2)
      rt.paneSeen.clear()
      expect(await liveWorkersAll()).toBe(1)
    } finally {
      restore()
    }
  })

  test('B1: session A\'s reconcile ignores session B\'s workers in the shared .omh/agents', async () => {
    const mem: Mem = new Map()
    const restore = await session(mem, { panes: new Set(['pa', 'pb']) })
    try {
      const file = (run: string, cwd: string, pane: string) => JSON.stringify({ pane, profile: 'x', family: 'claude', agent: 'claude', cwd, task: 'T1', run })
      mem.set('/main/repo/.omh/agents/mine.json', file('a', '/main/repo', 'pa'))
      mem.set('/main/repo/.omh/agents/theirs.json', file('b', '/wt/repo-b', 'pb'))
      await reconcile() // session A: unbound on the main checkout, current-run a
      expect(Object.keys(await host().state.workers.get())).toEqual(['mine'])
      expect([...rt.watchers.keys()]).toEqual(['mine'])
      // Session B, bound to run b in its worktree, takes the other one.
      await bindRun('b', '/wt/repo-b')
      rt.watchers = new Map()
      await host().state.workers.set(() => ({}))
      await reconcile()
      expect(Object.keys(await host().state.workers.get())).toEqual(['theirs'])
      expect([...rt.watchers.keys()]).toEqual(['theirs'])
    } finally {
      restore()
    }
  })

  test('N4: bindRun carries the tabs holding this session\'s workers to the run, and leaves the rest', async () => {
    const mem: Mem = new Map()
    const restore = await session(mem, { tabs: { t1: ['w1:p5', 'w1:p6'], t2: ['w1:p9'] } })
    try {
      mem.set('/main/repo/.omh/tab.json', JSON.stringify({ tabs: [{ tab: 't1', root_pane: 'w1:p5' }, { tab: 't2', root_pane: 'w1:p9' }, { tab: 't-gone', root_pane: 'w1:p0' }] }))
      await host().state.workers.set(() => ({ w: { name: 'w', pane: 'w1:p6', phase: 'running' } as never }))
      await bindRun('b', '/wt/repo-b')
      expect(JSON.parse(mem.get('/main/repo/.omh/runs/b/tab.json')!).tabs.map((t: { tab: string }) => t.tab)).toEqual(['t1'])
      expect(JSON.parse(mem.get('/main/repo/.omh/tab.json')!).tabs.map((t: { tab: string }) => t.tab)).toEqual(['t2']) // another session's, and the dead one dropped
    } finally {
      restore()
    }
  })

  test('N3: a failed wake submit keeps its sections for the next flush', async () => {
    const mem: Mem = new Map()
    const restore = await session(mem)
    try {
      rt.options = { ...rt.options, wakeOnSettle: true }
      const sent: string[] = []
      const timers: Array<() => void> = []
      const h = host() as any
      let fail = true
      h.prompt = {
        submit: async ({ text }: { text: string }) => {
          if (fail) throw new Error('offline')
          sent.push(text)
        },
      }
      h.clock.after = (_ms: number, fn: () => void) => (timers.push(fn), { cancel() {} })
      rt.wakeTimer = null
      await queueWake('WAKE TEXT')
      timers.shift()!()
      for (let i = 0; i < 30; i++) await Promise.resolve()
      expect(sent).toEqual([])
      expect((await host().state.wake.get()).sections).toEqual(['WAKE TEXT'])

      fail = false
      await flushWake()
      timers.shift()!()
      for (let i = 0; i < 30; i++) await Promise.resolve()
      expect(sent).toEqual(['WAKE TEXT'])
      expect((await host().state.wake.get()).sections).toEqual([])
    } finally {
      restore()
    }
  })

  test('N2: the stale-wake guard survives a reload (kept in $.state.wake, not in the module)', async () => {
    const mem: Mem = new Map()
    const restore = await session(mem)
    try {
      rt.options = { ...rt.options, wakeOnSettle: true }
      const sent: string[] = []
      const timers: Array<() => void> = []
      const h = host() as any
      h.prompt = { submit: async ({ text }: { text: string }) => void sent.push(text) }
      h.clock.after = (_ms: number, fn: () => void) => (timers.push(fn), { cancel() {} })
      rt.wakeTimer = null
      const spec: WakeSpec = { kind: 'worker', name: 'w1', task: 'T1', phase: 'stalled' }
      expect(decodeWake(encodeWake('ALERT text', spec))).toEqual({ text: 'ALERT text', spec })
      expect(decodeWake('plain')).toEqual({ text: 'plain', spec: null })

      await host().state.workers.set(() => ({ w1: { name: 'w1', task: 'T1', phase: 'stalled' } as never }))
      await queueWake('ALERT text', async () => 'closure', spec)
      const stored = (await host().state.wake.get()).sections
      expect(stored).toHaveLength(1)
      expect(stored[0]).toContain('"name":"w1"') // serializable: the spec is in the state
      // A hot reload: module variables reset, $.state stays.
      rt.wakeGuards = new Map()
      rt.wakeTimer = null
      timers.length = 0
      await host().state.workers.set(() => ({ w1: { name: 'w1', task: 'T2', phase: 'running' } as never })) // the task moved on meanwhile
      await flushWake()
      timers.shift()!()
      for (let i = 0; i < 30; i++) await Promise.resolve()
      expect(sent).toEqual([]) // dropped by the rebuilt guard
      // Still holding it: sent, without the marker.
      rt.wakeTimer = null
      await host().state.workers.set(() => ({ w1: { name: 'w1', task: 'T1', phase: 'stalled' } as never }))
      await queueWake('ALERT text', undefined, spec)
      timers.shift()!()
      for (let i = 0; i < 30; i++) await Promise.resolve()
      expect(sent).toEqual(['ALERT text'])
    } finally {
      restore()
    }
  })
})

describe('runWorkerName', () => {
  const VALID = /^[a-z][a-z0-9_-]{0,31}$/
  test('two runs never share a worker name, and the result is a valid name', () => {
    const a = runWorkerName('20261121-multi-run', 't1')
    const b = runWorkerName('20261121-other', 't1')
    expect(a).not.toBe(b)
    expect(a.endsWith('-t1')).toBe(true)
    expect(VALID.test(a)).toBe(true)
    expect(runWorkerName('20261121-multi-run', 't1')).toBe(a)
  })
  test('without a run the base is kept; a long base is cut to 32', () => {
    expect(runWorkerName(null, 't1')).toBe('t1')
    expect(runWorkerName('', 't1')).toBe('t1')
    expect(runWorkerName('r', 'x'.repeat(60)).length).toBe(32)
  })
})
