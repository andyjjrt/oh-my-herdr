// GENERATED FILE - do not edit; source: /core/plan.ts
// Regenerate with: bun scripts/sync.ts
// Claude Code needs real files in the plugin; this header also keeps the generated copy
// distinct from the source in Git rename detection, so the source keeps its history.
// plan.json: the machine-readable plan the lead writes per run. Pure.
//
// {
//   "goal": "…",
//   "waves": [
//     { "id": 1, "gate": "npm test passes", "tasks": [
//       { "id": "T1", "title": "api-schema", "intent": "implement", "category": "deep",
//         "owns": ["src/api/schema.ts"], "deps": [] } ] } ]
// }

import type { OmhPhase, OmhRunView, OmhTaskStatus, OmhTaskView, OmhWaveView } from './types'
import { INTENTS, type Intent } from './route'

export type PlanTask = {
  id: string
  title: string
  intent: Intent
  category: string
  owns: string[]
  deps: string[]
}

export type PlanWave = { id: number; gate: string; tasks: PlanTask[] }

export type Plan = { goal: string; waves: PlanWave[] }

export const TASK_ID = /^[A-Za-z0-9._-]{1,64}$/

// Scouts: read-only explore/research tasks the lead sends out while planning, before any plan.json
// exists. They live outside every run (under SCOUT_RUN), have no wave or gate, own no files, and
// are closed by omh_collect. The `scout-` prefix is theirs; plan tasks may not use it.
export const SCOUT_RUN = '_scout'
export const SCOUT_ID = /^scout-[A-Za-z0-9._-]{1,58}$/
export const SCOUT_INTENTS: readonly Intent[] = ['explore', 'research']
export const isScout = (id: string): boolean => /^scout-/i.test(id)

type Json = Record<string, unknown>
const rec = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Parse and validate; returns the plan or every problem found. */
export function parsePlan(raw: unknown, categories: readonly string[]): { plan: Plan } | { errors: string[] } {
  const errors: string[] = []
  const r = rec(raw)
  const goal = typeof r.goal === 'string' ? r.goal.trim() : ''
  if (!goal) errors.push('"goal" is required')
  if (!Array.isArray(r.waves) || r.waves.length === 0) errors.push('"waves" must be a non-empty array')
  const waves: PlanWave[] = []
  const seen = new Map<string, number>() // task id → wave id
  for (const [i, wv] of (Array.isArray(r.waves) ? r.waves : []).entries()) {
    const w = rec(wv)
    const id = typeof w.id === 'number' ? w.id : i + 1
    if (waves.some(x => x.id === id)) errors.push(`wave id ${id} is used twice`)
    if (waves.length > 0 && id <= waves[waves.length - 1]!.id) errors.push(`wave ids must increase (wave ${id})`)
    const gate = typeof w.gate === 'string' ? w.gate.trim() : ''
    if (!gate) errors.push(`wave ${id}: "gate" is required (how you will check this wave before the next starts)`)
    const tasks: PlanTask[] = []
    if (!Array.isArray(w.tasks) || w.tasks.length === 0) errors.push(`wave ${id}: "tasks" must be a non-empty array`)
    for (const tv of Array.isArray(w.tasks) ? w.tasks : []) {
      const t = rec(tv)
      const tid = typeof t.id === 'string' ? t.id : ''
      if (!TASK_ID.test(tid)) {
        errors.push(`wave ${id}: task id '${tid}' must match ${TASK_ID.source}`)
        continue
      }
      if (isScout(tid)) errors.push(`task id '${tid}': the scout- prefix is reserved for scouts (omh_dispatch before a plan); pick another id`)
      if (seen.has(tid)) errors.push(`task id '${tid}' is used twice`)
      const intent = t.intent as Intent
      if (!INTENTS.includes(intent)) errors.push(`task ${tid}: "intent" must be one of ${INTENTS.join(', ')}`)
      const category = typeof t.category === 'string' ? t.category : ''
      if (!categories.includes(category)) errors.push(`task ${tid}: ${unknownCategory(category, categories)}`)
      tasks.push({
        id: tid,
        title: typeof t.title === 'string' && t.title.trim() ? t.title.trim() : tid,
        intent,
        category,
        owns: strings(t.owns).map(normalizePath),
        deps: strings(t.deps),
      })
      seen.set(tid, id)
    }
    waves.push({ id, gate, tasks })
  }
  for (const w of waves) {
    const owner = new Map<string, string>()
    for (const t of w.tasks) {
      for (const f of t.owns) {
        const other = [...owner.entries()].find(([g]) => overlaps(f, g))
        if (other) errors.push(`wave ${w.id}: '${f}' is owned by both ${other[1]} and ${t.id}; tasks in one wave must not share files`)
        owner.set(f, t.id)
      }
      for (const d of t.deps) {
        const dw = seen.get(d)
        if (dw === undefined) errors.push(`task ${t.id}: dependency '${d}' is not in the plan`)
        else if (dw >= w.id) errors.push(`task ${t.id}: dependency '${d}' must be in an earlier wave`)
      }
    }
  }
  return errors.length > 0 ? { errors } : { plan: { goal, waves } }
}

/** Paths are kept relative to the project root, without ./ and trailing slashes. */
export function normalizePath(p: string): string {
  return p.trim().replace(/^\.\//, '').replace(/\/+$/, '')
}

/** A file or directory entry covers the other (src/api covers src/api/x.ts). */
export function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

export function findTask(plan: Plan, id: string): { task: PlanTask; wave: PlanWave } | null {
  for (const wave of plan.waves) {
    const task = wave.tasks.find(t => t.id === id)
    if (task) return { task, wave }
  }
  return null
}

/** What the files say about one task. */
export type TaskFacts = {
  dispatched: boolean
  hasResult: boolean
  verified: boolean
  abandoned: boolean
  worker: string | null
  profile: string | null
  phase: OmhPhase | null // the live worker's phase while it holds this task
  note: string | null
}

export function taskStatus(f: TaskFacts): OmhTaskStatus {
  if (f.verified) return 'verified'
  if (f.abandoned) return 'abandoned'
  if (f.hasResult) return 'reported'
  if (!f.dispatched) return 'pending'
  switch (f.phase) {
    case 'blocked':
      return 'blocked'
    case 'stalled':
    case 'idle-no-result':
    case 'gone':
      return 'alert'
    case null:
      return 'alert' // dispatched, no result, and no live worker holds it
    default:
      return 'working'
  }
}

export const DONE: ReadonlySet<OmhTaskStatus> = new Set(['verified', 'abandoned'])

/** The first wave whose gate has not passed; null when every gate passed. */
export function currentWave(waves: readonly OmhWaveView[]): number | null {
  return waves.find(w => !w.gatePassed)?.id ?? null
}

export function runView(id: string, dir: string, plan: Plan, gates: ReadonlySet<number>, facts: (taskId: string) => TaskFacts): OmhRunView {
  const waves: OmhWaveView[] = plan.waves.map(w => ({
    id: w.id,
    gate: w.gate,
    gatePassed: gates.has(w.id),
    tasks: w.tasks.map((t): OmhTaskView => {
      const f = facts(t.id)
      return { id: t.id, title: t.title, category: t.category, status: taskStatus(f), worker: f.worker, profile: f.profile, note: f.note }
    }),
  }))
  return { id, dir, goal: plan.goal, current: currentWave(waves), waves }
}

/** The status line's numbers for the current wave: tasks reported or better, of all. */
export function waveProgress(run: OmhRunView): { wave: number; done: number; total: number; alerts: number } | null {
  const wave = run.waves.find(w => w.id === run.current)
  if (!wave) return null
  const done = wave.tasks.filter(t => t.status === 'reported' || DONE.has(t.status)).length
  const alerts = wave.tasks.filter(t => t.status === 'blocked' || t.status === 'alert').length
  return { wave: wave.id, done, total: wave.tasks.length, alerts }
}

/**
 * The status line's numbers for a whole run: tasks done, of all, and how many need the user. A task
 * is done once its wave's gate has passed, so the bar fills only as work is accepted (a run whose
 * last gate is still open shows 4/5, not 5/5). null once every gate has passed (nothing left to
 * show) or when the plan is empty.
 */
export function runProgress(run: OmhRunView): { done: number; total: number; alerts: number } | null {
  if (run.current === null) return null
  const tasks = run.waves.flatMap(w => w.tasks)
  if (tasks.length === 0) return null
  const done = run.waves.filter(w => w.gatePassed).reduce((n, w) => n + w.tasks.length, 0)
  const alerts = tasks.filter(t => t.status === 'blocked' || t.status === 'alert').length
  return { done, total: tasks.length, alerts }
}

/**
 * .omh/status.json, for a custom status line to read (claudecode/statusline/omh-wave; the README's Status line).
 * Its fields are an API: add to them, never rename or drop one.
 */
export type OmhStatusFile = {
  version: 1
  run: string
  goal: string
  /** The current wave (1-based) and how many waves there are. */
  wave: number
  waves: number
  /** Over the whole run: tasks done (their wave's gate passed), of all; and how many need the user. */
  done: number
  total: number
  alerts: number
  /** The current wave: its tasks reported or closed, of all. */
  wave_done: number
  wave_total: number
  /** Ready to print: ██░░░░ 2/5, then ⚠1 while a task needs the user. */
  line: string
  updated_at: string
  /** Where the run is: its plan being drafted, approved but not yet split into waves, or running. */
  stage?: 'draft' | 'approved' | 'running'
}

/** The status file while a run has no waves yet: its plan is a draft, or approved and waiting for plan.json. */
export function planningStatusFile(run: string, goal: string, stage: 'draft' | 'approved', now: Date): OmhStatusFile {
  return {
    version: 1,
    run,
    goal,
    wave: 0,
    waves: 0,
    done: 0,
    total: 0,
    alerts: 0,
    wave_done: 0,
    wave_total: 0,
    line: stage === 'draft' ? '✎ plan draft' : '✓ plan approved',
    updated_at: now.toISOString(),
    stage,
  }
}

/** The status file for a run, or null when there is nothing to show (no run, or every gate passed). */
export function statusFile(run: OmhRunView, now: Date): OmhStatusFile | null {
  const all = runProgress(run)
  const wave = waveProgress(run)
  if (all === null || wave === null) return null
  const width = 6
  const filled = all.total > 0 ? Math.round((all.done / all.total) * width) : 0
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  return {
    version: 1,
    run: run.id,
    goal: run.goal,
    wave: wave.wave,
    waves: run.waves.length,
    done: all.done,
    total: all.total,
    alerts: all.alerts,
    wave_done: wave.done,
    wave_total: wave.total,
    line: `${bar} ${all.done}/${all.total}${all.alerts > 0 ? ` ⚠${all.alerts}` : ''}`,
    updated_at: now.toISOString(),
    stage: 'running',
  }
}

// ------------------------------------------------------------------ plan.md and its approval

/**
 * A short fingerprint of plan.md's text. Approval records it, so a plan.md changed after the user
 * approved it (by the lead, say) counts as not approved. Whitespace at the ends does not count.
 */
export function draftDigest(text: string): string {
  let h = 0x811c9dc5
  for (const ch of text.trim()) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Whether the user approved exactly this plan.md. */
export function isApproved(draft: string | null, approved: string | null): boolean {
  return draft !== null && draft.trim() !== '' && approved !== null && approved.trim() === draftDigest(draft)
}

// ------------------------------------------------------------------ runs and categories by name

/**
 * The run id a draft's name gives: `YYYYMMDD-<slug>`, the date of `now` (local) and the name made a
 * slug (lowercase ASCII letters, digits and dashes, at most 40). A name that already starts with
 * such a date is kept as it is, so the lead can name an existing run. Null when nothing is left.
 */
export function planRunId(name: string, now: Date): string | null {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  if (slug === '') return null
  if (/^\d{8}-./.test(slug)) return slug
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${slug}`
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]!
}

/** The known name closest to a mistyped one (a prefix either way, or at most two edits off); null when none is. */
export function closestName(name: string, known: readonly string[]): string | null {
  const n = name.toLowerCase()
  let best: { name: string; d: number } | null = null
  for (const k of known) {
    const kl = k.toLowerCase()
    const d = n.length >= 3 && (kl.startsWith(n) || n.startsWith(kl)) ? 0.5 : editDistance(n, kl)
    if (d <= 2 && (best === null || d < best.d)) best = { name: k, d }
  }
  return best?.name ?? null
}

/** "unknown category 'review' — did you mean 'reviewer'? (known: …)". A category is not an intent. */
export function unknownCategory(category: string, known: readonly string[]): string {
  const near = closestName(category, known)
  const hint = near !== null ? ` — did you mean '${near}'?` : ''
  const intent = (INTENTS as readonly string[]).includes(category) ? ` '${category}' is an intent; the category is a routing name from the config.` : ''
  return `unknown category '${category}'${hint}${intent} (known: ${known.join(', ')})`
}
