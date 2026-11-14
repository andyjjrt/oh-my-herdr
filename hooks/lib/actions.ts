// What the tools and commands do: spawn, dispatch, plan, verify, gate, collect, teardown, check.
// Each returns { ok, text } for the model; errors are answers, not exceptions.


import type { OmhWorker } from '../../types'
import { configProblems, type Config } from './config'
import { diagnose, excerpt } from './diagnose'
import { currentRunId, hasText, listWorkers, readGates, readJson, remove, writeJson, type Closing, type DispatchFile, type WorkerFile } from './files'
import { agentStatus, closePane, createTab, herdr, HerdrError, paneExists, readScreen, shellQuote, splitPane } from './herdr'
import { DONE, draftDigest, findTask, isApproved, parsePlan, TASK_ID } from './plan'
import { formatQuota, providerOf, quotaAllows } from './quota'
import { INTENTS, isUsualPair, pickProfile, type Intent } from './route'
import { isFree, newWorker } from './settle'
import {
  config,
  diagnoseWorker,
  dropWorker,
  feed,
  host,
  historyFile,
  loadPlan,
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
    const allowed = quotaAllows(cfg, q, args.profile)
    if (allowed !== true) return fail(JSON.stringify({ error: 'quota-exhausted', profile: args.profile, reason: allowed, hint: 'pick another profile, or leave profile out so routing skips exhausted providers' }))
    profile = args.profile
  } else if (args.category) {
    const r = pickProfile(cfg, args.category, { intent: args.intent ?? null, avoidFamilies: args.avoidFamilies ?? [], quotaOk: pr => quotaAllows(cfg, q, pr) })
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
  const cwd = args.cwd ?? p.root

  // A pane in the omh-workers tab: split beside a live worker, else the tab's root, else a new tab.
  let pane: string | null = null
  const tab = await readJson<{ tab: string; root_pane: string; used?: boolean }>($, p.tab)
  try {
    if (tab) {
      const files = await listWorkers($, p)
      let anchor: string | null = null
      for (const f of files) if (await paneExists($, f.pane)) anchor = f.pane
      if (anchor === null && (await paneExists($, tab.root_pane))) {
        if (!tab.used) {
          pane = tab.root_pane
          await writeJson($, p.tab, { ...tab, used: true })
        } else anchor = tab.root_pane
      }
      if (pane === null && anchor !== null) {
        pane = await splitPane($, anchor, files.length % 2 === 0 ? 'right' : 'down', cwd)
      }
    }
    if (pane === null) {
      const t = await createTab($, 'omh-workers', cwd)
      await writeJson($, p.tab, { tab: t.tab, root_pane: t.pane, used: true })
      pane = t.pane
    }
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

  const run = await currentRunId($, p)
  if (run === null) return fail('no plan yet: write one with omh_status action "plan" before dispatching')
  const plan = await loadPlan(run)
  const found = plan ? findTask(plan, a.task) : null
  if (!plan || !found) return fail(`task '${a.task}' is not in the plan of run ${run}; add it with omh_status action "plan" first`)
  const { task, wave } = found

  // Gate: a later wave waits until every earlier gate has passed.
  const gates = await readGates($, p, run)
  const openGate = plan.waves.find(w => w.id < wave.id && !gates.has(w.id))
  if (openGate) {
    return fail(`wave ${wave.id} cannot start: the gate of wave ${openGate.id} (“${openGate.gate}”) has not been marked passed. Verify that wave and use omh_status action "gate".`)
  }
  if (await $.fs.exists(p.verified(run, task.id))) return fail(`task ${task.id} is already verified`)

  const category = a.category ?? task.category
  if (!cfg.categories[category]) return fail(`unknown category '${category}' (known: ${Object.keys(cfg.categories).join(', ')})`)
  const warnings: string[] = []
  if (category !== task.category) warnings.push(`category ${category} differs from the plan's ${task.category}`)
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
    // Reuse a free worker on that profile; otherwise start one named after the task.
    worker = Object.values(ws).find(w => w.profile === profile && isFree(w) && w.phase !== 'gone')
    if (worker && (await agentStatus($, worker.pane).catch(() => 'gone')) !== 'idle') worker = undefined
    if (!worker) {
      const name = await freeName(`w${wave.id}-${task.id}`)
      const s = await spawn({ name, profile, intent, ...(a.cwd !== undefined && { cwd: a.cwd }) })
      if ('text' in s) return s
      worker = s.worker
      warnings.push(...s.warnings)
    }
  }

  const prof = cfg.profiles[worker.profile]
  const dir = p.task(run, task.id)
  const result = p.result(run, task.id)
  const preamble = await preambleFor(cfg, category)
  const brief = [
    preamble,
    a.brief.trim(),
    '',
    `## Files you own`,
    task.owns.length > 0 ? task.owns.map(f => `- ${f}`).join('\n') : '- (none listed: change nothing outside what the task needs)',
    '',
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
    model: prof ? prof.args.join(' ') : '',
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
  const wf = await readJson<WorkerFile>($, p.agent(worker.name))
  if (wf) await writeJson($, p.agent(worker.name), { ...wf, run, task: task.id, task_dir: dir, category })

  try {
    await herdr($, ['agent', 'prompt', worker.name, `Read the file ${p.brief(run, task.id)} and carry out the task it describes. Follow its reporting instructions at the end exactly.`])
  } catch (err) {
    return fail(`prompt failed for '${worker.name}': ${(err as Error).message}${err instanceof HerdrError && err.code === 'agent_blocked' ? ' — it is waiting on a dialog; read it with herdr agent read and ask the user' : ''}`)
  }
  await feed(worker.name, { kind: 'dispatch', at: now, task: task.id, run })
  await refreshRun()
  return ok(
    [
      `dispatched ${task.id} (${task.title}) → ${worker.name} [${worker.profile}, ${worker.family}]`,
      `brief: ${p.brief(run, task.id)}`,
      ...warnings.map(w => `note: ${w}`),
      'Do not wait or poll. Keep working on something else or end your turn: you will be woken when the wave settles or a worker needs you.',
    ].join('\n'),
  )
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
      'Now give the user a short summary (goal, the tasks, anything you need them to decide) and the path, then END YOUR TURN.',
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

export async function collect(taskId: string): Promise<Answer> {
  const $ = host()
  const p = paths()
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
  const lines: string[] = []
  const row = (k: string, v: string) => lines.push(`${k.padEnd(26)} ${v}`)
  row('inside herdr', (await $.env.get('HERDR_ENV')) === '1' ? `yes (pane ${rt.selfPane ?? '?'})` : 'NO — oh-my-herdr needs herdr')
  const which = async (bin: string) => (await $.process.run(['sh', '-c', 'command -v "$1"', 'sh', bin]).catch(() => null))?.stdout.trim() || null
  for (const bin of ['herdr', 'python3', 'git']) row(bin, (await which(bin)) ? 'ok' : 'MISSING')
  let cfg: Config
  try {
    cfg = await config()
  } catch (err) {
    row('config', `ERROR ${(err as Error).message}`)
    return fail(lines.join('\n'))
  }
  lines.push('', `== agents used by profiles ==`)
  for (const a of new Set(Object.values(cfg.profiles).map(pr => pr.agent))) {
    const spec = cfg.agents[a]
    row(a, spec ? ((await which(spec.bin)) ? `ok (${spec.bin}, ${spec.launch})` : `MISSING ${spec.bin}`) : 'unknown agent')
  }
  lines.push('', `== config: ${cfg.file} ==`)
  const problems = configProblems(cfg)
  for (const pr of problems) lines.push(`  problem: ${pr}`)
  lines.push('profiles:')
  for (const [n, pr] of Object.entries(cfg.profiles)) lines.push(`  ${n.padEnd(16)} ${pr.agent.padEnd(8)} ${pr.family.padEnd(9)} ${providerOf(pr) ?? '-'}  ${pr.args.join(' ')}`)
  lines.push('categories (first usable wins):')
  for (const [n, c] of Object.entries(cfg.categories)) lines.push(`  ${n.padEnd(20)} ${c.profiles.join(' → ')}`)
  lines.push('', '== quota ==')
  await refreshQuota(undefined, true)
  lines.push(formatQuota(cfg, await $.state.quota.get()))
  lines.push('', `project: ${paths().root}`, `state:   ${paths().omh}`, `history: ${await historyFile()}`)
  return { ok: problems.length === 0, text: lines.join('\n') }
}

export async function quotaReport(): Promise<Answer> {
  const cfg = await config()
  await refreshQuota(undefined, true)
  return ok(formatQuota(cfg, await host().state.quota.get()))
}

export { diagnoseWorker }
