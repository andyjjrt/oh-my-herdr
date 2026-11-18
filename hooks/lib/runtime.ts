// The mod's live side: the session's `$`, $.state, the watchers, timers, alerts and wake-ups.
// Module variables reset on every hot reload; `session.start` runs again and calls `init`, which
// rebuilds everything from $.state (kept across reloads) and the .omh/ files.

import type { PluginOptions } from 'claude-code'

import type { Engine } from './engine'

import type { OmhDiagnosis, OmhQuota, OmhRunView, OmhWorker } from '../../types'
import { type Config, loadConfig } from './config'
import { diagnose, excerpt } from './diagnose'
import { appendLine, currentRunId, hasText, openRunId, listWorkers, Paths, readGates, readJson, remove, type Closing, type DispatchFile, writeJson } from './files'
import { agentStatus, readScreen, watchArgv } from './backend'
import { notify } from './herdr'
import { type OmhStatusFile, type Plan, parsePlan, planningStatusFile, runView, SCOUT_RUN, statusFile, type TaskFacts } from './plan'
import { probe, providerOf, providersOf, quotaAllows, type Provider } from './quota'
import { ACTIVE, newWorker, type SettleEffect, type SettleEvent, step } from './settle'
import { endStatusOf, isSubagentPane, isSubagentWorker, settleStatusOf, subagentIdOf, subagentScreen } from './subagent'
import { type Display, displayOf } from './statusbar'
import { alertText, type ScoutRow, scoutsText, settleText } from './text'

export type Options = {
  /** Where the run's progress shows: the mod's status line, a row above the prompt, or neither. */
  display: Display
  wakeOnSettle: boolean
  notifyHuman: boolean
  autoContinue: boolean
  autoContinueMax: number
  verbose: boolean
}

export function optionsOf(o: PluginOptions): Options {
  const b = (k: string, d: boolean) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : d)
  return {
    display: displayOf(o.display),
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
  /** Polls $.agent.list() while a subagent worker is out. */
  pollTimer: null as Timer | null,
}

export function host(): Engine {
  if (rt.$ === null) throw new Error('oh-my-herdr is not bound to a session yet')
  return rt.$
}

export function paths(): Paths {
  if (rt.paths === null) throw new Error('oh-my-herdr has no project paths yet')
  return rt.paths
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

async function apply(name: string, event: SettleEvent): Promise<void> {
  const $ = host()
  const w = (await workers())[name]
  if (!w) return
  const p = paths()
  const hasResult = w.task !== null && w.run !== null ? await hasText($, p.result(w.run, w.task)) : false
  const { worker, effects } = step(w, event, { hasResult, stallMs: stallMsOf(rt.cfg, w.agent), graceMs: GRACE_MS })
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
          const again = (await workers())[w.name]
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
  await queueWake(alertText(w, phase, diag, screen))
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
  const p = paths()
  const id = await currentRunId($, p)
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
  const run = await openRunId($, p)
  if (run === null) return null
  const drafting = await hasText($, p.draft(run))
  if (!drafting && !(await hasText($, p.planMd(run)))) return null
  const text = drafting ? await $.fs.read(p.draft(run)) : await $.fs.read(p.planMd(run))
  const goal = text.trim().split('\n').find(l => l.trim() !== '')?.replace(/^#+\s*/, '') ?? run
  return planningStatusFile(run, goal, drafting ? 'draft' : 'approved', new Date(await $.clock.now()))
}

/** Write .omh/status.json for a custom status line, or remove it when there is nothing to show. */
async function publishStatus(view: OmhRunView | null, planning: OmhStatusFile | null = null): Promise<void> {
  const $ = host()
  const file = view === null ? planning : statusFile(view, new Date())
  try {
    if (file === null) await remove($, paths().status)
    else await writeJson($, paths().status, file)
  } catch {
    // The status line is a nicety; a failed write must not stop the run.
  }
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
  await queueWake(settleText(view, wave, await workers()))
}

/**
 * Gather wake-ups for a moment so several workers finishing together wake the lead once. The
 * sections wait in $.state, so a reload between queueing and sending loses nothing: session.start
 * calls flushWake() again.
 */
export async function queueWake(section: string): Promise<void> {
  if (!rt.options.wakeOnSettle) return
  await host().state.wake.set(w => ({ ...w, sections: [...w.sections, section] }))
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
      await $.prompt.submit({ text: sections.join('\n\n---\n\n') })
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
  const list = await host().agent.list().catch(() => null)
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

/** Keep polling $.agent.list() while any subagent worker has a task out: it says when one waits or dies. */
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
  const list = await $.agent.list()
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
  const files = await listWorkers($, p)
  const known = await workers()
  const now = await $.clock.now()
  const listed = files.some(f => isSubagentPane(f.pane)) ? await $.agent.list().catch(() => []) : []
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
