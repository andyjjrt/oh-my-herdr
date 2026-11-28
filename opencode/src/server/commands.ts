// /ulw starts the same loop the Claude Code command starts, with opencode's tool names. /omh is a
// server command with no return channel, so every answer is delivered back into the session as a
// synthetic message (the TUI part takes the immediate path in T8).

import { randomUUID } from 'node:crypto'

import { approveRun, check, closeRun, listRuns, planFile, quotaReport, status, teardown } from '../../../core/actions'
import { kindText, routedSubagents } from '../../../core/config'
import { config } from '../../../core/runtime'
import { ulwPrompt } from '../../../core/text'
import { ensureLead, claimLead, leadSession } from './lead'

type CommandInvocationLike = {
  sessionID: string
  prompt: { text: string }
  delivery: string
}

type CommandDefinitionLike = {
  name: string
  description?: string
  execute: (input: CommandInvocationLike) => Promise<void>
}

type CommandEditorLike = { add: (definition: CommandDefinitionLike) => void }
export type CommandHost = {
  command: { transform: (fn: (editor: CommandEditorLike) => void | Promise<void>) => Promise<void> }
  session: {
    prompt: (input: any) => Promise<unknown>
    synthetic: (input: any) => Promise<unknown>
  }
}

/** The shared prompt, with the subagent kinds this config actually routes (like CC's /ulw). */
export async function ulwText(goal: string): Promise<string> {
  const cfg = await config().catch(() => null)
  return ulwPrompt(goal, cfg === null ? null : routedSubagents(cfg).map(kindText), 'opencode')
}

/** Claim the lead and prompt its session; the command defers this until its own dispatch is done. */
export async function startUlw(ctx: CommandHost, sessionID: string, goal: string): Promise<unknown> {
  await claimLead(sessionID)
  const text = await ulwText(goal)
  return ctx.session.prompt({
    sessionID,
    text,
    delivery: 'queue',
    id: `msg_omh_ulw_${randomUUID()}`,
    metadata: { source: 'oh-my-herdr', command: 'ulw' },
  })
}

function short(text: string): string {
  const limit = 12_000
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`
}

/** The text /omh would print; separated so tests and the TUI RPC path can reuse it. */
export async function omhText(args: string): Promise<string> {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const sub = words[0] ?? 'status'
  switch (sub) {
    case 'status':
      return (await status(words[1] === 'full' ? 'full' : 'brief')).text
    case 'quota':
      return (await quotaReport()).text
    case 'check':
      return (await check()).text
    case 'teardown':
      return (await teardown(undefined)).text
    case 'approve': {
      const rest = words.slice(1)
      const force = rest.includes('force') || rest.includes('--force')
      const answer = await approveRun(rest.find(w => w !== 'force' && w !== '--force'), force)
      // The approval message already woke the lead in Claude Code. Here the synthetic answer is the
      // only channel, so append the wake instruction instead of sending a second message.
      return answer.ok && answer.wake !== undefined ? `${answer.text}\n\n${answer.wake}` : answer.text
    }
    case 'runs':
      return (await listRuns()).text
    case 'close': {
      const rest = words.slice(1)
      const force = rest.includes('force') || rest.includes('--force')
      return (await closeRun(rest.find(w => w !== 'force' && w !== '--force'), force)).text
    }
    case 'plan': {
      const file = await planFile()
      return file === null ? 'no plan.md yet; the lead writes it with omh_status action "draft"' : `plan.md: ${file}`
    }
    case 'board':
      return 'the board is drawn by the opencode TUI part; this server command has no pane to open'
    default:
      return 'usage: /omh status [full] | plan | approve [run] [force] | runs | close [run] [force] | quota | check | board | teardown'
  }
}

/** Deliver an /omh answer into the invoking session; server commands have no text return channel. */
export async function deliverOmh(ctx: CommandHost, sessionID: string, args: string): Promise<string> {
  await ensureLead(sessionID)
  const text = short(await omhText(args))
  const sub = args.trim().split(/\s+/)[0] ?? 'status'
  // /omh approve binds this session after ensureLead ran: write the session into the new lead.json.
  // A successful approve from another otherwise-idle session also makes it the lead.
  if (sub === 'approve' || leadSession() === sessionID) await claimLead(sessionID)
  await ctx.session.synthetic({
    sessionID,
    text,
    delivery: 'queue',
    id: `msg_omh_omh_${randomUUID()}`,
    description: 'oh-my-herdr /omh',
    metadata: { source: 'oh-my-herdr', command: 'omh' },
    // Server-command output must not start an unrequested model turn. Approval is the one
    // subcommand whose whole point is to wake the lead and continue the loop.
    ...(sub === 'approve' ? {} : { resume: false }),
  })
  return text
}

function commandText(raw: string, name: string): string {
  return raw.trim().replace(new RegExp(`^/${name}\\b\\s*`), '')
}

export async function installCommands(ctx: CommandHost): Promise<void> {
  await ctx.command.transform(editor => {
    editor.add({
      name: 'ulw',
      description: 'oh-my-herdr: ultrawork — plan, fan out to worker agents, verify',
      execute: async input => {
        const goal = commandText(input.prompt.text, 'ulw')
        // The command's own dispatch is still open; prompt once it has returned.
        setTimeout(() => {
          void startUlw(ctx, input.sessionID, goal).catch(err => console.error(`[oh-my-herdr] /ulw could not start: ${(err as Error).message}`))
        }, 0)
      },
    })
    editor.add({
      name: 'omh',
      description: 'oh-my-herdr: status | plan | approve | runs | close | quota | check | board | teardown',
      execute: async input => {
        const args = commandText(input.prompt.text, 'omh')
        try {
          await deliverOmh(ctx, input.sessionID, args)
        } catch (err) {
          console.error(`[oh-my-herdr] /omh failed: ${(err as Error).message}`)
        }
      },
    })
  })
}
