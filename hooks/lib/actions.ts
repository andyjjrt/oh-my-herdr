// What the tools and commands do: spawn, dispatch, plan, verify, gate, collect, teardown, check.
// Each returns { ok, text } for the model; errors are answers, not exceptions.


import type { OmhWorker } from '../../types'
import { configProblems, isSubagentProfile, type Config } from './config'
import { diagnose, excerpt } from './diagnose'
import { currentRunId, hasText, listWorkers, readGates, readJson, remove, writeJson, type Closing, type DispatchFile, type WorkerFile } from './files'
import { agentStatus, closePane, createTab, herdr, HerdrError, paneExists, paneHome, readScreen, shellQuote, splitPane, tabPanes } from './herdr'
import { place, type TabSlot } from './layout'
import { DONE, draftDigest, findTask, isApproved, isScout, parsePlan, SCOUT_ID, SCOUT_INTENTS, SCOUT_RUN, TASK_ID } from './plan'
import { code, table } from './md'
import { formatQuota, providerOf, quotaAllows } from './quota'
import { INTENTS, isUsualPair, pickProfile, type Intent } from './route'
import { ACTIVE, isFree, newWorker } from './settle'
import { isSubagentPane, isSubagentWorker, subagentPane, subagentReporting } from './subagent'
import {
  config,
  diagnoseWorker,
  armSubagentPoll,
  dropWorker,
  feed,
  host,
  historyFile,
  loadPlan,
  onSubagentEnd,
  paths,
  recordHistory,
  refreshQuota,
  refreshRun,
  rt,
  setWorker,
  startWatcher,
  stopWatcher,
  workers,
} from './runtime'
import { statusBrief, statusText } from './text'

export type Answer = { ok: boolean; text: string }

const ok = (text: string): Answer => ({ ok: true, text })
const fail = (text: string): Answer => ({ ok: false, text })

const NAME = /^[a-z][a-z0-9_-]{0,31}$/
const STARTUP_MS = 90_000

async function quota(_cfg: Config) {
  await refreshQuota()
  return host().state.quota.get()
}

// ------------------------------------------------------------------ spawn

export type SpawnArgs = {
  name: string
  category?: string
  profile?: string
  intent?: Intent | null
  avoidFamilies?: string[]
  cwd?: string
}

export type Spawned = { worker: OmhWorker; warnings: string[] }

/** Start a worker; on failure the answer explains why (diagnosis and screen included). */
export async function spawn(args: SpawnArgs): Promise<Spawned | Answer> {
  const $ = host()
  const p = paths()
  const cfg = await config()
  if (!NAME.test(args.name)) return fail(`invalid worker name '${args.name}' (must match ${NAME.source})`)

  const ws = await workers()
  const existing = ws[args.name]
  if (existing && existing.phase !== 'gone') {
    const st = await agentStatus($, existing.pane).catch(() => 'unknown')
    if (st !== 'gone') return fail(`worker '${args.name}' already exists (pane ${existing.pane}, ${existing.phase}); reuse it or tear it down first`)
  }

  const q = await quota(cfg)
  let profile: string
  let warnings: string[] = []
  if (args.profile) {
    if (!cfg.profiles[args.profile]) return fail(`unknown profile '${args.profile}' (known: ${Object.keys(cfg.profiles).join(', ')})`)
    if (isSubagentProfile(cfg, args.profile)) return fail(`profile '${args.profile}' runs as a subagent, which starts with its task: omh_dispatch it instead`)
    const allowed = quotaAllows(cfg, q, args.profile)
    if (allowed !== true) return fail(JSON.stringify({ error: 'quota-exhausted', profile: args.profile, reason: allowed, hint: 'pick another profile, or leave profile out so routing skips exhausted providers' }))
    profile = args.profile
  } else if (args.category) {
    // A subagent starts with its task (omh_dispatch); a pane worker is all omh_spawn can start ahead of time.
    const quotaOk = (pr: string) => (isSubagentProfile(cfg, pr) ? 'a subagent profile (starts at dispatch)' : quotaAllows(cfg, q, pr))
    const r = pickProfile(cfg, args.category, { intent: args.intent ?? null, avoidFamilies: args.avoidFamilies ?? [], quotaOk })
    if (!r.ok) return fail(JSON.stringify({ error: 'no-profile', reason: r.error, skipped: r.skipped }))
    profile = r.profile
    warnings = r.warnings
  } else {
    return fail('give a category or a profile')
  }

  if (cfg.maxConcurrent > 0) {
    const live = Object.values(ws).filter(w => w.phase !== 'gone' && w.name !== args.name).length
    if (live >= cfg.maxConcurrent) return fail(`max_concurrent=${cfg.maxConcurrent} workers already running; reuse a free one or tear one down`)
  }

  const prof = cfg.profiles[profile]!
  const spec = cfg.agents[prof.agent]
  if (!spec) return fail(`profile '${profile}' uses unknown agent '${prof.agent}'`)
  if (spec.launch === 'subagent') return fail(`profile '${profile}' runs as a subagent, which starts with its task: omh_dispatch it instead`)
  const cwd = args.cwd ?? p.root

  let pane: string
  try {
    pane = await workerPane(cfg.maxPanesPerTab, cwd)
  } catch (err) {
    return fail(`could not get a pane: ${(err as Error).message}`)
  }

  const started = await startAgent(args.name, pane, spec.launch, spec, prof.args, cwd)
  const file: WorkerFile = {
    name: args.name,
    category: args.category ?? null,
    profile,
    family: prof.family,
    agent: prof.agent,
    pane,
    cwd,
    run: null,
    task: null,
    task_dir: null,
  }
  await writeJson($, p.agent(args.name), file)
  const worker = { ...newWorker({ name: args.name, pane, profile, family: prof.family, agent: prof.agent }), lastStatus: started.status }
  await setWorker(worker)
  startWatcher(args.name, pane)

  if (!started.ok) {
    const diag = diagnose({
      agent: prof.agent,
      phase: 'blocked',
      screen: started.screen,
      hasResult: false,
      quotaExhausted: null,
      ...(spec.diagnose !== undefined && { rules: spec.diagnose }),
      at: await $.clock.now(),
    })
    await setWorker({ ...worker, diagnosis: diag })
    return fail(
      [
        `worker '${args.name}' (${profile}) did not become ready in pane ${pane}: ${started.reason}`,
        `Diagnosis: ${diag.verdict} — ${diag.evidence}`,
        `Hint: ${diag.hint}`,
        'Screen:',
        '```',
        excerpt(started.screen, 15),
        '```',
        `The pane is left open and recorded as '${args.name}'. Once it is fixed (ask the user), dispatch to it by name; or omh_teardown it.`,
      ].join('\n'),
    )
  }
  return { worker, warnings }
}

type TabRecord = { tab: string; root_pane: string; used?: boolean }

/**
 * A pane for a new worker: in an omh-workers tab of the lead's workspace with room (fewer than
 * `maxPanes` panes), else in a new tab there. `.omh/tab.json` keeps the tabs, oldest first.
 */
async function workerPane(maxPanes: number, cwd: string): Promise<string> {
  const $ = host()
  const p = paths()
  const raw = await readJson<TabRecord | { tabs: TabRecord[] }>($, p.tab)
  const records: TabRecord[] = raw === null ? [] : 'tabs' in raw ? raw.tabs : [raw] // the single-tab file of 0.2
  const slots: TabSlot[] = []
  const live: TabRecord[] = []
  for (const r of records) {
    const panes = await tabPanes($, r.tab)
    if (panes === null) continue
    live.push(r)
    const freeRoot = !r.used && panes.includes(r.root_pane) ? r.root_pane : null
    slots.push({ tab: r.tab, freeRoot, count: panes.length, lastPane: panes[panes.length - 1] ?? null })
  }
  const at = place(slots, maxPanes)
  let pane: string
  if (at.kind === 'root') {
    pane = at.pane
    for (const r of live) if (r.tab === at.tab) r.used = true
  } else if (at.kind === 'split') {
    pane = await splitPane($, at.anchor, at.direction, cwd)
  } else {
    const home = rt.selfPane === null ? null : await paneHome($, rt.selfPane)
    const t = await createTab($, at.label, cwd, home?.workspace ?? null)
    live.push({ tab: t.tab, root_pane: t.pane, used: true })
    pane = t.pane
  }
  await writeJson($, p.tab, { tabs: live })
  return pane
}

async function startAgent(
  name: string,
  pane: string,
  launch: 'herdr-kind' | 'command',
  spec: NonNullable<Config['agents'][string]>,
  args: string[],
  cwd: string,
): Promise<{ ok: true; status: string } | { ok: false; status: string; reason: string; screen: string }> {
  const $ = host()
  const failed = async (reason: string) => ({ ok: false as const, status: 'blocked', reason, screen: await readScreen($, pane, 40).catch(() => '') })
  if (launch === 'herdr-kind') {
    try {
      await herdr($, ['agent', 'start', name, '--kind', spec.kind ?? spec.name, '--pane', pane, '--timeout', String(STARTUP_MS), '--', ...args], STARTUP_MS + 15_000)
      return { ok: true, status: 'idle' }
    } catch (err) {
      return failed(err instanceof HerdrError && err.code ? `${err.code}: ${err.message}` : (err as Error).message)
    }
  }
  const env = { ...(spec.env ?? {}), ...(spec.detect_as ? { HERDR_AGENT: spec.detect_as } : {}), OMH_ROLE: 'worker' }
  const line = [
    `cd ${shellQuote(cwd)} && env`,
    ...Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`),
    ...[...(spec.command ?? [spec.bin]), ...args].map(shellQuote),
  ].join(' ')
  try {
    await herdr($, ['pane', 'run', pane, line])
  } catch (err) {
    return failed(`pane run failed: ${(err as Error).message}`)
  }
  // Wait in one host call (a hook's own sleeps count against its budget; a $ call does not).
  const wait = await $.process.run(
    [
      'sh',
      '-c',
      `i=0; while [ $i -lt ${STARTUP_MS / 1000} ]; do
         s=$(herdr agent get "$1" 2>/dev/null | python3 -c 'import json,sys; a=json.load(sys.stdin)["result"]["agent"]; print(a.get("agent_status") or a.get("status") or "")' 2>/dev/null)
         case "$s" in idle|done) echo "$s"; exit 0;; blocked) echo blocked; exit 3;; esac
         i=$((i+1)); sleep 1
       done; echo "timeout:$s"; exit 4`,
      'sh',
      pane,
    ],
    { timeoutMs: STARTUP_MS + 15_000 },
  )
  const status = wait.stdout.trim()
  if (wait.exitCode === 3) return failed('agent_not_ready: stopped at a prompt during startup (login? trust folder?)')
  if (wait.exitCode !== 0) return failed(`herdr never saw the agent become ready (${status || 'no status'})`)
  try {
    await herdr($, ['agent', 'rename', pane, name])
  } catch (err) {
    return failed(`could not name the agent: ${(err as Error).message}`)
  }
  return { ok: true, status }
}

// ------------------------------------------------------------------ dispatch

export type DispatchArgs = {
  task: string
  intent: string
  category?: string
  rationale: string
  brief: string
  worker?: string
  profile?: string
  reviews?: string
  cwd?: string
}

export async function dispatch(a: DispatchArgs): Promise<Answer> {
  const $ = host()
  const p = paths()
  const cfg = await config()

  if (!INTENTS.includes(a.intent as Intent)) return fail(`intent must be one of ${INTENTS.join(', ')} — decide it before dispatching (Intent Gate)`)
  const intent = a.intent as Intent
  if (!a.rationale?.trim()) return fail('rationale is required: one line on why this intent and category fit the task')
  if (!a.brief?.trim()) return fail('brief is required: what the worker must do, the files it owns, and how to check its work')

  // What is being sent: a task of the approved plan, or a scout (read-only, before or beside the plan).
  const scout = isScout(a.task)
  let run: string
  let task: { id: string; title: string; category: string; owns: string[] }
  let workerBase: string
  if (scout) {
    if (!SCOUT_ID.test(a.task)) return fail(`bad scout id '${a.task}' (must match ${SCOUT_ID.source})`)
    if (!SCOUT_INTENTS.includes(intent)) return fail(`a scout is read-only: its intent must be ${SCOUT_INTENTS.join(' or ')}; anything that changes files belongs in the approved plan`)
    run = SCOUT_RUN
    const fallback = intent === 'research' && cfg.categories.librarian ? 'librarian' : 'explore'
    task = { id: a.task, title: a.task, category: a.category ?? fallback, owns: [] }
    workerBase = a.task
    await remove($, p.collected(run, task.id))
  } else {
    const current = await currentRunId($, p)
    if (current === null) {
      return fail(`no plan yet, so '${a.task}' cannot be dispatched. To explore before planning, dispatch a scout instead (task id 'scout-<name>', intent explore or research), or use Explore subagents; then draft plan.md with omh_status action "draft".`)
    }
    run = current
    const plan = await loadPlan(run)
    const found = plan ? findTask(plan, a.task) : null
    if (!plan || !found) return fail(`task '${a.task}' is not in the plan of run ${run}; add it with omh_status action "plan" first (or, to look something up, dispatch a 'scout-<name>' task)`)
    const { wave } = found
    task = found.task

    // Gate: a later wave waits until every earlier gate has passed.
    const gates = await readGates($, p, run)
    const openGate = plan.waves.find(w => w.id < wave.id && !gates.has(w.id))
    if (openGate) {
      return fail(`wave ${wave.id} cannot start: the gate of wave ${openGate.id} (“${openGate.gate}”) has not been marked passed. Verify that wave and use omh_status action "gate".`)
    }
    if (await $.fs.exists(p.verified(run, task.id))) return fail(`task ${task.id} is already verified`)
    workerBase = `w${wave.id}-${task.id}`
  }

  const category = a.category ?? task.category
  if (!cfg.categories[category]) return fail(`unknown category '${category}' (known: ${Object.keys(cfg.categories).join(', ')})`)
  const warnings: string[] = []
  if (!scout && category !== task.category) warnings.push(`category ${category} differs from the plan's ${task.category}`)
  if (!isUsualPair(intent, category)) warnings.push(`intent ${intent} with category ${category} is unusual; rationale recorded`)

  // A task already out with a live worker is not sent twice.
  const ws = await workers()
  const holder = Object.values(ws).find(w => w.run === run && w.task === task.id && !isFree(w) && w.phase !== 'gone')
  if (holder && holder.name !== a.worker) return fail(`task ${task.id} is already with worker '${holder.name}' (${holder.phase}); wait for it or tear that worker down`)

  // Reviewers avoid the reviewed task's family.
  const avoid: string[] = []
  if (a.reviews) {
    const d = await readJson<DispatchFile>($, p.dispatch(run, a.reviews))
    if (d) avoid.push(d.family)
  }

  const q = await quota(cfg)
  let worker: OmhWorker | undefined
  let override = false
  if (a.worker) {
    worker = ws[a.worker]
    if (!worker) return fail(`no worker '${a.worker}'; leave worker out to have one started, or omh_spawn it`)
    if (isSubagentWorker(worker)) return fail(`worker '${a.worker}' is a subagent, which runs one task only; leave worker out (or pass its profile) to start a fresh one`)
    const st = await agentStatus($, worker.pane).catch(() => 'unknown')
    if (st === 'gone') return fail(`worker '${a.worker}' is gone; leave worker out to start a fresh one`)
    if (st === 'working' || st === 'blocked' || (!isFree(worker) && worker.task !== task.id)) {
      return fail(`worker '${a.worker}' is busy (${st}, task ${worker.task ?? 'none'})`)
    }
    const allowed = quotaAllows(cfg, q, worker.profile)
    if (allowed !== true) {
      return fail(JSON.stringify({ error: 'quota-exhausted', worker: worker.name, profile: worker.profile, reason: allowed, hint: 'dispatch again without "worker": routing skips exhausted providers' }))
    }
    override = true
  } else {
    let profile = a.profile
    if (profile) {
      override = true
      if (!cfg.profiles[profile]) return fail(`unknown profile '${profile}'`)
      const allowed = quotaAllows(cfg, q, profile)
      if (allowed !== true) return fail(JSON.stringify({ error: 'quota-exhausted', profile, reason: allowed, hint: 'leave profile out so routing picks one with quota' }))
    } else {
      const r = pickProfile(cfg, category, { intent, avoidFamilies: avoid, quotaOk: pr => quotaAllows(cfg, q, pr) })
      if (!r.ok) return fail(JSON.stringify({ error: 'no-profile', reason: r.error, skipped: r.skipped }))
      profile = r.profile
      warnings.push(...r.warnings)
    }
    if (isSubagentProfile(cfg, profile)) {
      // A subagent is started below, once its brief is written; one per task, never reused.
      if (cfg.maxConcurrent > 0) {
        const live = Object.values(ws).filter(w => w.phase !== 'gone' && !(isSubagentWorker(w) && !ACTIVE.has(w.phase))).length
        if (live >= cfg.maxConcurrent) return fail(`max_concurrent=${cfg.maxConcurrent} workers already running; wait for one or tear one down`)
      }
      const prof = cfg.profiles[profile]!
      worker = newWorker({ name: await freeName(workerBase), pane: subagentPane('starting'), profile, family: prof.family, agent: prof.agent })
    } else {
      // Reuse a free pane worker on that profile; otherwise start one named after the task.
      worker = Object.values(ws).find(w => w.profile === profile && isFree(w) && w.phase !== 'gone' && !isSubagentWorker(w))
      if (worker && (await agentStatus($, worker.pane).catch(() => 'gone')) !== 'idle') worker = undefined
      if (!worker) {
        const name = await freeName(workerBase)
        const s = await spawn({ name, profile, intent, ...(a.cwd !== undefined && { cwd: a.cwd }) })
        if ('text' in s) return s
        worker = s.worker
        warnings.push(...s.warnings)
      }
    }
  }
  const sub = isSubagentWorker(worker)

  const prof = cfg.profiles[worker.profile]
  const dir = p.task(run, task.id)
  const result = p.result(run, task.id)
  const preamble = await preambleFor(cfg, category)
  const brief = [
    preamble,
    a.brief.trim(),
    '',
    `## Files you own`,
    scout
      ? '- None. This is a read-only scout: do not create, change or delete any file in the project. Your only write is the report below. Back every finding with file:line (or a URL for external docs).'
      : task.owns.length > 0
        ? task.owns.map(f => `- ${f}`).join('\n')
        : '- (none listed: change nothing outside what the task needs)',
    '',
    ...(sub
      ? subagentReporting(result)
      : [
          '## How to report back (required)',
          'When you are finished — or cannot continue — write your report to:',
          '',
          `    ${result}`,
          '',
          'Include: summary of what you did or found, files changed (if any), how you verified it (commands and their outcome), and open questions or risks.',
          'Then reply in the chat with exactly one line and nothing else:',
          `DONE ${result}`,
          'or',
          'BLOCKED <one-sentence reason>',
          '',
        ]),
  ]
    .filter(x => x !== null)
    .join('\n')

  const prev = await readJson<DispatchFile>($, p.dispatch(run, task.id))
  await remove($, result)
  await remove($, p.abandoned(run, task.id))
  await $.fs.write(p.brief(run, task.id), brief)
  const now = await $.clock.now()
  const record: DispatchFile = {
    task: task.id,
    worker: worker.name,
    profile: worker.profile,
    family: worker.family,
    model: prof ? (sub ? `${prof.subagentType ?? 'general-purpose'} ${prof.model ?? 'inherit'}` : prof.args.join(' ')) : '',
    intent,
    category,
    rationale: a.rationale.trim(),
    override,
    warnings,
    dispatchedAt: now,
    retries: prev ? prev.retries + 1 : 0,
    outcome: null,
    diagnose: null,
  }
  await writeJson($, p.dispatch(run, task.id), record)
  const instruction = `Read the file ${p.brief(run, task.id)} and carry out the task it describes. Follow its reporting instructions at the end exactly.`

  if (sub) {
    const started = await startSubagent(worker, prof, instruction, `omh ${task.id}`, a.cwd ?? p.root, { run, task: task.id, dir, category, at: now })
    if ('text' in started) {
      if (prev) await writeJson($, p.dispatch(run, task.id), prev)
      else await remove($, p.dispatch(run, task.id))
      return started
    }
    worker = started
  } else {
    const wf = await readJson<WorkerFile>($, p.agent(worker.name))
    if (wf) await writeJson($, p.agent(worker.name), { ...wf, run, task: task.id, task_dir: dir, category })
    try {
      await herdr($, ['agent', 'prompt', worker.name, instruction])
    } catch (err) {
      return fail(`prompt failed for '${worker.name}': ${(err as Error).message}${err instanceof HerdrError && err.code === 'agent_blocked' ? ' — it is waiting on a dialog; read it with herdr agent read and ask the user' : ''}`)
    }
    await feed(worker.name, { kind: 'dispatch', at: now, task: task.id, run })
  }
  await refreshRun()
  return ok(
    [
      `dispatched ${scout ? 'scout ' : ''}${task.id}${scout ? '' : ` (${task.title})`} → ${worker.name} [${worker.profile}, ${worker.family}${sub ? ', subagent' : ''}]`,
      `brief: ${p.brief(run, task.id)}`,
      ...warnings.map(w => `note: ${w}`),
      scout
        ? 'Do not wait or poll. Send the other scouts (and any Explore subagents) now, then end your turn: you will be woken when every scout is back.'
        : 'Do not wait or poll. Keep working on something else or end your turn: you will be woken when the wave settles or a worker needs you.',
    ].join('\n'),
  )
}

/** Start the subagent for a task, record it as a worker and feed the state machine; the worker, or why it did not start. */
async function startSubagent(
  w: OmhWorker,
  prof: Config['profiles'][string] | undefined,
  prompt: string,
  description: string,
  cwd: string,
  t: { run: string; task: string; dir: string; category: string; at: number },
): Promise<OmhWorker | Answer> {
  const $ = host()
  const p = paths()
  const r = await $.agent
    .spawn({ prompt, description, subagentType: prof?.subagentType ?? 'general-purpose', ...(prof?.model !== undefined && { model: prof.model }), cwd })
    .catch(err => ({ deny: (err as Error).message }) as const)
  if (r.deny !== undefined || !r.agentId) return fail(`the subagent for ${t.task} did not start: ${r.deny ?? 'no agent id came back'}`)
  const worker: OmhWorker = { ...w, pane: subagentPane(r.agentId) }
  const file: WorkerFile = { name: w.name, category: t.category, profile: w.profile, family: w.family, agent: w.agent, pane: worker.pane, cwd, run: t.run, task: t.task, task_dir: t.dir }
  await writeJson($, p.agent(w.name), file)
  await setWorker(worker)
  await feed(w.name, { kind: 'dispatch', at: t.at, task: t.task, run: t.run })
  // Spawned means started: it is working from here on.
  await feed(w.name, { kind: 'status', status: 'working', at: await $.clock.now() })
  armSubagentPoll()
  // An end heard before the worker was recorded (a very quick subagent) is applied now.
  const early = rt.subagentEnds.get(r.agentId)
  if (early) await onSubagentEnd(r.agentId, early.reason, early.answer)
  return (await workers())[w.name] ?? worker
}

async function freeName(base: string): Promise<string> {
  const ws = await workers()
  let stem = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '')
  if (!stem) stem = 'w'
  stem = stem.slice(0, 28)
  if (!ws[stem]) return stem
  for (let i = 2; ; i++) if (!ws[`${stem}-${i}`]) return `${stem}-${i}`
}

async function preambleFor(cfg: Config, category: string): Promise<string | null> {
  const $ = host()
  const custom = cfg.categories[category]?.preamble
  let file = `${$.plugin.root}/skills/oh-my-herdr/assets/preambles/${category}.md`
  if (custom) {
    const home = (await $.env.get('HOME')) ?? ''
    file = custom.startsWith('~') ? home + custom.slice(1) : custom.startsWith('/') ? custom : `${cfg.dir}/${custom}`
  }
  try {
    return `${(await $.fs.read(file)).trim()}\n`
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ status operations

async function readText($: ReturnType<typeof host>, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

/** Step one of planning: the plan in prose, for the user to read and approve before any wave exists. */
export async function draftPlan(markdown: string): Promise<Answer> {
  const $ = host()
  const p = paths()
  if (!markdown.trim()) return fail('draft needs "markdown": the plan as markdown (goal, findings, approach, tasks with acceptance checks, risks, open questions)')
  await $.fs.write(p.draft, `${markdown.trim()}\n`)
  await remove($, p.approval)
  const lines = markdown.trim().split('\n').length
  return ok(
    [
      `plan.md written: ${p.draft} (${lines} lines). It is not approved yet.`,
      'Now give the user a short summary (goal, the tasks, anything you need them to decide) and the path, tell them `/omh plan` previews it in a pane beside you, then END YOUR TURN.',
      'Do not write plan.json or dispatch anything: the user reads or edits plan.md and approves it with /omh approve, which wakes you to derive the waves. If they ask for changes, draft again.',
    ].join('\n'),
  )
}

/** /omh approve: the user approves plan.md as it is now. */
export async function approvePlan(): Promise<Answer> {
  const $ = host()
  const p = paths()
  const draft = await readText($, p.draft)
  if (draft === null || draft.trim() === '') return fail(`no plan.md to approve (${p.draft}); ask the lead to draft one first`)
  await $.fs.write(p.approval, `${draftDigest(draft)}\n`)
  const title = draft.trim().split('\n').find(l => l.trim() !== '')?.replace(/^#+\s*/, '') ?? 'plan'
  return ok(`approved plan.md: ${title}`)
}

/** The shell line that shows plan.md: the first of leaf (live reload), glow, bat, less that is installed. */
export function planViewerLine(file: string): string {
  const f = shellQuote(file)
  return [
    `if command -v leaf >/dev/null 2>&1; then leaf --watch ${f}`,
    `elif command -v glow >/dev/null 2>&1; then glow -p ${f}`,
    `elif command -v bat >/dev/null 2>&1; then bat --paging=always --language=markdown ${f}`,
    `else less -R ${f}; fi; exit`,
  ].join('; ')
}

/** The plan.md to show: the draft, else the approved plan.md of the current run; null when neither has text. */
export async function planFile(): Promise<string | null> {
  const $ = host()
  const p = paths()
  if (await hasText($, p.draft)) return p.draft
  const run = await currentRunId($, p)
  return run !== null && (await hasText($, p.planMd(run))) ? p.planMd(run) : null
}

/** /omh plan without prismantis: open plan.md in a herdr pane beside the lead, or close that pane if it is open. */
export async function togglePlanView(): Promise<Answer> {
  const $ = host()
  const p = paths()
  const open = await readJson<{ pane: string }>($, p.planView)
  if (open && (await paneExists($, open.pane))) {
    await closePane($, open.pane).catch(() => undefined)
    await remove($, p.planView)
    return ok('plan preview closed')
  }
  const file = await planFile()
  if (file === null) return fail(`no plan.md yet (${p.draft}); the lead writes it with omh_status action "draft"`)
  if (rt.selfPane === null) return fail('cannot tell which herdr pane is the lead (HERDR_PANE_ID is not set)')
  try {
    const pane = await splitPane($, rt.selfPane, 'right', p.root)
    await writeJson($, p.planView, { pane })
    await herdr($, ['pane', 'run', pane, planViewerLine(file)])
    return ok(`plan preview opened beside you (${file}); quit the viewer or run /omh plan again to close it`)
  } catch (err) {
    return fail(`could not open the preview: ${(err as Error).message}`)
  }
}

export async function writePlan(raw: unknown, newRun: boolean): Promise<Answer> {
  const $ = host()
  const p = paths()
  // Waves come from an approved plan.md, never straight from exploring.
  const draft = await readText($, p.draft)
  if (draft === null || draft.trim() === '') {
    return fail('no plan.md yet. First write the plan in prose with omh_status action "draft" (markdown), show the user a summary, and end your turn until they approve it with /omh approve.')
  }
  if (!isApproved(draft, await readText($, p.approval))) {
    return fail(`plan.md (${p.draft}) is not approved, or changed after it was approved. Ask the user to read it and run /omh approve, then end your turn. Do not dispatch anything until then.`)
  }
  const cfg = await config()
  const parsed = parsePlan(raw, Object.keys(cfg.categories))
  if ('errors' in parsed) return fail(`plan rejected:\n- ${parsed.errors.join('\n- ')}`)
  let run = await currentRunId($, p)
  if (run !== null && !newRun) {
    // Replanning keeps tasks already out: they must stay in the plan.
    const old = await loadPlan(run)
    for (const w of old?.waves ?? []) {
      for (const t of w.tasks) {
        if ((await $.fs.exists(p.dispatch(run, t.id))) && !findTask(parsed.plan, t.id)) {
          return fail(`task ${t.id} was already dispatched in run ${run}; keep it in the plan, or pass new_run: true to start a new run`)
        }
      }
    }
  } else {
    const d = new Date(await $.clock.now())
    const pad = (n: number) => String(n).padStart(2, '0')
    const slug = parsed.plan.goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'run'
    run = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${slug}`
  }
  await writeJson($, p.plan(run), parsed.plan)
  await $.fs.write(p.planMd(run), draft)
  await $.fs.write(p.currentRun, `${run}\n`)
  // One approval, one plan.json: a later replan needs plan.md approved again.
  await remove($, p.approval)
  const view = await refreshRun()
  return ok(`plan saved for run ${run} (${parsed.plan.waves.length} wave(s), ${parsed.plan.waves.reduce((n, w) => n + w.tasks.length, 0)} task(s)). Current wave: ${view?.current ?? 'none'}. Dispatch its tasks with omh_dispatch.`)
}

export async function closeTask(taskId: string, quality: string, how: 'verified' | 'abandoned'): Promise<Answer> {
  const $ = host()
  const p = paths()
  if (!quality?.trim()) return fail('quality is required: one line on how good the result was (what held up, what you had to fix)')
  if (isScout(taskId)) {
    if (how === 'verified') return fail(`${taskId} is a scout: omh_collect closes it (there is nothing to verify); use action "abandon" for one without a usable report`)
    return (await closeScout(taskId, quality.trim())) ?? ok(`scout ${taskId} abandoned`)
  }
  const run = await currentRunId($, p)
  if (run === null) return fail('no run in progress')
  const plan = await loadPlan(run)
  if (!plan || !findTask(plan, taskId)) return fail(`task '${taskId}' is not in the plan of run ${run}`)
  if (how === 'verified' && !(await hasText($, p.result(run, taskId)))) {
    // Allowed (the lead may have done it) but said.
  }
  const holder = Object.values(await workers()).find(w => w.run === run && w.task === taskId)
  if (holder && (holder.phase === 'running' || holder.phase === 'dispatched' || holder.phase === 'checking')) {
    return fail(`task ${taskId} is still with worker '${holder.name}' (${holder.phase}); wait until it settles`)
  }
  const closing: Closing = { at: await $.clock.now(), quality: quality.trim() }
  await writeJson($, how === 'verified' ? p.verified(run, taskId) : p.abandoned(run, taskId), closing)
  await recordHistory(run, taskId, closing, how)
  if (holder) await setWorker({ ...holder, phase: holder.phase === 'gone' ? 'gone' : 'idle', task: null, run: null, diagnosis: null })
  const view = await refreshRun()
  const wave = view?.waves.find(w => w.tasks.some(t => t.id === taskId))
  const open = wave?.tasks.filter(t => !DONE.has(t.status)).map(t => t.id) ?? []
  return ok(`${taskId} marked ${how}. ${open.length > 0 ? `Wave ${wave?.id} still open: ${open.join(', ')}.` : `Every task in wave ${wave?.id} is closed: run its gate (“${wave?.gate}”) and mark it with omh_status action "gate".`}`)
}

export async function passGate(waveId: number, note: string | undefined): Promise<Answer> {
  const $ = host()
  const p = paths()
  const run = await currentRunId($, p)
  if (run === null) return fail('no run in progress')
  const view = await refreshRun()
  const wave = view?.waves.find(w => w.id === waveId)
  if (!view || !wave) return fail(`no wave ${waveId} in run ${run}`)
  const open = wave.tasks.filter(t => !DONE.has(t.status))
  if (open.length > 0) return fail(`wave ${waveId} has tasks not verified or abandoned: ${open.map(t => `${t.id} (${t.status})`).join(', ')}`)
  const gates = await readGates($, p, run)
  gates.add(waveId)
  await writeJson($, p.gates(run), { passed: [...gates].sort((x, y) => x - y), ...(note ? { notes: { [waveId]: note } } : {}) })
  const after = await refreshRun()
  return ok(after?.current == null ? `gate ${waveId} passed. Every wave is done: run the final acceptance check, report, and omh_teardown.` : `gate ${waveId} passed. Wave ${after.current} may start now.`)
}

/** The lead reads the full table; /omh status shows a person the brief one unless asked for full. */
export async function status(form: 'full' | 'brief' = 'full'): Promise<Answer> {
  const view = await refreshRun()
  return ok((form === 'brief' ? statusBrief : statusText)(view, await workers()))
}

/** Close a scout: mark it collected (or abandoned, with a quality note) and free its worker. */
async function closeScout(taskId: string, quality: string | null): Promise<Answer | null> {
  const $ = host()
  const p = paths()
  if (!(await $.fs.exists(p.dispatch(SCOUT_RUN, taskId)))) return fail(`no scout '${taskId}' was dispatched`)
  const holder = Object.values(await workers()).find(w => w.run === SCOUT_RUN && w.task === taskId)
  if (holder && (holder.phase === 'running' || holder.phase === 'dispatched' || holder.phase === 'checking')) {
    return fail(`scout ${taskId} is still with worker '${holder.name}' (${holder.phase}); wait until it settles`)
  }
  const closing: Closing = { at: await $.clock.now(), quality: quality ?? 'collected' }
  await writeJson($, p.collected(SCOUT_RUN, taskId), closing)
  if (quality !== null) await recordHistory(SCOUT_RUN, taskId, closing, 'abandoned')
  if (holder) await setWorker({ ...holder, phase: holder.phase === 'gone' ? 'gone' : 'idle', task: null, run: null, diagnosis: null })
  return quality === null ? null : ok(`scout ${taskId} abandoned; its worker is free.`)
}

export async function collect(taskId: string): Promise<Answer> {
  const $ = host()
  const p = paths()
  if (isScout(taskId)) {
    if (!SCOUT_ID.test(taskId)) return fail(`bad scout id '${taskId}'`)
    const file = p.result(SCOUT_RUN, taskId)
    if (!(await hasText($, file))) return fail(`no report from scout '${taskId}' yet (${file})`)
    const text = (await $.fs.read(file)).trim()
    const closed = await closeScout(taskId, null)
    if (closed !== null) return closed
    return ok(
      [
        `===== scout ${taskId} (${file}) =====`,
        text,
        '=====',
        'Scout closed and its worker freed. Its findings are claims: spot-check the file:line evidence you build the plan on.',
      ].join('\n'),
    )
  }
  const run = await currentRunId($, p)
  if (run === null) return fail('no run in progress')
  if (!TASK_ID.test(taskId)) return fail(`bad task id '${taskId}'`)
  const file = p.result(run, taskId)
  if (!(await hasText($, file))) return fail(`no result for task '${taskId}' yet (${file})`)
  return ok(
    [
      `===== ${taskId} (${file}) =====`,
      (await $.fs.read(file)).trim(),
      '=====',
      'This report is the worker\'s claim, not a fact. Verify it yourself (run the checks, read the diff) before marking it verified.',
    ].join('\n'),
  )
}

export async function teardown(names: string[] | undefined): Promise<Answer> {
  const $ = host()
  const p = paths()
  const files = await listWorkers($, p)
  const ws = await workers()
  const targets = names && names.length > 0 ? names : [...new Set([...files.map(f => f.name), ...Object.keys(ws)])]
  if (targets.length === 0) return ok('no workers on record')
  const lines: string[] = []
  for (const n of targets) {
    const pane = files.find(f => f.name === n)?.pane ?? ws[n]?.pane
    stopWatcher(n)
    if (!pane) {
      lines.push(`${n}: not on record`)
      continue
    }
    if (pane === rt.selfPane) {
      lines.push(`${n}: refusing to close the lead's own pane`)
      continue
    }
    if (isSubagentPane(pane)) {
      // No call stops a subagent from here: forget it; one still running finishes on its own.
      const w = ws[n]
      lines.push(`${n}: subagent forgotten${w && ACTIVE.has(w.phase) ? ' (still running: it finishes on its own; stop it from the agents view if needed)' : ''}`)
      await remove($, p.agent(n))
      await dropWorker(n)
      continue
    }
    if (await paneExists($, pane)) {
      try {
        await closePane($, pane)
        lines.push(`${n}: closed ${pane}`)
      } catch (err) {
        lines.push(`${n}: could not close ${pane}: ${(err as Error).message}`)
      }
    } else lines.push(`${n}: pane ${pane} already gone`)
    await remove($, p.agent(n))
    await dropWorker(n)
  }
  if ((await listWorkers($, p)).length === 0) await remove($, p.tab)
  await refreshRun()
  return ok(lines.join('\n'))
}

// ------------------------------------------------------------------ check

export async function check(): Promise<Answer> {
  const $ = host()
  const which = async (bin: string) => (await $.process.run(['sh', '-c', 'command -v "$1"', 'sh', bin]).catch(() => null))?.stdout.trim() || null
  const env: string[][] = [['inside herdr', (await $.env.get('HERDR_ENV')) === '1' ? `✅ yes (pane ${rt.selfPane ?? '?'})` : '⛔ no: oh-my-herdr needs herdr']]
  for (const bin of ['herdr', 'python3', 'git']) env.push([bin, (await which(bin)) ? '✅ ok' : '⛔ missing'])
  let cfg: Config
  try {
    cfg = await config()
  } catch (err) {
    return fail(['oh-my-herdr check: the config did not load.', '', table(['Check', 'Result'], [...env, ['config', `⛔ ${(err as Error).message}`]])].join('\n'))
  }
  const agents: string[][] = []
  for (const a of new Set(Object.values(cfg.profiles).map(pr => pr.agent))) {
    const spec = cfg.agents[a]
    if (spec?.launch === 'subagent') agents.push([a, 'subagent', '✅ a Claude Code subagent of this session'])
    else if (!spec) agents.push([a, '', '⛔ unknown agent'])
    else agents.push([a, spec.launch, (await which(spec.bin)) ? `✅ ${code(spec.bin)}` : `⛔ missing ${code(spec.bin)}`])
  }
  const problems = configProblems(cfg)
  const profiles = Object.entries(cfg.profiles).map(([n, pr]) => [
    n,
    pr.agent,
    pr.family,
    providerOf(pr) ?? '-',
    pr.subagentType !== undefined ? `${pr.subagentType} · ${pr.model ?? 'inherit'}` : pr.args.length > 0 ? code(pr.args.join(' ')) : '',
  ])
  const categories = Object.entries(cfg.categories).map(([n, c]) => [n, c.profiles.join(' → ')])
  await refreshQuota(undefined, true)
  const text = [
    `oh-my-herdr check · config ${code(cfg.file)} · ${problems.length === 0 ? 'no problems' : `${problems.length} problem${problems.length === 1 ? '' : 's'}`}`,
    '',
    table(['Check', 'Result'], env),
    ...(problems.length > 0 ? ['', '### Problems', '', ...problems.map(pr => `- ⛔ ${pr}`)] : []),
    '',
    '### Agents',
    '',
    table(['Agent', 'Launch', 'Result'], agents),
    '',
    `### Profiles · at most ${cfg.maxConcurrent || '∞'} workers, ${cfg.maxPanesPerTab} panes a tab`,
    '',
    table(['Profile', 'Agent', 'Family', 'Bills', 'Runs'], profiles),
    '',
    '### Categories · the first usable profile wins',
    '',
    table(['Category', 'Profiles'], categories),
    '',
    '### Quota',
    '',
    formatQuota(cfg, await $.state.quota.get()),
    '',
    `project ${code(paths().root)} · state ${code(paths().omh)} · history ${code(await historyFile())}`,
  ].join('\n')
  return { ok: problems.length === 0, text }
}

export async function quotaReport(): Promise<Answer> {
  const cfg = await config()
  await refreshQuota(undefined, true)
  return ok(formatQuota(cfg, await host().state.quota.get()))
}

export { diagnoseWorker }
