// The .omh/ directory: the source of truth the mod's state is rebuilt from.
//
//   .omh/agents/<name>.json            one worker: pane, profile, family, agent, task, run
//   .omh/tab.json                      { tabs: [...] } the omh-workers tabs and their root panes (unbound session)
//   .omh/current-run                   id of the run the mod follows (set when its first draft is written)
//   .omh/status.json                   the current/bound run's progress plus every active run, for a status line
//   .omh/runs/<run>/tab.json           the workers' tabs when the session is bound to that run
//   .omh/runs/<run>/status.json        that run's own progress (the summary above repeats the current one)
//   .omh/plan-view.json                { pane } of the herdr pane /omh plan opened to preview plan.md
//   .omh/runs/<run>/draft.md           the plan in prose the lead drafts, until the user approves it
//   .omh/runs/<run>/plan.md            the approved plan (/omh approve renames draft.md to it)
//   .omh/runs/<run>/plan.v<n>.md       earlier approved plans, kept when a replan is approved
//   .omh/runs/<run>/plan.approved      digest of the plan.md the user approved
//   .omh/runs/<run>/plan.json          the plan (hooks/lib/plan.ts)
//   .omh/runs/<run>/gates.json         { "passed": [1, 2] }
//   .omh/runs/<run>/<task>/brief.md    what the worker was told
//   .omh/runs/<run>/<task>/result.md   what the worker reported
//   .omh/runs/<run>/<task>/dispatch.json  intent, category, rationale, profile, times, outcome
//   .omh/runs/<run>/<task>/verified.json | abandoned.json  { at, quality }
//   .omh/runs/_scout/<scout>/…         a scout (read-only, before the plan): brief, result, dispatch,
//                                      and collected.json once omh_collect read it or it was abandoned

import type { Engine } from './engine'

export type WorkerFile = {
  name: string
  category: string | null
  profile: string
  family: string
  agent: string
  pane: string
  cwd: string
  run: string | null
  task: string | null
  task_dir: string | null
  /** The lead session that owns this worker (its pane address, `leadId()`); absent when the lead runs outside herdr and hc. */
  lead?: string
}

export type DispatchFile = {
  task: string
  worker: string
  profile: string
  family: string
  model: string
  intent: string
  category: string
  rationale: string
  override: boolean
  warnings: string[]
  dispatchedAt: number
  retries: number
  outcome: string | null
  diagnose: string | null
}

export type Closing = { at: number; quality: string }

export class Paths {
  constructor(
    readonly root: string,
    readonly omh: string,
    /** The run this session is bound to: its files win over .omh/current-run. */
    readonly boundRun: string | null = null,
  ) {}
  get agents() {
    return `${this.omh}/agents`
  }
  agent(name: string) {
    return `${this.omh}/agents/${name}.json`
  }
  /** The workers' tabs: the bound run's own, or the project's when the session is unbound. */
  get tab() {
    return this.boundRun === null ? `${this.omh}/tab.json` : this.runTab(this.boundRun)
  }
  /** The workers' tabs of one run (actions.ts reads paths().tab, which points here when bound). */
  runTab(run: string) {
    return `${this.run(run)}/tab.json`
  }
  /** The current/bound run's progress for a custom status line (OmhStatusFile in hooks/lib/plan.ts). */
  get status() {
    return `${this.omh}/status.json`
  }
  /** One run's own progress, under its directory; .omh/status.json is the summary of all active runs. */
  runStatus(run: string) {
    return `${this.run(run)}/status.json`
  }
  get currentRun() {
    return `${this.omh}/current-run`
  }
  get runs() {
    return `${this.omh}/runs`
  }
  run(id: string) {
    return `${this.omh}/runs/${id}`
  }
  plan(run: string) {
    return `${this.run(run)}/plan.json`
  }
  /** The run's copy of the approved plan.md. */
  planMd(run: string) {
    return `${this.run(run)}/plan.md`
  }
  /** The plan being drafted for a run, until /omh approve makes it the run's plan.md. */
  draft(run: string) {
    return `${this.run(run)}/draft.md`
  }
  /** Digest of the run's plan.md as the user approved it. */
  approval(run: string) {
    return `${this.run(run)}/plan.approved`
  }
  /** An earlier approved plan.md, kept when a replan is approved over it. */
  planVersion(run: string, n: number) {
    return `${this.run(run)}/plan.v${n}.md`
  }
  gates(run: string) {
    return `${this.run(run)}/gates.json`
  }
  task(run: string, task: string) {
    return `${this.run(run)}/${task}`
  }
  brief(run: string, task: string) {
    return `${this.task(run, task)}/brief.md`
  }
  result(run: string, task: string) {
    return `${this.task(run, task)}/result.md`
  }
  dispatch(run: string, task: string) {
    return `${this.task(run, task)}/dispatch.json`
  }
  verified(run: string, task: string) {
    return `${this.task(run, task)}/verified.json`
  }
  abandoned(run: string, task: string) {
    return `${this.task(run, task)}/abandoned.json`
  }
  /** A scout's closing marker: { at, quality }. */
  collected(run: string, task: string) {
    return `${this.task(run, task)}/collected.json`
  }
}

export async function readJson<T>($: Engine, path: string): Promise<T | null> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return null
  }
}

export async function writeJson($: Engine, path: string, value: unknown): Promise<void> {
  await $.fs.write(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function remove($: Engine, path: string): Promise<void> {
  await $.process.run(['rm', '-f', '--', path], { timeoutMs: 10_000 })
}

/** Non-empty file. */
export async function hasText($: Engine, path: string): Promise<boolean> {
  try {
    const st = await $.fs.stat(path)
    return st.kind === 'file' && st.size > 0
  } catch {
    return false
  }
}

export async function appendLine($: Engine, path: string, line: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf('/'))
  const res = await $.process.run(['sh', '-c', 'mkdir -p "$1" && cat >> "$2"', 'sh', dir, path], { stdin: `${line}\n`, timeoutMs: 10_000 })
  if (res.exitCode !== 0) throw new Error(`could not append to ${path}: ${res.stderr.trim()}`)
}

export async function listWorkers($: Engine, paths: Paths): Promise<WorkerFile[]> {
  if (!(await $.fs.exists(paths.agents))) return []
  const out: WorkerFile[] = []
  for (const entry of await $.fs.list(paths.agents)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const w = await readJson<WorkerFile>($, `${paths.agents}/${entry.name}`)
    if (w && typeof w.pane === 'string') out.push({ ...w, name: entry.name.slice(0, -5) })
  }
  return out
}

export async function readGates($: Engine, paths: Paths, run: string): Promise<Set<number>> {
  const g = await readJson<{ passed?: number[] }>($, paths.gates(run))
  return new Set(Array.isArray(g?.passed) ? g.passed : [])
}

/**
 * The run this session works in once its directory exists, plan.json or not (a run being
 * drafted). A bound session always names its own run, whatever .omh/current-run says. An unbound one
 * follows current-run, unless that run is closed: a closed run is nobody's run.
 */
export async function openRunId($: Engine, paths: Paths, boundRun: string | null = paths.boundRun): Promise<string | null> {
  if (boundRun !== null) return boundRun
  try {
    const id = (await $.fs.read(paths.currentRun)).trim()
    if (id && (await $.fs.exists(paths.run(id))) && !(await $.fs.exists(`${paths.run(id)}/closed.json`))) return id
  } catch {
    // none yet
  }
  return null
}

/** The run tasks are dispatched in: the bound one, else current-run, once it has a plan.json. */
export async function currentRunId($: Engine, paths: Paths, boundRun: string | null = paths.boundRun): Promise<string | null> {
  if (boundRun !== null) return (await $.fs.exists(paths.plan(boundRun))) ? boundRun : null
  const id = await openRunId($, paths, null)
  return id !== null && (await $.fs.exists(paths.plan(id))) ? id : null
}

/**
 * A worker name that cannot collide with another run's: a short tag of the run, then the base.
 * Worker names are `[a-z][a-z0-9_-]{0,31}`, so the tag starts with a letter and the whole is cut
 * to 32 characters. Without a run, the base is kept as it is.
 */
export function runWorkerName(run: string | null, base: string): string {
  if (run === null || run === '') return base
  return `${runTag(run)}-${base}`.slice(0, 32)
}

/** The short tag of a run (`r` + 4 base-36 characters) that prefixes its workers' names and scout dirs. */
export function runTag(run: string): string {
  let h = 0x811c9dc5
  for (const ch of run) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `r${h.toString(36).padStart(4, '0').slice(0, 4)}`
}

const trimSlash = (s: string) => s.replace(/\/+$/, '')

/**
 * Whether a worker file belongs to this session; .omh/agents/ is shared by every lead of the project.
 * A file that records its `lead` is ours exactly when that is this session's lead identity (`leadId()`):
 * cwd and run do not matter (a worker started in a subfolder, or left over from an earlier run, is still ours).
 * A file without `lead` was written by a session outside herdr and hc: it is ours only when this session is
 * outside them too (`lead` is null) and the worker runs in our checkout (`w.cwd` equals `p.root`, trailing slashes ignored).
 */
export function ownsWorker(w: WorkerFile, p: Paths, lead: string | null): boolean {
  if (w.lead !== undefined) return lead !== null && w.lead === lead
  return lead === null && trimSlash(w.cwd ?? '') === trimSlash(p.root)
}
