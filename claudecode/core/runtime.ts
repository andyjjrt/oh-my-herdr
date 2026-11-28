// GENERATED FILE - do not edit; source: /core/runtime.ts
// Regenerate with: bun scripts/sync.ts
// Claude Code needs real files in the plugin; this header also keeps the generated copy
// distinct from the source in Git rename detection, so the source keeps its history.
// The mod's live side: the session's `$`, $.state, the watchers, timers, alerts and wake-ups.
// Module variables reset on every hot reload; `session.start` runs again and calls `init`, which
// rebuilds everything from $.state (kept across reloads) and the .omh/ files.

import type { Engine, Options } from './host'

export type { Options } from './host'

import type { OmhDiagnosis, OmhQuota, OmhRunSummary, OmhRunView, OmhWorker } from './types'
import { displayOf, type Config, loadConfig } from './config'
import { diagnose, excerpt } from './diagnose'
import { appendLine, currentRunId, hasText, openRunId, listWorkers, ownsWorker, Paths, readGates, readJson, remove, type Closing, type DispatchFile, writeJson } from './files'
import { agentStatus, paneExists, readScreen, watchArgv } from './backend'
import { isHcPane } from './hc'
import { notify, tabPanes } from './herdr'
import { type OmhStatusFile, type Plan, parsePlan, planningStatusFile, runView, SCOUT_RUN, statusFile, type TaskFacts } from './plan'
import { probe, providerOf, providersOf, quotaAllows, type Provider } from './quota'
import { ACTIVE, newWorker, type SettleEffect, type SettleEvent, step } from './settle'
import { endStatusOf, isSubagentPane, isSubagentWorker, settleStatusOf, subagentIdOf, subagentScreen } from './subagent'
import { alertText, type ScoutRow, scoutsText, settleText } from './text'

export function optionsOf(o: Readonly<Record<string, unknown>>): Options {
  const b = (k: string, d: boolean) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : d)
  return {
    display: displayOf(o.display),
    backend: o.backend === 'herdr' || o.backend === 'hc' ? o.backend : 'auto',
    wakeOnSettle: b('wakeOnSettle', true),
    notifyHuman: b('notifyHuman', true),
    autoContinue: b('autoContinue', false),
    autoContinueMax: typeof o.autoContinueMax === 'number' ? o.autoContinueMax : 3,
    verbose: b('verbose', false),
  }
}

export const GRACE_MS = 45_000
export const DEFAULT_STALL_MS = 30_000

type Timer = { cancel: () => void }

export const rt = {
  $: null as Engine | null,
  options: optionsOf({}),
  paths: null as Paths | null,
  cfg: null as Config | null,
  cfgError: null as string | null,
  watchPy: '',
  /** The lead's herdr pane (HERDR_PANE_ID), when it runs in herdr. */
  selfPane: null as string | null,
  /** The lead's herdr-core terminal (HC_TERMINAL_ID), when it runs in one (a Herdr app pane, `hc run claude`). */
  selfTerminal: null as string | null,
  watchers: new Map<string, { pane: string; stopped: boolean }>(),
  timers: new Map<string, Timer>(),
  queues: new Map<string, Promise<void>>(),
  wakeTimer: null as Timer | null,
  stallRechecked: new Set<string>(),
  /** The scout state the lead was last woken with (a reload may repeat one wake-up at worst). */
  scoutKey: '',
  /** How each subagent worker's run ended (turn.complete), by agent id; read by diagnosis. */
  subagentEnds: new Map<string, { reason: string; answer: string }>(),
  /** Polls $.subagent?.list() while a subagent worker is out. */
  pollTimer: null as Timer | null,
  /**
   * Queued wake-up text -> a check run when it is sent: null drops it (its worker no longer holds the
   * task). Closures die with a hot reload; the serializable `WakeSpec` kept in $.state.wake does not.
   */
  wakeGuards: new Map<string, () => Promise<string | null>>(),
  /** Pane -> whether it existed when last asked (liveWorkersAll), so dispatch does not ask the backend every time. */
  paneSeen: new Map<string, { at: number; exists: boolean }>(),
  /** Each agent's version (null: unknown), read once per session by `agentVersions`. */
  versions: null as Record<string, string | null> | null,
}

/**
 * Append one line to .omh/events.jsonl: the hook points for what sits around the mod (an inbox, a
 * bot). Never throws: an event is a nicety.
 */
export async function logEvent(event: string, run: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    const $ = rt.$
    const p = rt.paths
    if ($ === null || p === null) return
    const session = leadId() ?? 'lead'
    const line = JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), run, event, session, ...detail })
    await appendLine($, `${p.omh}/events.jsonl`, line)
  } catch {
    // never into the caller
  }
}

/** This session's stable identity, written to the worker files it starts (`lead`) and to lead.json: the host's lead address; null outside herdr and hc. */
export function leadId(): string | null {
  return rt.$?.lead?.pane ?? null
}

/** runs/<run>/lead.json: the session bound to the run and the checkout it works in. */
export type LeadFile = { pane: string | null; root?: string }

export async function readLead(run: string): Promise<LeadFile | null> {
  return readJson<LeadFile>(host(), `${paths().run(run)}/lead.json`)
}

/** Whether the pane a lead.json names still exists (an hc terminal is recorded as `hc:<id>`). */
export async function leadLive(pane: string): Promise<boolean> {
  return paneExists(host(), pane).catch(() => false)
}

export async function isClosed(run: string): Promise<boolean> {
  return host().fs.exists(`${paths().run(run)}/closed.json`)
}

/** The live lead another session has bound to `run` (its lead.json pane), or null: no lead.json, closed, this session's own, or its pane gone. */
export async function otherLiveLead(run: string): Promise<string | null> {
  if (await isClosed(run)) return null
  const lead = await readLead(run)
  if (lead === null || lead.pane === null || lead.pane === leadId()) return null
  return (await leadLive(lead.pane)) ? lead.pane : null
}

/**
 * This session's open run (files.openRunId): the bound one, else current-run unless it is closed or another
 * live lead is bound to it (an unbound session never follows a run into somebody else's hands).
 */
export async function openRun(): Promise<string | null> {
  const id = await openRunId(host(), paths())
  return id !== null && paths().boundRun === null && (await otherLiveLead(id)) !== null ? null : id
}

/** The run tasks are dispatched in (files.currentRunId), by the same rule as openRun. */
export async function currentRun(): Promise<string | null> {
  const id = await currentRunId(host(), paths())
  return id !== null && paths().boundRun === null && (await otherLiveLead(id)) !== null ? null : id
}

export function host(): Engine {
  if (rt.$ === null) throw new Error('oh-my-herdr is not bound to a session yet')
  return rt.$
}

export function paths(): Paths {
  if (rt.paths === null) throw new Error('oh-my-herdr has no project paths yet')
  return rt.paths
}

/**
 * Bind this session to `run`, working in `root` (its own checkout, the main one or a worktree the user made):
 * the run's files win over .omh/current-run. .omh stays central. Records the session in
 * runs/<run>/lead.json ({ pane, root }), which /omh runs and the status line read.
 */
export async function bindRun(run: string, root: string): Promise<void> {
  const $ = host()
  const from = paths()
  rt.paths = new Paths(root, from.omh, run)
  await $.state.bound.set(() => ({ run, root }))
  await writeLeadFile(run, root)
  if (from.boundRun !== run) await carryTabs(from, rt.paths)
  await refreshRun()
  await logEvent('bound', run, { root })
}

/** runs/<run>/lead.json: the lead session bound to the run and the checkout it works in. Never throws. */
export async function writeLeadFile(run: string, root: string): Promise<void> {
  try {
    await writeJson(host(), `${paths().run(run)}/lead.json`, { pane: leadId(), root })
  } catch (err) {
    log(`could not write lead.json of ${run}: ${(err as Error).message}`)
  }
}

type TabRecord = { tab: string; root_pane: string; used?: boolean }

/**
 * N4: the omh-workers tabs of the session's current scope (the project's `.omh/tab.json` when unbound, the
 * bound run's `tab.json` otherwise). When the session binds to a run (or rebinds from another), the tabs holding
 * its own workers are carried over to the new run's `runs/<run>/tab.json` (what `paths().tab` points at once
 * bound), so the run's later workers reuse them and they are not orphaned; the rest stay where they are for
 * whoever else uses them. Tabs no longer there are dropped. Carried over rather than closed: the panes still hold live workers.
 */
async function carryTabs(from: Paths, to: Paths): Promise<void> {
  const $ = host()
  try {
    const raw = await readJson<TabRecord | { tabs: TabRecord[] }>($, from.tab)
    const records: TabRecord[] = raw === null ? [] : 'tabs' in raw ? raw.tabs : [raw]
    if (records.length === 0) return
    const mine = Object.values(await workers()).filter(w => w.phase !== 'gone')
    const paneOf = new Set(mine.map(w => w.pane))
    const hasHc = mine.some(w => isHcPane(w.pane))
    const carry: TabRecord[] = []
    const keep: TabRecord[] = []
    for (const r of records) {
      let panes: string[] | null = []
      try {
        panes = await tabPanes($, r.tab)
      } catch {
        panes = [] // unreadable (an hc tab, or herdr away): fall back to the guess below
      }
      if (panes === null) continue // the tab is gone
      if (panes.some(x => paneOf.has(x)) || (panes.length === 0 && hasHc)) carry.push(r)
      else keep.push(r)
    }
    if (carry.length === 0) return
    const there = await readJson<{ tabs: TabRecord[] }>($, to.tab)
    const have = there?.tabs ?? []
    await writeJson($, to.tab, { tabs: [...have, ...carry.filter(r => !have.some(h => h.tab === r.tab))] })
    if (keep.length === 0) await remove($, from.tab)
    else await writeJson($, from.tab, { tabs: keep })
  } catch (err) {
    log(`could not carry the workers tabs over: ${(err as Error).message}`)
  }
}

/**
 * A bound session loses its binding, with one wake-up saying why, when its run was closed from another session or
 * another live session took it over (`/omh approve <run> force` rewrote lead.json). Cheap while nothing changed:
 * a file read, and only a different pane in lead.json asks the backend whether it is alive.
 */
export async function dropLostBinding(): Promise<boolean> {
  const run = paths().boundRun
  if (run === null) return false
  let why: string
  if (await isClosed(run)) why = `was closed from another session`
  else {
    const other = await otherLiveLead(run)
    if (other === null) return false
    why = `was taken over by the session in ${other}`
  }
  await unbindRun()
  await queueWake(`[oh-my-herdr] Run ${run} ${why}: this session no longer leads it. Stop dispatching into it. Draft new work with omh_status action "draft" (a "name") and have the user approve it.`)
  return true
}

/** Unbind the session: it follows .omh/current-run again, in the same checkout. */
export async function unbindRun(): Promise<void> {
  const $ = host()
  const base = paths()
  const was = base.boundRun
  rt.paths = new Paths(base.root, base.omh)
  await $.state.bound.set(() => ({ run: null })) // explicit: a reload must not re-seed it from OMH_RUN
  await refreshRun()
  await logEvent('unbound', was, { root: base.root })
}

export async function config(): Promise<Config> {
  const $ = host()
  try {
    rt.cfg = await loadConfig($, paths().omh)
    rt.cfgError = null
  } catch (err) {
    rt.cfgError = (err as Error).message
    if (rt.cfg === null) throw err
  }
  return rt.cfg
}

const log = (text: string) => rt.$?.ui.log(`oh-my-herdr: ${text}`)

// ------------------------------------------------------------------ workers in $.state

export async function workers(): Promise<Record<string, OmhWorker>> {
  return host().state.workers.get()
}

export async function setWorker(w: OmhWorker): Promise<void> {
  await host().state.workers.set(all => ({ ...all, [w.name]: w }))
}

/**
 * Live workers across every run (a file not yet in $.state counts as live), for a global
 * max_concurrent. Workers whose phase is `gone` are left out.
 */
export async function liveWorkersAll(): Promise<number> {
  const $ = host()
  const known = await workers()
  const files = await listWorkers($, paths())
  const now = await $.clock.now()
  let n = 0
  for (const f of files) {
    // Gone for this session only when it is the same pane: another lead may have reused the name.
    const was = known[f.name]
    if (was?.phase === 'gone' && (was.pane === undefined || was.pane === f.pane)) continue
    if (await paneLive(f.pane, now)) n++
  }
  return n
}

const PANE_TTL_MS = 30_000

/** Whether a worker's pane still exists, asked of the backend at most every 30 s; unknown counts as live. */
async function paneLive(pane: string, now: number): Promise<boolean> {
  if (isSubagentPane(pane)) return true // an in-process subagent has no pane to ask
  const seen = rt.paneSeen.get(pane)
  if (seen !== undefined && now - seen.at < PANE_TTL_MS) return seen.exists
  const exists = await paneExists(host(), pane).catch(() => true)
  rt.paneSeen.set(pane, { at: now, exists })
  return exists
}

export async function dropWorker(name: string): Promise<void> {
  await host().state.workers.set(all => {
    const { [name]: _, ...rest } = all
    return rest
  })
}

function stallMsOf(cfg: Config | null, agent: string): number {
  const s = cfg?.agents[agent]?.stall_seconds
  return typeof s === 'number' && s > 0 ? s * 1000 : DEFAULT_STALL_MS
}

/** Run `fn` after every earlier event of the same worker has been handled. */
function serial(name: string, fn: () => Promise<void>): Promise<void> {
  const prev = rt.queues.get(name) ?? Promise.resolve()
  const next = prev.then(fn).catch(err => log(`${name}: ${(err as Error).message}`))
  rt.queues.set(name, next)
  return next
}

export function feed(name: string, event: SettleEvent): Promise<void> {
  return serial(name, () => apply(name, event))
}

/** What the worker's pane (or subagent listing) says now, not what the watcher last heard. */
async function liveStatus(w: OmhWorker): Promise<string> {
  if (isSubagentWorker(w)) {
    const sub = host().subagent
    if (!sub) return 'unknown'
    const listed = await sub.list().catch(() => null)
    return listed === null ? 'unknown' : settleStatusOf(listed.find(a => a.id === subagentIdOf(w))?.status)
  }
  return agentStatus(host(), w.pane).catch(() => 'unknown')
}

/**
 * Re-read a worker's live status and feed it, then a tick: corrects a phase built on a missed
 * transition (a stall that is working, a report that landed unnoticed). Returns the worker after.
 */
export async function recheck(name: string): Promise<{ before: OmhWorker; after: OmhWorker; live: string } | null> {
  let out: { before: OmhWorker; after: OmhWorker; live: string } | null = null
  await serial(name, async () => {
    const before = (await workers())[name]
    if (!before) return
    const live = await liveStatus(before)
    const now = await host().clock.now()
    // A subagent's `done` comes with its answer by turn.complete; the listing alone is not its end.
    if (live !== 'unknown' && live !== 'none' && !(isSubagentWorker(before) && live === 'done')) await apply(name, { kind: 'status', status: live, at: now })
    await apply(name, { kind: 'tick', at: now })
    const after = (await workers())[name] ?? before
    out = { before, after, live }
  })
  return out
}

async function apply(name: string, event: SettleEvent): Promise<void> {
  const $ = host()
  const w = (await workers())[name]
  if (!w) return
  const p = paths()
  const hasResult = w.task !== null && w.run !== null ? await hasText($, p.result(w.run, w.task)) : false
  const facts = { hasResult, stallMs: stallMsOf(rt.cfg, w.agent), graceMs: GRACE_MS }
  let cur = w
  const effects: SettleEffect[] = []
  if (event.kind === 'tick' && cur.phase === 'dispatched' && !cur.sawWorking && cur.dispatchedAt !== null && event.at - cur.dispatchedAt >= facts.stallMs) {
    // The watcher reports changes only: a `working` that came before the dispatch was recorded is
    // never repeated. Ask the pane itself before calling it a stall.
    const live = await liveStatus(cur)
    if (live === 'working' || live === 'blocked') {
      const s = step(cur, { kind: 'status', at: event.at, status: live }, facts)
      cur = s.worker
      effects.push(...s.effects)
    }
  }
  const s = step(cur, event, facts)
  const worker = s.worker
  effects.push(...s.effects)
  await setWorker(worker)
  for (const effect of effects) await perform(worker, effect)
  if (effects.length > 0 || w.phase !== worker.phase) await refreshRun()
}

async function perform(w: OmhWorker, effect: SettleEffect): Promise<void> {
  const $ = host()
  switch (effect.type) {
    case 'timer': {
      rt.timers.get(`tick:${w.name}`)?.cancel()
      rt.timers.set(
        `tick:${w.name}`,
        $.clock.after(effect.ms + 250, () => {
          rt.timers.delete(`tick:${w.name}`)
          void (async () => feed(w.name, { kind: 'tick', at: await host().clock.now() }))()
        }),
      )
      return
    }
    case 'recovered':
      rt.stallRechecked.delete(w.name)
      await setOutcome(w, null, null)
      return
    case 'settled':
      rt.stallRechecked.delete(w.name)
      await setOutcome(w, 'finished', null)
      await (w.run === SCOUT_RUN ? maybeScoutsSettled() : maybeWaveSettled())
      return
    case 'alert':
      await onAlert(w, effect.phase)
      return
  }
}

async function setOutcome(w: OmhWorker, outcome: string | null, diag: string | null): Promise<void> {
  if (w.run === null || w.task === null) return
  const $ = host()
  const file = paths().dispatch(w.run, w.task)
  const d = await readJson<DispatchFile>($, file)
  if (d && d.worker === w.name) await writeJson($, file, { ...d, outcome, diagnose: diag })
}

// ------------------------------------------------------------------ alerts and diagnosis

export async function diagnoseWorker(w: OmhWorker): Promise<OmhDiagnosis> {
  const $ = host()
  const cfg = rt.cfg
  const screen = isSubagentWorker(w) ? await subagentScreenOf(w) : w.phase === 'gone' ? '' : await readScreen($, w.pane, 80).catch(() => '')
  const hasResult = w.task !== null && w.run !== null ? await hasText($, paths().result(w.run, w.task)) : false
  let quotaExhausted: string | null = null
  const profile = cfg?.profiles[w.profile]
  if (cfg && profile) {
    const provider = providerOf(profile)
    if (provider !== null) await refreshQuota([provider], false)
    const allowed = quotaAllows({ ...cfg, quota: { ...cfg.quota, onUnknown: 'allow' } }, await $.state.quota.get(), w.profile)
    if (allowed !== true) quotaExhausted = allowed
  }
  return diagnose({
    agent: w.agent,
    phase: w.phase,
    screen,
    hasResult,
    quotaExhausted,
    ...(cfg?.agents[w.agent]?.diagnose !== undefined && { rules: cfg.agents[w.agent]!.diagnose! }),
    at: await $.clock.now(),
  })
}

async function onAlert(w: OmhWorker, phase: 'blocked' | 'stalled' | 'idle-no-result' | 'gone'): Promise<void> {
  const $ = host()
  const diag = await diagnoseWorker(w)
  const cur = (await workers())[w.name]
  if (!cur) return
  await setWorker({ ...cur, diagnosis: diag })
  await setOutcome(cur, phase, `${diag.verdict}: ${diag.evidence}`.slice(0, 300))

  if (diag.verdict === 'finished-late') {
    await feed(w.name, { kind: 'tick', at: await $.clock.now() })
    return
  }
  // A stall with nothing recognisable on screen often clears by itself (a slow start): look once
  // more after another stall period before calling the lead.
  if (phase === 'stalled' && diag.verdict === 'unknown' && !rt.stallRechecked.has(w.name)) {
    rt.stallRechecked.add(w.name)
    rt.timers.get(`stall:${w.name}`)?.cancel()
    rt.timers.set(
      `stall:${w.name}`,
      $.clock.after(stallMsOf(rt.cfg, w.agent), () => {
        void serial(w.name, async () => {
          let again = (await workers())[w.name]
          if (again?.phase !== 'stalled') return
          const live = await liveStatus(again)
          if (live === 'working' || live === 'blocked') {
            await apply(w.name, { kind: 'status', status: live, at: await host().clock.now() })
            again = (await workers())[w.name]
          }
          if (again?.phase === 'stalled') await raise(again, 'stalled', await diagnoseWorker(again))
        })
      }),
    )
    return
  }
  await raise(cur, phase, diag)
}

async function raise(w: OmhWorker, phase: string, diag: OmhDiagnosis): Promise<void> {
  const $ = host()
  if (rt.options.notifyHuman) {
    await notify($, `omh: ${w.name} ${phase}`, `${w.task ?? ''} ${diag.verdict}: ${diag.evidence}`.trim().slice(0, 200), 'request')
  }
  const screen =
    diag.verdict === 'unknown' ? diag.evidence : isSubagentWorker(w) ? excerpt(await subagentScreenOf(w), 10) : excerpt(await readScreen($, w.pane, 40).catch(() => ''), 10)
  await logEvent('alert', w.run, { worker: w.name, task: w.task, phase, verdict: diag.verdict })
  // Stale by send time (the task moved to another worker, or this one was torn down): dropped.
  await queueWake(alertText(w, phase, diag, screen), async () => {
    const cur = (await workers())[w.name]
    if (!cur || cur.task !== w.task) return null
    if (phase !== 'gone' && cur.phase !== phase) return null
    return alertText(cur, phase, diag, screen)
  }, { kind: 'worker', name: w.name, task: w.task, phase })
  // An alert can be the last thing the wave (or the scouts) was waiting on.
  await (w.run === SCOUT_RUN ? maybeScoutsSettled() : maybeWaveSettled())
}

/** Scouts have no wave: wake the lead once none is still busy, listing every scout not yet collected. */
async function maybeScoutsSettled(): Promise<void> {
  const $ = host()
  const p = paths()
  const out = Object.values(await workers()).filter(w => w.run === SCOUT_RUN && w.task !== null)
  if (out.length === 0) return
  if (out.some(w => ACTIVE.has(w.phase) && w.phase !== 'stalled')) return // like a wave: a blocked scout may still finish
  const rows: ScoutRow[] = []
  for (const w of out) {
    const reported = await hasText($, p.result(SCOUT_RUN, w.task!))
    rows.push({
      id: w.task!,
      worker: `${w.name} (${w.profile})`,
      state: reported ? 'reported' : w.phase,
      detail: reported ? 'result.md written' : w.diagnosis ? `${w.diagnosis.verdict}: ${w.diagnosis.evidence}` : '',
    })
  }
  const key = rows.map(r => `${r.id}=${r.state}`).sort().join(',')
  if (rt.scoutKey === key) return
  rt.scoutKey = key
  if (rt.options.notifyHuman) await notify($, 'omh: scouts back', `${rows.filter(r => r.state === 'reported').length}/${rows.length} reported`, 'done')
  await queueWake(scoutsText(rows))
}

// ------------------------------------------------------------------ the wave and waking

export async function loadPlan(run: string): Promise<Plan | null> {
  const $ = host()
  const raw = await readJson<unknown>($, paths().plan(run))
  if (raw === null) return null
  const parsed = parsePlan(raw, rt.cfg ? Object.keys(rt.cfg.categories) : [])
  if ('plan' in parsed) return parsed.plan
  // An invalid plan on disk still draws: keep what parses.
  const loose = raw as Plan
  return Array.isArray(loose.waves) ? loose : null
}

/** Rebuild the run view from the files and the workers; returns it. */
export async function refreshRun(): Promise<OmhRunView | null> {
  const $ = host()
  if (await dropLostBinding()) return refreshRun()
  const p = paths()
  const id = await currentRun()
  const plan = id === null ? null : await loadPlan(id)
  if (id === null || plan === null) {
    await $.state.run.set(() => null)
    await publishStatus(null, await planningStatus())
    return null
  }
  const gates = await readGates($, p, id)
  const ws = await workers()
  const facts = new Map<string, TaskFacts>()
  for (const wave of plan.waves) {
    for (const t of wave.tasks) {
      const d = await readJson<DispatchFile>($, p.dispatch(id, t.id))
      const verified = await readJson<Closing>($, p.verified(id, t.id))
      const abandoned = await readJson<Closing>($, p.abandoned(id, t.id))
      const holder = Object.values(ws).find(w => w.run === id && w.task === t.id)
      const phase = holder ? holder.phase : null
      facts.set(t.id, {
        dispatched: d !== null,
        hasResult: await hasText($, p.result(id, t.id)),
        verified: verified !== null,
        abandoned: abandoned !== null,
        worker: d?.worker ?? null,
        profile: d?.profile ?? null,
        phase: phase === 'idle' ? null : phase,
        note: verified?.quality ?? abandoned?.quality ?? (holder?.diagnosis ? `${holder.diagnosis.verdict}` : null),
      })
    }
  }
  const view = runView(id, p.run(id), plan, gates, tid => facts.get(tid)!)
  await $.state.run.set(() => view)
  await publishStatus(view)
  return view
}

/** The status file of a current run with no plan.json yet: its plan drafted, or approved; null when there is none. */
async function planningStatus(): Promise<OmhStatusFile | null> {
  const $ = host()
  const p = paths()
  const run = await openRun()
  if (run === null) return null
  const drafting = await hasText($, p.draft(run))
  if (!drafting && !(await hasText($, p.planMd(run)))) return null
  const text = drafting ? await $.fs.read(p.draft(run)) : await $.fs.read(p.planMd(run))
  const goal = goalOf(text, run)
  return planningStatusFile(run, goal, drafting ? 'draft' : 'approved', new Date(await $.clock.now()))
}

/** A run's first non-blank line without its heading marks: its goal when no plan.json says it. */
function goalOf(text: string, fallback: string): string {
  const line = text.trim().split('\n').find(l => l.trim() !== '')
  return line ? line.replace(/^#+\s*/, '').trim() || fallback : fallback
}

/** The summary row for the run this session refreshed, or null when it has nothing to show. */
function currentSummary(view: OmhRunView | null, file: OmhStatusFile | null): OmhRunSummary | null {
  if (view !== null) {
    const total = view.waves.reduce((n, w) => n + w.tasks.length, 0)
    const done = view.waves.filter(w => w.gatePassed).reduce((n, w) => n + w.tasks.length, 0)
    return { id: view.id, goal: view.goal, done, total, state: view.current === null ? 'finished' : 'running' }
  }
  if (file !== null) {
    const state = file.stage === 'draft' ? 'draft' : file.stage === 'approved' ? 'approved' : 'running'
    return { id: file.run, goal: file.goal, done: file.done, total: file.total, state }
  }
  return null
}

/** A run's row in .omh/status.json, from its own files: draft, approved, running or finished. */
async function runSummary($: Engine, p: Paths, id: string): Promise<OmhRunSummary | null> {
  const file = await readJson<OmhStatusFile>($, p.runStatus(id))
  if (file !== null && typeof file.run === 'string') {
    const state = file.stage === 'draft' ? 'draft' : file.stage === 'approved' ? 'approved' : 'running'
    return { id, goal: file.goal, done: file.done, total: file.total, state }
  }
  const plan = await readJson<Plan>($, p.plan(id))
  if (plan !== null && Array.isArray(plan.waves)) {
    const gates = await readGates($, p, id)
    const waves = plan.waves.filter(w => Array.isArray(w.tasks))
    const total = waves.reduce((n, w) => n + w.tasks.length, 0)
    const done = waves.filter(w => gates.has(w.id)).reduce((n, w) => n + w.tasks.length, 0)
    return { id, goal: typeof plan.goal === 'string' && plan.goal.trim() !== '' ? plan.goal : id, done, total, state: total > 0 && done >= total ? 'finished' : 'running' }
  }
  if (await hasText($, p.planMd(id))) {
    return { id, goal: goalOf(await $.fs.read(p.planMd(id)).catch(() => ''), id), done: 0, total: 0, state: 'approved' }
  }
  if (await hasText($, p.draft(id))) {
    return { id, goal: goalOf(await $.fs.read(p.draft(id)).catch(() => ''), id), done: 0, total: 0, state: 'draft' }
  }
  return null
}

/** Every active run (draft, approved, running) under .omh/runs, the current one included as refreshed. */
async function activeRunRows($: Engine, p: Paths, current: OmhRunSummary | null): Promise<OmhRunSummary[]> {
  let entries: { name: string; kind: string }[] = []
  try {
    entries = await $.fs.list(p.runs)
  } catch {
    // no runs yet
  }
  const rows: OmhRunSummary[] = []
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.name === SCOUT_RUN) continue
    if (await $.fs.exists(`${p.run(entry.name)}/closed.json`)) continue
    if (current !== null && current.id === entry.name) {
      if (current.state !== 'finished') rows.push(current)
      continue
    }
    const row = await runSummary($, p, entry.name)
    if (row !== null && row.state !== 'finished') rows.push(row)
  }
  if (current !== null && current.state !== 'finished' && !rows.some(r => r.id === current.id) && !(await $.fs.exists(`${p.run(current.id)}/closed.json`))) rows.push(current)
  return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Write the run's own status under runs/<run>/ and .omh/status.json: the current/bound run's fields
 * (so claudecode/statusline/omh-wave keeps working) plus every active run. Removed when there is nothing to show.
 */
async function publishStatus(view: OmhRunView | null, planning: OmhStatusFile | null = null): Promise<void> {
  const $ = host()
  const p = paths()
  const file = view === null ? planning : statusFile(view, new Date())
  const run = file?.run ?? view?.id ?? null
  try {
    if (run !== null) {
      if (file === null) await remove($, p.runStatus(run))
      else await writeJson($, p.runStatus(run), file)
    }
    const rows = await activeRunRows($, p, currentSummary(view, file))
    if (p.boundRun !== null) {
      // The top-level fields of the summary belong to an unbound session (the main checkout's run);
      // a bound one only keeps the `runs` array current, so it cannot overwrite what main shows.
      const existing = await readJson<OmhStatusFile>($, p.status)
      if (existing === null) {
        if (rows.length > 0) await writeJson($, p.status, { ...emptyStatus(await $.clock.now()), runs: rows })
      } else if (existing.run === '' && rows.length === 0) {
        await remove($, p.status)
      } else if (existing.run === p.boundRun) {
        // A snapshot this session wrote itself before it bound (e.g. "X draft 0/0"): it is stale now.
        await writeJson($, p.status, { ...emptyStatus(await $.clock.now()), runs: rows })
      } else {
        await writeJson($, p.status, { ...existing, runs: rows })
      }
      return
    }
    if (file === null && rows.length === 0) {
      await remove($, p.status)
      return
    }
    await writeJson($, p.status, { ...(file ?? emptyStatus(await $.clock.now())), runs: rows })
  } catch {
    // The status line is a nicety; a failed write must not stop the run.
  }
}

/** A summary with no run of its own at the top: only `runs` carries anything. */
function emptyStatus(now: number): OmhStatusFile {
  return { version: 1, run: '', goal: '', wave: 0, waves: 0, done: 0, total: 0, alerts: 0, wave_done: 0, wave_total: 0, line: '', updated_at: new Date(now).toISOString() }
}

async function maybeWaveSettled(): Promise<void> {
  const $ = host()
  const view = await refreshRun()
  if (view === null || view.current === null) return
  const wave = view.waves.find(w => w.id === view.current)!
  const dispatched = wave.tasks.filter(t => t.status !== 'pending')
  if (dispatched.length === 0) return
  if (dispatched.some(t => t.status === 'working' || t.status === 'blocked')) return
  const key = `${view.id}:${wave.id}:${dispatched.map(t => `${t.id}=${t.status}`).join(',')}`
  if ((await $.state.wake.get()).settleKey === key) return
  await $.state.wake.set(w => ({ ...w, settleKey: key }))
  if (rt.options.notifyHuman) {
    const pending = wave.tasks.length - dispatched.length
    await notify($, `omh: wave ${wave.id} settled`, `${dispatched.length} task(s) back${pending > 0 ? `, ${pending} not dispatched` : ''}`, 'done')
  }
  await logEvent('wave_settled', view.id, { wave: wave.id, tasks: dispatched.map(t => `${t.id}=${t.status}`) })
  // Rebuilt from the live state when sent; dropped if a task was re-dispatched meanwhile.
  const spec: WakeSpec = { kind: 'wave', run: view.id, wave: wave.id }
  await queueWake(settleText(view, wave, await workers()), waveGuard(spec), spec)
}

/** The check a wave settle wake-up runs when sent: its text rebuilt from the live state, or null when a task is out again. */
function waveGuard(spec: Extract<WakeSpec, { kind: 'wave' }>): () => Promise<string | null> {
  return async () => {
    const now = await refreshRun()
    const w = now?.waves.find(x => x.id === spec.wave)
    if (!now || now.id !== spec.run || !w) return null
    const out = w.tasks.filter(t => t.status !== 'pending')
    if (out.length === 0 || out.some(t => t.status === 'working' || t.status === 'blocked')) return null
    return settleText(now, w, await workers())
  }
}

/** The check an alert wake-up runs after a reload: kept while the worker still holds the task in the phase it alerted on. */
function workerGuard(spec: Extract<WakeSpec, { kind: 'worker' }>, text: string): () => Promise<string | null> {
  return async () => {
    const cur = (await workers())[spec.name]
    if (!cur || cur.task !== spec.task) return null
    if (spec.phase !== 'gone' && cur.phase !== spec.phase) return null
    return text
  }
}

/**
 * What a queued wake-up's stale check needs, as plain data: it is stored with the section in
 * $.state.wake (sections are strings, so it travels as a prefix) and survives a hot reload.
 */
export type WakeSpec =
  | { kind: 'worker'; name: string; task: string | null; phase: string }
  | { kind: 'wave'; run: string; wave: number }

const WAKE_MARK = '\u0001omh-guard:'
const WAKE_END = '\u0001'

export function encodeWake(text: string, spec: WakeSpec): string {
  return `${WAKE_MARK}${JSON.stringify(spec)}${WAKE_END}${text}`
}

export function decodeWake(raw: string): { text: string; spec: WakeSpec | null } {
  if (!raw.startsWith(WAKE_MARK)) return { text: raw, spec: null }
  const end = raw.indexOf(WAKE_END, WAKE_MARK.length)
  if (end < 0) return { text: raw, spec: null }
  try {
    const spec = JSON.parse(raw.slice(WAKE_MARK.length, end)) as WakeSpec
    return { text: raw.slice(end + 1), spec }
  } catch {
    return { text: raw.slice(end + 1), spec: null }
  }
}

/**
 * Gather wake-ups for a moment so several workers finishing together wake the lead once. The
 * sections wait in $.state, so a reload between queueing and sending loses nothing: session.start
 * calls flushWake() again.
 */
export async function queueWake(section: string, guard?: () => Promise<string | null>, spec?: WakeSpec): Promise<void> {
  if (!rt.options.wakeOnSettle) return
  if (guard) rt.wakeGuards.set(section, guard)
  await host().state.wake.set(w => ({ ...w, sections: [...w.sections, spec ? encodeWake(section, spec) : section] }))
  armWake()
}

export function armWake(): void {
  if (rt.wakeTimer !== null) return
  rt.wakeTimer = host().clock.after(1500, () => {
    rt.wakeTimer = null
    void (async () => {
      const $ = host()
      const { sections } = await $.state.wake.get()
      if (sections.length === 0) return
      await $.state.wake.set(w => ({ ...w, sections: [] }))
      // A section whose worker no longer holds its task is dropped; a settle table is rebuilt from the live state.
      const fresh: string[] = []
      for (const raw of sections) {
        const { text: section, spec } = decodeWake(raw)
        // The closure is gone after a reload; the persisted spec rebuilds the same check.
        const guard = rt.wakeGuards.get(section) ?? (spec === null ? undefined : spec.kind === 'wave' ? waveGuard(spec) : workerGuard(spec, section))
        rt.wakeGuards.delete(section)
        const text = guard ? await guard().catch(() => section) : section
        if (text !== null) fresh.push(text)
      }
      if (fresh.length === 0) return
      await $.prompt.submit({ text: fresh.join('\n\n---\n\n') })
    })().catch(err => log(`wake failed: ${(err as Error).message}`))
  })
}

/** After a reload: send what was queued before it. */
export async function flushWake(): Promise<void> {
  if ((await host().state.wake.get()).sections.length > 0) armWake()
}

// ------------------------------------------------------------------ watchers

export function startWatcher(name: string, pane: string): void {
  const old = rt.watchers.get(name)
  if (old && old.pane === pane && !old.stopped) return
  if (old) old.stopped = true
  const ctl = { pane, stopped: false }
  rt.watchers.set(name, ctl)
  const $ = host()
  void (async () => {
    let backoff = 1000
    while (!ctl.stopped) {
      let ended = false
      let buf = ''
      try {
        const stream = $.process.spawn({ argv: watchArgv(rt.watchPy, pane, name) })
        for await (const chunk of stream) {
          if (ctl.stopped) break
          if (chunk.stream === 'stderr') {
            log(`watcher ${name}: ${chunk.text.trim()}`)
            continue
          }
          buf += chunk.text
          let i: number
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i)
            buf = buf.slice(i + 1)
            let msg: { status?: string; ts?: number; error?: string }
            try {
              msg = JSON.parse(line)
            } catch {
              continue
            }
            if (typeof msg.status === 'string') {
              backoff = 1000
              if (msg.status === 'gone') ended = true
              void feed(name, { kind: 'status', status: msg.status, at: msg.ts ?? (await $.clock.now()) })
            } else if (msg.error) {
              log(`watcher ${name}: ${msg.error}`)
            }
          }
        }
      } catch (err) {
        log(`watcher ${name} failed: ${(err as Error).message}`)
      }
      if (ended || ctl.stopped) break
      await new Promise<void>(resolve => $.clock.after(backoff, resolve))
      backoff = Math.min(backoff * 2, 30_000)
    }
    if (rt.watchers.get(name) === ctl) rt.watchers.delete(name)
  })()
}

// ------------------------------------------------------------------ subagent workers

async function listedStatus(agentId: string): Promise<string | undefined> {
  const sub = host().subagent
  if (!sub) return undefined
  const list = await sub.list().catch(() => null)
  return list?.find(a => a.id === agentId)?.status
}

async function subagentScreenOf(w: OmhWorker): Promise<string> {
  const id = subagentIdOf(w)
  return id === null ? '' : subagentScreen(rt.subagentEnds.get(id), await listedStatus(id))
}

/**
 * A subagent's run ended (turn.complete with its agentId). Its answer is the report: saved as
 * result.md unless it starts with BLOCKED or the subagent wrote the file itself.
 */
export async function onSubagentEnd(agentId: string, reason: string, answer: string): Promise<void> {
  const $ = host()
  // Kept even for a subagent not (yet) recorded: dispatch applies an end that beat it.
  rt.subagentEnds.set(agentId, { reason, answer })
  const w = Object.values(await workers()).find(x => subagentIdOf(x) === agentId)
  if (!w) return
  let status = endStatusOf(reason)
  if (w.run !== null && w.task !== null && ACTIVE.has(w.phase)) {
    const file = paths().result(w.run, w.task)
    const blocked = /^\s*BLOCKED\b/.test(answer)
    if (blocked) status = 'gone'
    else if (status === 'done' && answer.trim() !== '' && !(await hasText($, file))) await $.fs.write(file, `${answer.trim()}\n`)
  }
  await feed(w.name, { kind: 'status', status, at: await $.clock.now() })
}

/** Keep polling $.subagent?.list() while any subagent worker has a task out: it says when one waits or dies. */
export function armSubagentPoll(): void {
  if (rt.pollTimer !== null) return
  rt.pollTimer = host().clock.after(10_000, () => {
    rt.pollTimer = null
    void pollSubagents().catch(err => log(`subagent poll failed: ${(err as Error).message}`))
  })
}

async function pollSubagents(): Promise<void> {
  const $ = host()
  const out = Object.values(await workers()).filter(w => isSubagentWorker(w) && ACTIVE.has(w.phase))
  if (out.length === 0) return
  const sub = $.subagent
  if (!sub) return
  const list = await sub.list()
  const now = await $.clock.now()
  for (const w of out) {
    const id = subagentIdOf(w)!
    // Its end comes by turn.complete; until then only waiting, running and a death are news.
    if (rt.subagentEnds.has(id)) continue
    const status = settleStatusOf(list.find(a => a.id === id)?.status)
    if (status !== 'done') await feed(w.name, { kind: 'status', status, at: now })
  }
  armSubagentPoll()
}

export function stopWatcher(name: string): void {
  const w = rt.watchers.get(name)
  if (w) w.stopped = true
  rt.watchers.delete(name)
  for (const k of [`tick:${name}`, `stall:${name}`]) {
    rt.timers.get(k)?.cancel()
    rt.timers.delete(k)
  }
}

// ------------------------------------------------------------------ quota

export async function refreshQuota(only?: readonly Provider[], force = false): Promise<Record<string, OmhQuota>> {
  const $ = host()
  const cfg = rt.cfg
  const providers = only ?? providersOf(cfg)
  const cached = await $.state.quota.get()
  const now = await $.clock.now()
  const ttl = (cfg?.quota.cacheSeconds ?? 120) * 1000
  const fresh: Record<string, OmhQuota> = {}
  await Promise.all(
    providers.map(async p => {
      if (cfg?.quota.providers[p]?.enabled === false) return
      const q = cached[p]
      if (!force && q && now - q.checkedAt < ttl) return
      fresh[p] = await probe($, p, cfg?.quota.providers[p]?.command)
    }),
  )
  if (Object.keys(fresh).length === 0) return cached
  return $.state.quota.set(all => ({ ...all, ...fresh }))
}

// ------------------------------------------------------------------ history

export async function historyFile(): Promise<string> {
  const $ = host()
  const home = (await $.env.get('HOME')) ?? ''
  const state = (await $.env.get('XDG_STATE_HOME')) ?? `${home}/.local/state`
  return `${state}/oh-my-herdr/history.jsonl`
}

export async function recordHistory(run: string, task: string, closing: Closing, how: 'verified' | 'abandoned'): Promise<void> {
  const $ = host()
  const p = paths()
  const d = await readJson<DispatchFile>($, p.dispatch(run, task))
  const plan = await loadPlan(run)
  const title = plan?.waves.flatMap(w => w.tasks).find(t => t.id === task)?.title ?? task
  const line = {
    ts: new Date(closing.at).toISOString(),
    project: p.root,
    run,
    task,
    title,
    intent: d?.intent ?? null,
    category: d?.category ?? null,
    profile: d?.profile ?? null,
    model: d?.model ?? null,
    family: d?.family ?? null,
    override: d?.override ?? false,
    duration_s: d ? Math.round((closing.at - d.dispatchedAt) / 1000) : null,
    outcome: how === 'abandoned' ? `abandoned${d?.outcome ? ` (${d.outcome})` : ''}` : (d?.outcome ?? 'finished'),
    diagnose: d?.diagnose ?? null,
    retries: d?.retries ?? 0,
    quality: closing.quality,
  }
  await appendLine($, await historyFile(), JSON.stringify(line))
}

// ------------------------------------------------------------------ start

/** Bring workers on disk into $.state (keeping what survived a reload) and watch the live ones. */
export async function reconcile(): Promise<void> {
  const $ = host()
  const p = paths()
  // Only this session's workers: .omh/agents/ is shared, and another lead's must not be watched or alerted on.
  const files = (await listWorkers($, p)).filter(f => ownsWorker(f, p, leadId()))
  const known = await workers()
  const now = await $.clock.now()
  const subagent = $.subagent
  const listed = subagent && files.some(f => isSubagentPane(f.pane)) ? await subagent.list().catch(() => []) : []
  for (const f of files) {
    const sub = isSubagentPane(f.pane)
    // A subagent missing from the list ended before the reload: its end (and answer) is lost unless result.md was written.
    const status = sub ? settleStatusOf(listed.find(a => `agent:${a.id}` === f.pane)?.status) : await agentStatus($, f.pane).catch(() => 'unknown')
    let w = known[f.name]
    if (!w || w.pane !== f.pane) {
      w = newWorker({ name: f.name, pane: f.pane, profile: f.profile, family: f.family, agent: f.agent })
      if (f.run && f.task) {
        const d = await readJson<DispatchFile>($, p.dispatch(f.run, f.task))
        const done = await hasText($, p.result(f.run, f.task))
        const closed =
          (await $.fs.exists(p.verified(f.run, f.task))) || (await $.fs.exists(p.abandoned(f.run, f.task))) || (await $.fs.exists(p.collected(f.run, f.task)))
        if (!closed) {
          // Unknown history: if it was dispatched long enough ago, assume it started.
          const long = d !== null && now - d.dispatchedAt > stallMsOf(rt.cfg, f.agent)
          w = {
            ...w,
            task: f.task,
            run: f.run,
            dispatchedAt: d?.dispatchedAt ?? now,
            sawWorking: long,
            phase: done ? 'finished' : status === 'working' ? 'running' : 'dispatched',
          }
        }
      }
    }
    await setWorker(w)
    if (status === 'gone') {
      await feed(f.name, { kind: 'status', status: 'gone', at: now })
    } else if (sub) {
      if (ACTIVE.has(w.phase)) {
        // Its turn.complete (and the answer with it) came before the reload: only result.md can tell.
        await feed(f.name, { kind: 'status', status: status === 'done' ? 'gone' : status, at: now })
        armSubagentPoll()
      }
    } else {
      startWatcher(f.name, f.pane)
      if (ACTIVE.has(w.phase)) await feed(f.name, { kind: 'tick', at: now })
    }
  }
  // Workers in $.state whose file is gone were torn down elsewhere.
  for (const name of Object.keys(known)) if (!files.some(f => f.name === name)) await dropWorker(name)
}
