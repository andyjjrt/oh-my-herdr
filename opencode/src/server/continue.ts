// T6: the opencode auto-continue path, matching the Claude Code turn.complete loop.
//
// It runs only when the lead goes idle, not while a background shell/subagent is still working,
// only while the run has open work, only when no worker is active, and never after a question tool
// asked the user. `continueCount` caps it and a human prompt resets the count.

import { randomUUID } from 'node:crypto'

import type { Engine } from '../../../core/host'
import { refreshRun, rt } from '../../../core/runtime'
import { ACTIVE } from '../../../core/settle'
import type { OmhTaskStatus } from '../../../core/types'

type IdleEvent = { sessionID: string; background?: ReadonlyArray<unknown> }
type PromptEvent = { sessionID: string; metadata?: unknown }

export type ContinueHost = {
  session: {
    hook: (name: string, fn: (event: any) => Promise<void>) => Promise<void>
    context: (input: { sessionID: string }) => Promise<ReadonlyArray<any>>
    synthetic: (input: any) => Promise<unknown>
  }
}

const DONE: ReadonlySet<OmhTaskStatus> = new Set(['verified', 'abandoned'])
let running = false

/** Did the last assistant turn stop on opencode's `question` tool? */
async function askedUser(ctx: ContinueHost, sessionID: string): Promise<boolean> {
  const messages = await ctx.session.context({ sessionID }).catch(() => [])
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'user' || message?.type === 'synthetic') return false
    if (message?.type !== 'assistant' || !Array.isArray(message.content)) continue
    if (message.content.some((part: any) => part?.type === 'tool' && (part.name === 'question' || part.tool === 'question'))) return true
  }
  return false
}

export async function maybeContinue(ctx: ContinueHost, engine: Engine, event: IdleEvent): Promise<void> {
  if (running || !rt.options.autoContinue) return
  if (engine.lead.session === null || event.sessionID !== engine.lead.session) return
  if ((event.background?.length ?? 0) > 0) return
  running = true
  try {
    const count = await engine.state.continueCount.get()
    if (count >= rt.options.autoContinueMax) return
    const run = await refreshRun()
    if (run === null) return
    const open = run.waves.some(w => !w.gatePassed) || run.waves.some(w => w.tasks.some(t => !DONE.has(t.status)))
    if (!open) return
    const workers = Object.values(await engine.state.workers.get())
    if (workers.some(w => ACTIVE.has(w.phase))) return
    if (await askedUser(ctx, event.sessionID)) return
    await engine.state.continueCount.set(c => c + 1)
    // Do not go through engine.prompt.submit here: wake.ts dedupes by text, and a human reset
    // would make auto-continue 1/2 repeat with the same text and be suppressed. This loop owns the
    // once-per-idle decision, so give each send a fresh id.
    await ctx.session.synthetic({
      sessionID: event.sessionID,
      text: `[oh-my-herdr] auto-continue ${count + 1}/${rt.options.autoContinueMax}: the run still has open tasks or gates and no worker is busy. Continue the ulw loop (omh_status show), or say plainly what you need from the user.`,
      delivery: 'queue',
      id: `msg_omh_continue_${randomUUID()}`,
      description: 'oh-my-herdr auto-continue',
      metadata: { source: 'oh-my-herdr', autoContinue: true },
    })
  } finally {
    running = false
  }
}

export async function installContinue(ctx: ContinueHost, engine: Engine): Promise<void> {
  await ctx.session.hook('experimental.idle', async (raw: unknown) => {
    const event = raw as IdleEvent
    await maybeContinue(ctx, engine, event).catch(err => engine.ui.log(`oh-my-herdr: auto-continue failed: ${(err as Error).message}`))
  })
  await ctx.session.hook('prompt', async (raw: unknown) => {
    const event = raw as PromptEvent
    // opencode's synthetic/prompt metadata marks non-human input; a composer prompt has none.
    if (event.sessionID !== engine.lead.session || event.metadata != null) return
    await engine.state.continueCount.set(() => 0)
  })
}
