// plan.json: the machine-readable plan the lead writes per run. Pure.
//
// {
//   "goal": "…",
//   "waves": [
//     { "id": 1, "gate": "npm test passes", "tasks": [
//       { "id": "T1", "title": "api-schema", "intent": "implement", "category": "deep",
//         "owns": ["src/api/schema.ts"], "deps": [] } ] } ]
// }

import type { OmhPhase, OmhRunView, OmhTaskStatus, OmhTaskView, OmhWaveView } from '../../types'
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
      if (seen.has(tid)) errors.push(`task id '${tid}' is used twice`)
      const intent = t.intent as Intent
      if (!INTENTS.includes(intent)) errors.push(`task ${tid}: "intent" must be one of ${INTENTS.join(', ')}`)
      const category = typeof t.category === 'string' ? t.category : ''
      if (!categories.includes(category)) errors.push(`task ${tid}: unknown category '${category}' (known: ${categories.join(', ')})`)
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

/** The band's numbers for the current wave: tasks reported or better, of all. */
export function waveProgress(run: OmhRunView): { wave: number; done: number; total: number; alerts: number } | null {
  const wave = run.waves.find(w => w.id === run.current)
  if (!wave) return null
  const done = wave.tasks.filter(t => t.status === 'reported' || DONE.has(t.status)).length
  const alerts = wave.tasks.filter(t => t.status === 'blocked' || t.status === 'alert').length
  return { wave: wave.id, done, total: wave.tasks.length, alerts }
}
