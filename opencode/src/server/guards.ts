// T6: the lead's file-ownership guard and the built-in subagent denial.
//
// opencode's `execute.before` gives edit/write a single `path`; `patch` carries only patchText, so
// its target files arrive through `permission.evaluate` resources. The decision itself is core's:
// core/guards.ownerOf and core/config.agentCallRule are the same functions the Claude Code mod uses.

import { agentCallRule } from '../../../core/config'
import { ownerOf, relativeTo } from '../../../core/guards'
import { config, loadPlan, rt } from '../../../core/runtime'

type ToolEvent = {
  tool: string
  sessionID: string
  input: unknown
}

type PermissionEvent = {
  sessionID: string
  action: string
  resources: ReadonlyArray<string>
  metadata?: Record<string, unknown>
  effect: string
  message?: string
}

export type GuardHost = {
  tool: { hook: (name: string, fn: (event: any) => Promise<void>) => Promise<void> }
  permission: { hook: (name: string, fn: (event: any) => Promise<void>) => Promise<void> }
}

function leadSession(): string | null {
  return rt.$?.lead.session ?? null
}

/** The session is the claimed lead (whether or not a run is bound yet). */
function liveLead(sessionID: string): boolean {
  return rt.$ !== null && leadSession() !== null && leadSession() === sessionID
}

/** File ownership is live only for the bound lead: no run, no ownership. */
function leadOn(sessionID: string): boolean {
  return liveLead(sessionID) && rt.paths !== null && rt.paths.boundRun !== null
}

function messageFor(rel: string, owner: { task: string; worker: string | null; owns: string }): string {
  return `oh-my-herdr: ${rel} belongs to task ${owner.task}${owner.worker ? ` (worker ${owner.worker})` : ''}, which is still running (owns ${owner.owns}). Wait until it settles, or abandon/tear down that task first.`
}

/** Which running task owns `file`, when this lead is bound to a run. */
async function ownerOfFile(file: string): Promise<{ rel: string; owner: NonNullable<ReturnType<typeof ownerOf>> } | null> {
  const $ = rt.$
  if ($ === null || rt.paths === null) return null
  const run = await $.state.run.get()
  if (run === null) return null
  const rel = relativeTo(rt.paths.root, file)
  if (rel === null) return null
  const plan = await loadPlan(run.id)
  if (plan === null) return null
  const owner = ownerOf(rel, plan, run)
  return owner === null ? null : { rel, owner }
}

/** The paths a permission event would touch. `patch` has no path in its input, so resources matter. */
function resourcesOf(event: PermissionEvent): string[] {
  const out = [...event.resources.filter((r): r is string => typeof r === 'string')]
  const filepath = event.metadata?.filepath
  if (typeof filepath === 'string') out.push(filepath)
  const files = event.metadata?.files
  if (Array.isArray(files)) {
    for (const f of files) {
      if (f !== null && typeof f === 'object' && typeof (f as { file?: unknown }).file === 'string') out.push((f as { file: string }).file)
    }
  }
  return out
}

export async function installGuards(ctx: GuardHost): Promise<void> {
  await ctx.tool.hook('execute.before', async (raw: unknown) => {
    const event = raw as ToolEvent
    if (!liveLead(event.sessionID)) return

    if (event.tool === 'subagent') {
      const input = (event.input !== null && typeof event.input === 'object' ? event.input : {}) as { agent?: unknown; subagent_type?: unknown; model?: unknown }
      const rawType = typeof input.agent === 'string' ? input.agent : typeof input.subagent_type === 'string' ? input.subagent_type : undefined
      // opencode's built-in default is `general`; core's vocabulary calls it general-purpose.
      const type = rawType === 'general' ? undefined : rawType
      let rule: ReturnType<typeof agentCallRule>
      try {
        rule = agentCallRule(await config(), { subagent_type: type, model: input.model })
      } catch {
        throw new Error('oh-my-herdr: the subagent guard failed; try again')
      }
      if (rule !== null && 'deny' in rule) throw new Error(rule.deny)
      if (rule !== null && 'model' in rule) {
        if (rule.model === undefined) delete input.model
        else input.model = rule.model
      }
      return
    }

    if (!leadOn(event.sessionID)) return
    if (event.tool !== 'edit' && event.tool !== 'write') return
    const input = (event.input !== null && typeof event.input === 'object' ? event.input : {}) as { path?: unknown; file_path?: unknown; notebook_path?: unknown }
    const file = typeof input.path === 'string' ? input.path : typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
    if (file === null) return
    const hit = await ownerOfFile(file)
    if (hit !== null) throw new Error(messageFor(hit.rel, hit.owner))
  })

  await ctx.permission.hook('evaluate', async (raw: unknown) => {
    const event = raw as PermissionEvent
    if (event.action !== 'edit' || !leadOn(event.sessionID)) return
    for (const file of resourcesOf(event)) {
      const hit = await ownerOfFile(file)
      if (hit === null) continue
      event.effect = 'deny'
      event.message = messageFor(hit.rel, hit.owner)
      return
    }
  })
}
