// The pure parts: state machine, routing, plan validation, quota parsing, diagnosis, guards.

import { describe, expect, test } from 'claude-code/testing'

import { normalizeConfig } from '../hooks/lib/config'
import { diagnose } from '../hooks/lib/diagnose'
import { ownerOf, relativeTo } from '../hooks/lib/guards'
import { findTask, parsePlan, runView, taskStatus, waveProgress, type TaskFacts } from '../hooks/lib/plan'
import { evaluate, parseClaude, parseOpencodeGo, providerOf, quotaAllows } from '../hooks/lib/quota'
import { isUsualPair, pickProfile } from '../hooks/lib/route'
import { newWorker, step, type SettleFacts } from '../hooks/lib/settle'
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
