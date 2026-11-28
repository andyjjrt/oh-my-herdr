// The five omh_* tools, registered through ctx.tool.transform with the same names and JSON Schemas
// the Claude Code mod registers. Every tool call makes its session the lead; results go straight
// through core/actions.ts. opencode renders tool output in full, so cap the rare very long answer.

import type { Answer } from '../../../core/actions'
import { collect, dispatch, draftPlan, finishRun, passGate, recheckTask, spawn, status, teardown, closeTask, writePlan } from '../../../core/actions'
import { claimLead } from './lead'

type ToolResult = { content: string; metadata?: Record<string, unknown> }

type ToolContextLike = {
  sessionID: string
  progress?: (update: Record<string, unknown>) => Promise<void>
}

type ToolDefinition = {
  name: string
  description: string
  input: Record<string, unknown>
  execute: (input: any, context: ToolContextLike) => Promise<ToolResult>
}

export type ToolEditorLike = { add: (definition: ToolDefinition) => void }
export type ToolHost = { tool: { transform: (fn: (editor: ToolEditorLike) => void | Promise<void>) => Promise<void> } }

const TOOLS = [
  {
    name: 'omh_dispatch',
    description: [
      'Send one task of the current plan to a worker agent (a herdr pane, a herdr-core terminal or a subagent), and return at once.',
      'Intent Gate: decide the task\'s intent and category first and say why in `rationale`. The worker\'s agent and model are chosen from the category by the config and current quota; leave `worker` and `profile` out unless the user asked for one.',
      'Never wait or poll after dispatching: you are woken with a results table when the wave settles, or at once when a worker is blocked, stalled or dies (with a diagnosis).',
      'Scouts: a task id `scout-<name>` with intent explore or research needs no plan — use them while exploring before plan.md, several at once, for long reads or external docs on cheaper models. They are read-only, have no wave or gate, and you are woken once all scouts are back; omh_collect closes each.',
    ].join(' '),
    input: {
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
      '"finish": after the last gate has passed, record the run as finished; the user then closes it with /omh close (nothing is merged or removed).',
      '"recheck": re-read the live status of the worker holding `task` and correct its phase, when an alert (stalled, idle without result) looks wrong because the worker is in fact working or has reported.',
    ].join(' '),
    input: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['show', 'draft', 'plan', 'verified', 'abandon', 'gate', 'recheck', 'finish'] },
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
    input: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
  },
  {
    name: 'omh_spawn',
    description: 'Start a worker ahead of time (optional: omh_dispatch starts one when needed). Picks the profile from the category, skipping providers out of quota.',
    input: {
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
    input: { type: 'object', properties: { workers: { type: 'array', items: { type: 'string' } } } },
  },
] as const satisfies ReadonlyArray<{ name: string; description: string; input: Record<string, unknown> }>

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
        case 'recheck':
          return recheckTask(s(a.task) ?? '')
        case 'finish':
          return finishRun()
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

/** opencode shows the whole tool result to the user; keep a pathological report from filling the conversation. */
function short(text: string): string {
  const limit = 12_000
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`
}

export async function installTools(ctx: ToolHost): Promise<void> {
  await ctx.tool.transform(editor => {
    for (const tool of TOOLS) {
      editor.add({
        name: tool.name,
        description: tool.description,
        input: tool.input,
        execute: async (input, context) => {
          await claimLead(context.sessionID)
          await context.progress?.({ status: `oh-my-herdr: ${tool.name}` })
          try {
            const answer = await serve(tool.name, input as Args)
            // A draft creates the run after the first claim; write the session into its lead.json now.
            await claimLead(context.sessionID)
            return {
              content: short(answer.ok ? answer.text : `ERROR: ${answer.text}`),
              metadata: { source: 'oh-my-herdr', tool: tool.name, ok: answer.ok },
            }
          } catch (err) {
            return {
              content: `ERROR: ${tool.name} failed: ${(err as Error).message}`,
              metadata: { source: 'oh-my-herdr', tool: tool.name, ok: false },
            }
          }
        },
      })
    }
  })
}

/** /omh uses the same actions without a tool call; exported for commands.ts. */
export { serve as runAction }
