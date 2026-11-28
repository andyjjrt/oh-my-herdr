// The RPC between the TUI part and the server part. The TUI part runs in another process and gets
// no plugin options (spike REPORT (e) caveat), so everything it draws comes over this channel.
//
//   omh.command  { args, sessionID? } -> { ok, sub, text, open? }
//                the immediate /omh subcommands (status, quota, check, runs, board, plan) answer from
//                core; a mutating one (approve, close, teardown) goes through T5's server command.
//   omh.snapshot {} -> { active, display, run, workers, quota }
//                what the status slot, the board and the toasts draw; polled by the TUI.
//   omh.plan     {} -> { file, markdown }   the plan pane's text, read fresh.

import { Rpc } from '@opencode/plugin'

import type { Display } from '../../../core/host'
import type { OmhQuota, OmhRunView, OmhWorker } from '../../../core/types'

const anyObject = { type: 'object', additionalProperties: true } as const

export const OmhRpc = Rpc.define({
  id: 'omh',
  methods: {
    command: {
      input: {
        type: 'object',
        properties: { args: { type: 'string' }, sessionID: { type: 'string' } },
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          sub: { type: 'string' },
          text: { type: 'string' },
          open: { type: 'string' },
        },
        required: ['ok', 'sub', 'text'],
        additionalProperties: true,
      },
    },
    snapshot: {
      input: { type: 'object', additionalProperties: true },
      output: {
        type: 'object',
        properties: {
          active: { type: 'boolean' },
          display: { type: 'string' },
          run: {},
          workers: anyObject,
          quota: anyObject,
        },
        required: ['active', 'display', 'workers', 'quota'],
        additionalProperties: true,
      },
    },
    plan: {
      input: { type: 'object', additionalProperties: true },
      output: {
        type: 'object',
        properties: { file: {}, markdown: {} },
        additionalProperties: true,
      },
    },
  },
  events: {},
})

/** The /omh subcommands the TUI answers at once over RPC, with no model turn. */
export const IMMEDIATE = ['status', 'quota', 'check', 'runs', 'board', 'plan'] as const
export type Immediate = (typeof IMMEDIATE)[number]
/** Subcommands that change state; they keep going through the server command (T5). */
export const MUTATING = ['approve', 'close', 'teardown'] as const

export const USAGE = 'usage: /omh status [full] | plan | approve [run] [force] | runs | close [run] [force] | quota | check | board | teardown'

export type CommandInput = { args?: string; sessionID?: string }
/** `open` names the panel the TUI should toggle (board, plan). */
export type CommandOutput = { ok: boolean; sub: string; text: string; open?: 'board' | 'plan' }

export type Snapshot = {
  /** false when the server part is dormant (a worker pane) or not bound to a project. */
  active: boolean
  display: Display
  run: OmhRunView | null
  workers: Record<string, OmhWorker>
  quota: Record<string, OmhQuota>
}

export type PlanOutput = { file: string | null; markdown: string | null }

export const EMPTY_SNAPSHOT: Snapshot = { active: false, display: 'statusline', run: null, workers: {}, quota: {} }

/**
 * What the TUI calls. The real one wraps `context.client.rpc(OmhRpc)`; tests pass a fake transport
 * that calls the server handlers directly.
 */
export type OmhApi = {
  command: (input: CommandInput) => Promise<CommandOutput>
  snapshot: () => Promise<Snapshot>
  plan: () => Promise<PlanOutput>
}

export function subOf(args: string): string {
  return args.trim().split(/\s+/)[0] || 'status'
}
