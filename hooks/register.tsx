// oh-my-herdr: wiring only. Each hook hands off to hooks/lib; outside herdr, or inside a worker
// pane (OMH_ROLE=worker), every hook passes straight through.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { approvePlan, check, closeTask, collect, dispatch, draftPlan, passGate, planFile, quotaReport, spawn, status, teardown, togglePlanView, writePlan, type Answer } from './lib/actions'
import { BOARD_ID, boardView } from './lib/board'
import { bind, readEnv } from './lib/engine'
import { Paths } from './lib/files'
import { ownerOf, relativeTo } from './lib/guards'
import { loadPlan, config, flushWake, onSubagentEnd, optionsOf, reconcile, refreshQuota, refreshRun, rt, workers } from './lib/runtime'
import { subagentIdOf } from './lib/subagent'
import { ACTIVE } from './lib/settle'
import { statusText, ulwPrompt } from './lib/text'
import { progressPanel, statusTail } from './lib/statusbar'
import { compactCall, compactResult, OMH_TOOL, resultText } from './lib/toolrow'
import { drawMarkdown, hasPrismantis, looksLikeMarkdown, splitCollected } from './lib/prismantis'

// The same refs as hooks/lib/engine.ts: a read must name a const of its own file, and a read made
// while drawing subscribes the drawing to the value.
const RUN = atom({ plugin: 'oh-my-herdr', key: 'run' } as const, null, { shape: 'run-1' })
const WORKERS = atom({ plugin: 'oh-my-herdr', key: 'workers' } as const, {}, { shape: 'workers-1' })
const QUOTA = atom({ plugin: 'oh-my-herdr', key: 'quota' } as const, {}, { shape: 'quota-1' })
const CONTINUE = atom({ plugin: 'oh-my-herdr', key: 'continueCount' } as const, 0)
const BOARD_OPEN = atom({ plugin: 'oh-my-herdr', key: 'boardOpen' } as const, false)

/** /omh plan's pane when prismantis draws it; without prismantis plan.md shows in a herdr pane instead. */
const PLAN_ID = 'omh-plan'

const TOOLS = [
  {
    name: 'omh_dispatch',
    description: [
      'Send one task of the current plan to a worker agent (a herdr pane, a herdr-core terminal or a subagent), and return at once.',
      'Intent Gate: decide the task\'s intent and category first and say why in `rationale`. The worker\'s agent and model are chosen from the category by the config and current quota; leave `worker` and `profile` out unless the user asked for one.',
      'Never wait or poll after dispatching: you are woken with a results table when the wave settles, or at once when a worker is blocked, stalled or dies (with a diagnosis).',
      'Scouts: a task id `scout-<name>` with intent explore or research needs no plan — use them while exploring before plan.md, several at once, for long reads or external docs on cheaper models. They are read-only, have no wave or gate, and you are woken once all scouts are back; omh_collect closes each.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task id from plan.json, or `scout-<name>` for a read-only scout before/beside the plan' },
        intent: { type: 'string', enum: ['explore', 'research', 'implement', 'fix', 'review', 'plan', 'write'] },
        category: { type: 'string', description: 'Routing category (defaults to the plan\'s; for a scout, explore — or librarian for research)' },
        rationale: { type: 'string', description: 'One line: why this intent and category fit' },
        brief: { type: 'string', description: 'Markdown brief: goal, context, constraints, acceptance checks. The files the task owns and the reporting contract are appended for you.' },
        worker: { type: 'string', description: 'Reuse this free worker by name (optional)' },
        profile: { type: 'string', description: 'Force a profile (optional; recorded as an override)' },
        reviews: { type: 'string', description: 'For a review: the task id under review, so the reviewer comes from another model family' },
        cwd: { type: 'string', description: 'Working directory for a newly started worker (default: project root)' },
      },
      required: ['task', 'intent', 'rationale', 'brief'],
    },
  },
  {
    name: 'omh_status',
    description: [
      'The run\'s plan and progress. action "show": waves, tasks, workers. "draft": write the plan in prose (goal, findings with file:line, approach, tasks with acceptance checks, risks, open questions) as the run\'s draft.md; give "name" to start a run for new work (.omh/runs/<date>-<name>/), leave it out to revise the current run\'s plan. Then summarise it for the user and end your turn — /omh approve makes it the run\'s plan.md.',
      '"plan": only after plan.md is approved, save the current run\'s plan.json derived from it (goal; waves with id, gate and tasks; each task id, title, intent, category, owns[], deps[]); tasks in one wave must not own the same files, and category is a routing name from the config, not the intent. A rejected plan can be fixed and sent again; a different plan.md needs a new draft and approval.',
      '"verified" / "abandon": close a task with a one-line `quality` note on how good the result was ("abandon" also closes a scout that brought nothing back). "gate": mark a wave\'s gate passed once all its tasks are closed; the next wave cannot be dispatched before that.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['show', 'draft', 'plan', 'verified', 'abandon', 'gate'] },
        markdown: { type: 'string', description: 'For "draft": the whole plan, as markdown' },
        name: { type: 'string', description: 'For "draft": a short slug naming new work, which starts a new run (.omh/runs/<date>-<name>/). Leave it out to revise the current run\'s plan.' },
        plan: { type: 'object', description: 'For "plan": { goal, waves: [{ id, gate, tasks: [{ id, title, intent, category, owns, deps }] }] }' },
        task: { type: 'string' },
        quality: { type: 'string', description: 'For "verified"/"abandon": one sentence on the result\'s quality' },
        wave: { type: 'number', description: 'For "gate"' },
        note: { type: 'string', description: 'For "gate": how it was checked' },
      },
      required: ['action'],
    },
  },
  {
    name: 'omh_collect',
    description: 'Read a task\'s result.md. It is the worker\'s claim: verify it yourself before marking the task verified. For a scout (`scout-*`), collecting also closes it and frees its worker.',
    inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
  },
  {
    name: 'omh_spawn',
    description: 'Start a worker ahead of time (optional: omh_dispatch starts one when needed). Picks the profile from the category, skipping providers out of quota.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '[a-z][a-z0-9_-]{0,31}' },
        category: { type: 'string' },
        profile: { type: 'string' },
        avoid_families: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    },
  },
  {
    name: 'omh_teardown',
    description: 'Close worker panes and stop watching them (all workers when none are named). Never closes your own pane.',
    inputSchema: { type: 'object', properties: { workers: { type: 'array', items: { type: 'string' } } } },
  },
] as const

type Args = Record<string, unknown>
const s = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

async function serve(name: string, a: Args): Promise<Answer> {
  switch (name) {
    case 'omh_dispatch':
      return dispatch({
        task: s(a.task) ?? '',
        intent: s(a.intent) ?? '',
        rationale: s(a.rationale) ?? '',
        brief: s(a.brief) ?? '',
        ...(s(a.category) && { category: s(a.category)! }),
        ...(s(a.worker) && { worker: s(a.worker)! }),
        ...(s(a.profile) && { profile: s(a.profile)! }),
        ...(s(a.reviews) && { reviews: s(a.reviews)! }),
        ...(s(a.cwd) && { cwd: s(a.cwd)! }),
      })
    case 'omh_status':
      switch (a.action) {
        case 'draft':
          return draftPlan(typeof a.markdown === 'string' ? a.markdown : '', s(a.name))
        case 'plan':
          return writePlan(a.plan)
        case 'verified':
          return closeTask(s(a.task) ?? '', s(a.quality) ?? '', 'verified')
        case 'abandon':
          return closeTask(s(a.task) ?? '', s(a.quality) ?? '', 'abandoned')
        case 'gate':
          return typeof a.wave === 'number' ? passGate(a.wave, s(a.note)) : { ok: false, text: 'gate needs "wave"' }
        default:
          return status()
      }
    case 'omh_collect':
      return collect(s(a.task) ?? '')
    case 'omh_spawn': {
      const r = await spawn({
        name: s(a.name) ?? '',
        ...(s(a.category) && { category: s(a.category)! }),
        ...(s(a.profile) && { profile: s(a.profile)! }),
        avoidFamilies: Array.isArray(a.avoid_families) ? a.avoid_families.filter((x): x is string => typeof x === 'string') : [],
      })
      if ('text' in r) return r
      return { ok: true, text: [`started ${r.worker.name} in pane ${r.worker.pane} [${r.worker.profile}, ${r.worker.family}]`, ...r.warnings.map(w => `note: ${w}`)].join('\n') }
    }
    case 'omh_teardown':
      return teardown(Array.isArray(a.workers) ? a.workers.filter((x): x is string => typeof x === 'string') : undefined)
  }
  return { ok: false, text: `unknown tool ${name}` }
}

/**
 * Outside herdr and herdr-core (a herdr pane, or an hc terminal such as a Herdr app pane), or inside
 * a worker this mod started, the mod does nothing.
 */
const isDormant = (env: Awaited<ReturnType<typeof readEnv>>) => (env.HERDR_ENV !== '1' && !env.HC_TERMINAL_ID) || env.OMH_ROLE === 'worker'

async function boot($: EngineInterface, cwd: string): Promise<boolean> {
  const env = await readEnv($)
  if (isDormant(env)) {
    rt.$ = null
    return false
  }
  rt.$ = bind($, env)
  const root = (await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd }).catch(() => null))?.stdout.trim() || cwd
  rt.paths = new Paths(root, env.OMH_DIR || `${root}/.omh`)
  rt.watchPy = `${$.plugin.root}/skills/oh-my-herdr/scripts/omh-watch.py`
  rt.selfPane = env.HERDR_PANE_ID ?? null
  rt.selfTerminal = env.HC_TERMINAL_ID ?? null
  await config().catch(() => undefined)
  return true
}

export const register: Register = (on, options) => {
  rt.options = optionsOf(options)
  const live = () => rt.$ !== null

  on('session.start', async ($, e, next) => {
    if (!(await boot($, e.cwd))) return next(e)
    await Promise.all([
      ...TOOLS.map(t => $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema as unknown as Record<string, unknown>, isDeferred: false }).catch(() => undefined)),
      $.command.register({ name: 'ulw', description: 'oh-my-herdr: ultrawork — plan, fan out to worker agents, verify', argumentHint: '<goal>' }).catch(() => undefined),
      $.command.register({ name: 'omh', description: 'oh-my-herdr: status | plan | approve | quota | check | board | teardown', argumentHint: 'status [full]|plan|approve|quota|check|board|teardown', immediate: true }).catch(() => undefined),
    ])
    // Reattaching watchers reads herdr and the disk: keep it out of the session's start.
    $.clock.after(0, () => {
      void (async () => {
        await reconcile()
        await refreshRun()
        await flushWake()
        await refreshQuota()
      })().catch(err => $.ui.log(`oh-my-herdr: start failed: ${(err as Error).message}`, { to: 'debug' }))
    })
    $.clock.every(120_000, () => {
      void (async () => {
        if ((await read($, RUN)) !== null) await refreshQuota()
      })().catch(() => undefined)
    })
    return next(e)
  })

  // ---------------------------------------------------------------- tools

  on(
    'tool.call',
    { tool: /^mcp__oh-my-herdr__omh_(dispatch|status|collect|spawn|teardown)$/ },
    async ($, e, next) => {
      if (!live()) return next(e)
      const { tool, tool_use_id: _id, ...args } = e as unknown as Args & { tool: string }
      const name = tool.replace(/^mcp__oh-my-herdr__/, '')
      try {
        const answer = await serve(name, args)
        // A new draft redraws an open plan pane.
        if (answer.ok && name === 'omh_status' && (args as { action?: unknown }).action === 'draft') $.ui.invalidate('ui.render')
        return { result: answer.ok ? answer.text : `ERROR: ${answer.text}` }
      } catch (err) {
        return { result: `ERROR: ${name} failed: ${(err as Error).message}` }
      }
    },
  ).catch(($, e, next) => (next.called ? next(e) : { deny: 'oh-my-herdr: the tool handler failed; see the debug log' }))

  // ---------------------------------------------------------------- commands

  on('command.run', { command: 'ulw' }, async ($, e, next) => {
    if (!live()) return next(e)
    const text = ulwPrompt(e.args)
    // Submitting from inside the command's own dispatch is refused; do it once the command is done.
    $.clock.after(0, () => {
      $.prompt.submit({ text, asUser: true }).catch(err => $.ui.toast(`oh-my-herdr: /ulw could not start: ${(err as Error).message}`))
    })
    return { text: `ultrawork: ${e.args.trim() || '(no goal given)'}` }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'omh' }, async ($, e, next) => {
    if (!live()) return next(e)
    const sub = e.args.trim().split(/\s+/)[0] || 'status'
    switch (sub) {
      case 'status':
        return { text: (await status(e.args.trim().split(/\s+/)[1] === 'full' ? 'full' : 'brief')).text }
      case 'quota':
        return { text: (await quotaReport()).text }
      case 'check':
        return { text: (await check()).text }
      case 'teardown':
        return { text: (await teardown(undefined)).text }
      case 'approve': {
        const answer = await approvePlan()
        // The lead ended its turn to wait for this: wake it to split the plan into waves.
        if (answer.ok) {
          $.clock.after(0, () => {
            $.prompt
              .submit({ text: `plan.md approved (/omh approve). Derive the waves from ${answer.file ?? "the current run's plan.md"} with omh_status action "plan", then dispatch the first wave.`, asUser: true })
              .catch(err => $.ui.toast(`oh-my-herdr: could not wake the lead: ${(err as Error).message}`))
          })
        }
        return { text: answer.text }
      }
      case 'plan': {
        if (!(await hasPrismantis($ as never, 'terminal'))) return { text: (await togglePlanView()).text }
        if ((await $.ui.panes()).some((p: { id: string }) => p.id === PLAN_ID)) {
          await $.ui.close({ id: PLAN_ID })
          return { text: 'plan preview closed' }
        }
        const file = await planFile()
        if (file === null) return { text: 'no plan.md yet; the lead writes it with omh_status action "draft"' }
        const r = await $.ui.open({ id: PLAN_ID, title: 'plan.md' })
        return { text: r.isPlaced ? `plan preview opened (${file}); /omh plan again closes it` : `plan preview will show when there is room${'reason' in r && r.reason ? ` (${r.reason})` : ''}` }
      }
      case 'board': {
        const isOpen = (await $.ui.panes()).some((p: { id: string }) => p.id === BOARD_ID)
        if (isOpen) {
          await $.ui.close({ id: BOARD_ID })
          await update($, BOARD_OPEN, () => false)
          return { text: 'board closed' }
        }
        const r = await $.ui.open({ id: BOARD_ID, title: 'oh-my-herdr' })
        await update($, BOARD_OPEN, () => true)
        return { text: r.isPlaced ? 'board opened' : `board will show when there is room${'reason' in r && r.reason ? ` (${r.reason})` : ''}` }
      }
      default:
        return { text: 'usage: /omh status [full] | plan | approve | quota | check | board | teardown' }
    }
  }).catch(() => ({ text: 'oh-my-herdr: the command failed; see the debug log' }))

  // ---------------------------------------------------------------- drawing

  on('ui.render', { component: 'Pane', requestId: BOARD_ID }, async ($, e) => {
    const el = $.ui.resolve(e) as never
    return boardView(el, await read($, RUN), await read($, WORKERS), await read($, QUOTA), (e.viewport?.rows ?? 30) - 2) as never
  })

  // plan.md drawn by prismantis, read fresh on every draw.
  on('ui.render', { component: 'Pane', requestId: PLAN_ID }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e) as { Box: any; Text: any }
    const file = await planFile()
    const text = file === null ? null : await $.fs.read(file).catch(() => null)
    if (file === null || text === null) return (<Text dimColor>No plan.md yet. The lead writes it with omh_status action "draft".</Text>) as never
    const drawn = await drawMarkdown($ as never, e.surface, text, e.props.bodyColumns)
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">{file}</Text>
        {(drawn ?? <Text>{text}</Text>) as never}
      </Box>
    ) as never
  })

  // One line per omh_* call and the first line of its result, unless `verbose` is on or the view
  // is expanded (ctrl+o, --verbose).
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (rt.options.verbose || e.props.isExpanded === true || !OMH_TOOL.test(e.props.tool)) return next(e)
    return compactCall($.ui.resolve(e) as never, e.props) as never
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!OMH_TOOL.test(e.props.tool)) return next(e)
    if (!rt.options.verbose && e.props.isExpanded !== true) return compactResult($.ui.resolve(e) as never, e.props) as never
    // Shown in full: a worker's report (omh_collect) or a result with tables drawn by prismantis.
    if (e.props.isErrored) return next(e)
    const text = resultText(e.props.output)
    const columns = (e.viewport?.columns ?? 80) - 6
    const { Box, Text } = $.ui.resolve(e) as { Box: any; Text: any }
    const parts = splitCollected(text)
    if (parts !== null) {
      const drawn = await drawMarkdown($ as never, e.surface, parts.body, columns)
      if (drawn === null) return next(e)
      return (
        <Box flexDirection="column" paddingLeft={5}>
          <Text dimColor>{parts.header}</Text>
          {drawn as never}
          {parts.footer ? <Text dimColor>{parts.footer}</Text> : ''}
        </Box>
      ) as never
    }
    if (!looksLikeMarkdown(text)) return next(e)
    const drawn = await drawMarkdown($ as never, e.surface, text, columns)
    return drawn === null ? next(e) : ((<Box paddingLeft={5}>{drawn as never}</Box>) as never)
  })

  // ---------------------------------------------------------------- status line / panel (`display`)

  // The run's progress at the end of the engine's own hint line; the engine keeps drawing the rest.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (rt.options.display !== 'statusline') return next(e)
    const tail = await statusTail($)
    if (tail === null) return next(e)
    return next({ ...e, props: { ...e.props, tail: e.props.tail ? `${e.props.tail} · ${tail}` : tail } })
  })

  // A row above the prompt while a run is open; what else is drawn there stays under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (rt.options.display !== 'panel' || e.props.hasSurvey) return next(e)
    const el = $.ui.resolve(e) as { Box: any; Text: any }
    const panel = await progressPanel($, el)
    if (panel === null) return next(e)
    const { Box } = el
    return (
      <Box flexDirection="column">
        {panel as never}
        {(await next(e)) as never}
      </Box>
    ) as never
  })

  // ---------------------------------------------------------------- guards

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    if (!live() || rt.paths === null) return next(e)
    const run = await read($, RUN)
    if (run === null) return next(e)
    const file = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : 'notebook_path' in e && typeof e.notebook_path === 'string' ? e.notebook_path : null
    if (file === null) return next(e)
    const rel = relativeTo(rt.paths.root, file)
    if (rel === null) return next(e)
    const plan = await loadPlan(run.id)
    const owner = plan ? ownerOf(rel, plan, run) : null
    if (owner === null) return next(e)
    // The subagent that owns the file is the one writing it.
    const caller = (e as { agentId?: string }).agentId
    if (caller !== undefined && owner.worker !== null) {
      const w = (await read($, WORKERS))[owner.worker]
      if (w && subagentIdOf(w) === caller) return next(e)
    }
    return {
      deny: `oh-my-herdr: ${rel} belongs to task ${owner.task}${owner.worker ? ` (worker ${owner.worker})` : ''}, which is still running (owns ${owner.owns}). Wait until it settles, or abandon/tear down that task first.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'oh-my-herdr: the file-ownership guard failed; try again' }))

  // ---------------------------------------------------------------- compaction and continuing

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!live() || e.agentId !== undefined || 'skip' in result) return result
    $.clock.after(0, () => {
      void (async () => {
        const run = await refreshRun()
        if (run === null) return
        await $.session.append({
          message: {
            type: 'user',
            content: [{ type: 'text', text: `[oh-my-herdr] Board after compaction — trust this over memory:\n\n${statusText(run, await workers())}` }],
          },
        })
      })().catch(() => undefined)
    })
    return result
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (live() && e.origin.kind === 'composer') await update($, CONTINUE, () => 0)
    // A worker subagent's own "task finished" notification: the mod wakes the lead once its wave
    // (or the scouts) settles, with every result, so this one would only interrupt.
    if (!live() || e.origin.kind !== 'task-notification') return next(e)
    const ids = Object.values(await read($, WORKERS))
      .map(subagentIdOf)
      .filter((id): id is string => id !== null)
    const hit = ids.find(id => e.text.includes(id))
    if (hit === undefined) return next(e)
    return { drop: `oh-my-herdr: worker subagent ${hit} finished; its report is in result.md and the lead is woken when the wave settles` }
  }).catch(($, e, next) => next(e))



  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A worker subagent's run ended: its answer is its report.
    if (live() && e.agentId !== undefined) void onSubagentEnd(e.agentId, e.reason, e.answer).catch(() => undefined)
    if (!live() || !rt.options.autoContinue || e.agentId !== undefined || e.reason !== 'answer') return result
    void maybeContinue($).catch(() => undefined)
    return result
  })
}

async function maybeContinue($: EngineInterface): Promise<void> {
  const count = await read($, CONTINUE)
  if (count >= rt.options.autoContinueMax) return
  const run = await refreshRun()
  if (run === null) return
  const open = run.waves.some(w => !w.gatePassed) || run.waves.some(w => w.tasks.some(t => t.status !== 'verified' && t.status !== 'abandoned'))
  if (!open) return
  const ws = Object.values(await workers())
  if (ws.some(w => ACTIVE.has(w.phase))) return // workers still out: their wake-up comes by itself
  // Stop when the turn asked the user something.
  const messages = await $.session.messages()
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user' && !(m as { toolResults?: unknown[] }).toolResults?.length) break
    if (m.role === 'assistant' && m.toolUses?.some(u => u.tool === 'AskUserQuestion')) return
  }
  await update($, CONTINUE, c => c + 1)
  await $.prompt.submit({
    text: `[oh-my-herdr] auto-continue ${count + 1}/${rt.options.autoContinueMax}: the run still has open tasks or gates and no worker is busy. Continue the ulw loop (omh_status show), or say plainly what you need from the user.`,
  })
}
