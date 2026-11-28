// The server side of OmhRpc: plain handlers over core, plus the registration on ctx.rpc.
// Handlers never throw: a failure comes back as text, so the TUI only has to print it.

import { planFile } from '../../../core/actions'
import { rt } from '../../../core/runtime'
import { deliverOmh, omhText, type CommandHost } from '../server/commands'
import { IMMEDIATE, MUTATING, OmhRpc, USAGE, subOf, EMPTY_SNAPSHOT, type CommandInput, type CommandOutput, type OmhApi, type PlanOutput, type Snapshot } from './protocol'

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function snapshot(): Promise<Snapshot> {
  const $ = rt.$
  if ($ === null || rt.paths === null) return { ...EMPTY_SNAPSHOT, display: rt.options.display }
  const [run, workers, quota] = await Promise.all([
    $.state.run.get().catch(() => null),
    $.state.workers.get().catch(() => ({})),
    $.state.quota.get().catch(() => ({})),
  ])
  return { active: true, display: rt.options.display, run, workers, quota }
}

export async function plan(): Promise<PlanOutput> {
  const $ = rt.$
  if ($ === null || rt.paths === null) return { file: null, markdown: null }
  const file = await planFile().catch(() => null)
  if (file === null) return { file: null, markdown: null }
  return { file, markdown: await $.fs.read(file).catch(() => null) }
}

/** `ctx` is the server context, needed only for the mutating subcommands' synthetic answer. */
export async function command(ctx: CommandHost | null, input: CommandInput): Promise<CommandOutput> {
  const args = (input.args ?? '').trim()
  const sub = subOf(args)
  if (rt.$ === null || rt.paths === null) return { ok: false, sub, text: 'oh-my-herdr is not active in this opencode server (a worker pane, or it failed to start)' }
  try {
    if ((MUTATING as readonly string[]).includes(sub)) {
      if (ctx === null || !input.sessionID) return { ok: false, sub, text: `/omh ${sub} needs an open session` }
      // T5's server command: the answer also lands in the session, and approve wakes the lead.
      return { ok: true, sub, text: await deliverOmh(ctx, input.sessionID, args) }
    }
    if (!(IMMEDIATE as readonly string[]).includes(sub)) return { ok: false, sub, text: USAGE }
    if (sub === 'board') return { ok: true, sub, text: 'board', open: 'board' }
    if (sub === 'plan') {
      const file = await planFile()
      return file === null ? { ok: false, sub, text: 'no plan.md yet; the lead writes it with omh_status action "draft"' } : { ok: true, sub, text: file, open: 'plan' }
    }
    return { ok: true, sub, text: await omhText(args) }
  } catch (err) {
    return { ok: false, sub, text: `/omh ${sub} failed: ${errText(err)}` }
  }
}

/** The handlers as an OmhApi: what the fake transport in tests calls. */
export function handlers(ctx: CommandHost | null): OmhApi {
  return { command: input => command(ctx, input), snapshot, plan }
}

type Registration = { dispose: () => Promise<void> }
export type RpcHost = CommandHost & {
  rpc: { register: (definition: typeof OmhRpc, handlers: Record<string, (input: any) => Promise<any>>) => Promise<Registration | undefined> }
}

/** Register OmhRpc on the server part; returns the registration to dispose on cleanup. */
export async function installRpc(ctx: RpcHost): Promise<Registration | undefined> {
  const api = handlers(ctx)
  return ctx.rpc.register(OmhRpc, {
    command: async (input: CommandInput) => api.command(input),
    snapshot: async () => api.snapshot(),
    plan: async () => api.plan(),
  })
}
