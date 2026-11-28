// The opt-in opencode child-session subagent backend. A forced oc-subagent-* profile creates a
// child session with the profile's agent + model; no parentID, so opencode does not send its own
// background-result to the lead. The child's final assistant message is fed to core's
// onSubagentEnd, which writes result.md and feeds the same settle path as a Claude Code subagent.

import type { SubagentCapability, SubagentSpawnArgs, SubagentStatus } from '../../../core/host'
import { onSubagentEnd } from '../../../core/runtime'

export type SubagentHost = {
  location: { directory: string }
  session: {
    create: (input: any) => Promise<any>
    prompt: (input: any) => Promise<unknown>
    context: (input: any) => Promise<ReadonlyArray<any>>
    get: (input: any) => Promise<any>
    remove?: (input: any) => Promise<unknown>
  }
  event: { subscribe: (options?: any) => AsyncIterable<any> }
}

type ModelRef = { providerID: string; id: string; variant?: string }

function modelRef(value: string | undefined): ModelRef | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const [ref, variant] = value.split('#', 2)
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash === ref.length - 1) throw new Error(`bad model ref: ${value}`)
  return {
    providerID: ref.slice(0, slash),
    id: ref.slice(slash + 1),
    ...(variant !== undefined && variant !== '' ? { variant } : {}),
  }
}

function textOf(raw: any): string {
  if (typeof raw?.text === 'string') return raw.text
  const content = Array.isArray(raw?.content) ? raw.content : Array.isArray(raw?.parts) ? raw.parts : []
  return content
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text)
    .join('\n')
}

function answerOf(messages: ReadonlyArray<any>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'assistant' || message?.role === 'assistant') {
      const answer = textOf(message).trim()
      if (answer !== '') return answer
    }
  }
  return ''
}

function errorText(event: any): string {
  const error = event?.data?.error
  if (typeof error?.message === 'string') return error.message
  if (typeof error === 'string') return error
  return 'the child session failed'
}

/**
 * Build the host's subagent capability. This is deliberately created by the server entry point
 * only for the opencode host; T5's createEngine does not add it unless wired.
 */
export type SubagentOptions = { recoverMs?: number }

/**
 * Build the host's subagent capability. This is deliberately created by the server entry point
 * only for the opencode host; T5's createEngine does not add it unless wired.
 */
export function createSubagentCapability(ctx: SubagentHost, options: SubagentOptions = {}): SubagentCapability & { dispose: () => void } {
  const statuses = new Map<string, SubagentStatus>()
  const ended = new Set<string>()
  const controllers = new Set<AbortController>()
  const recoverMs = options.recoverMs ?? 15_000

  async function finish(id: string, type: 'completed' | 'failed' | 'killed', reason: 'answer' | 'error' | 'aborted', detail: string): Promise<void> {
    if (ended.has(id)) return
    ended.add(id)
    statuses.set(id, type)
    try {
      if (type === 'completed') {
        const messages = await ctx.session.context({ sessionID: id })
        await onSubagentEnd(id, 'answer', answerOf(messages))
      } else {
        await onSubagentEnd(id, reason, detail)
      }
    } catch (err) {
      console.error(`[oh-my-herdr] subagent ${id} completion: ${(err as Error).message}`)
    }
  }

  /**
   * Ask the session's own state until it reports a terminal outcome. A session that exists with no
   * outcome is still working, so keep polling it for as long as it exists; only a missing or
   * unreadable session for `recoverMs` in a row means the child is gone.
   */
  async function recover(id: string, controller: AbortController): Promise<'succeeded' | 'failed' | 'interrupted' | null> {
    const interval = Math.min(2_000, Math.max(50, recoverMs / 4))
    let missingSince: number | null = null
    while (!controller.signal.aborted) {
      const info = await ctx.session.get({ sessionID: id }).catch(() => null)
      if (controller.signal.aborted) return null
      const outcome = info?.outcome
      if (outcome === 'succeeded' || outcome === 'failed' || outcome === 'interrupted') return outcome
      if (info == null) {
        missingSince ??= Date.now()
        if (Date.now() - missingSince >= recoverMs) return null
      } else {
        // The child exists and has not reached a terminal outcome yet: it is still running.
        missingSince = null
      }
      if (!controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, interval))
    }
    return null
  }

  async function applyOutcome(id: string, outcome: 'succeeded' | 'failed' | 'interrupted'): Promise<void> {
    if (outcome === 'succeeded') await finish(id, 'completed', 'answer', '')
    else if (outcome === 'failed') await finish(id, 'failed', 'error', 'the child session failed')
    else await finish(id, 'killed', 'aborted', 'the child session was interrupted')
  }

  async function giveUp(id: string, controller: AbortController, detail: string): Promise<void> {
    controller.abort()
    controllers.delete(controller)
    statuses.delete(id)
    await ctx.session.remove?.({ sessionID: id }).catch(() => undefined)
    await finish(id, 'failed', 'error', detail)
  }

  async function spawn(args: SubagentSpawnArgs): Promise<{ agentId: string; model?: string }> {
    const model = modelRef(args.model)
    const child = await ctx.session.create({
      location: { directory: args.cwd ?? ctx.location.directory },
      ...(args.description !== undefined && { title: args.description }),
      agent: args.subagentType ?? 'general',
      ...(model !== undefined && { model }),
    })
    const id = String(child.id)
    statuses.set(id, 'running')

    const controller = new AbortController()
    controllers.add(controller)
    let iterator: AsyncIterator<any>
    try {
      iterator = ctx.event.subscribe({
        types: ['session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'],
        signal: controller.signal,
      })[Symbol.asyncIterator]()
    } catch (err) {
      controllers.delete(controller)
      statuses.delete(id)
      await ctx.session.remove?.({ sessionID: id }).catch(() => undefined)
      throw err
    }

    // Start consuming before prompting: the first next() is called synchronously by the async
    // function below, so no terminal event can be missed between prompt and subscription.
    void (async () => {
      try {
        let next = await iterator.next()
        while (!next.done) {
          const event = next.value
          if (event?.data?.sessionID === id) {
            if (event.type === 'session.execution.started') {
              statuses.set(id, 'running')
            } else if (event.type === 'session.execution.succeeded') {
              await finish(id, 'completed', 'answer', '')
              controller.abort()
              return
            } else if (event.type === 'session.execution.failed') {
              await finish(id, 'failed', 'error', errorText(event))
              controller.abort()
              return
            } else if (event.type === 'session.execution.interrupted') {
              await finish(id, 'killed', 'aborted', 'the child session was interrupted')
              controller.abort()
              return
            }
          }
          next = await iterator.next()
        }
        if (!controller.signal.aborted) {
          const outcome = await recover(id, controller)
          if (outcome !== null) await applyOutcome(id, outcome)
          else if (!controller.signal.aborted) await giveUp(id, controller, 'the child never reported a terminal outcome')
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          const outcome = await recover(id, controller)
          if (outcome !== null) await applyOutcome(id, outcome)
          else if (!controller.signal.aborted) await giveUp(id, controller, `event stream lost: ${(err as Error).message}`)
        }
      } finally {
        controllers.delete(controller)
      }
    })()

    try {
      await ctx.session.prompt({
        sessionID: id,
        text: args.prompt,
        delivery: 'queue',
        metadata: { source: 'oh-my-herdr', subagent: true },
      })
    } catch (err) {
      controller.abort()
      controllers.delete(controller)
      statuses.delete(id)
      await ctx.session.remove?.({ sessionID: id }).catch(() => undefined)
      throw err
    }
    return { agentId: id, ...(args.model !== undefined && { model: args.model }) }
  }

  return {
    spawn,
    list: async () => [...statuses].map(([id, status]) => ({ id, status })),
    dispose: () => {
      for (const controller of controllers) controller.abort()
      controllers.clear()
    },
  }
}
