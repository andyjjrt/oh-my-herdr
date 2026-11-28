// The TUI's /omh: the immediate subcommands answer over RPC and print at once; the mutating ones
// go to the server command (T5) through the same RPC. No session prompt, no model turn.

import { USAGE, subOf, type OmhApi } from '../rpc/protocol'

export const PANEL = { board: 'omh.board', plan: 'omh.plan' } as const

export type Reply =
  | { kind: 'text'; title: string; text: string; ok: boolean }
  | { kind: 'panel'; name: (typeof PANEL)[keyof typeof PANEL] }

/** Normalise the slash input: opencode passes the raw text after the command (sometimes with a newline). */
export function argsOf(input: string | undefined): string {
  return (input ?? '').replace(/^\/omh\b/, '').trim()
}

/** RPC failures arrive as { type, message } objects, not Errors. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err !== null && typeof err === 'object') {
    const e = err as { type?: unknown; message?: unknown }
    const bits = [typeof e.type === 'string' ? e.type : null, typeof e.message === 'string' ? e.message : null].filter(Boolean)
    if (bits.length > 0) return bits.join(': ')
    try {
      return JSON.stringify(err)
    } catch {}
  }
  return String(err)
}

export async function runOmh(api: OmhApi, input: string | undefined, sessionID: string | undefined): Promise<Reply> {
  const args = argsOf(input)
  const sub = subOf(args)
  try {
    const out = await api.command({ args, ...(sessionID ? { sessionID } : {}) })
    if (out.ok && out.open !== undefined) return { kind: 'panel', name: PANEL[out.open] }
    return { kind: 'text', title: `/omh ${out.sub || sub}`, text: out.text || USAGE, ok: out.ok }
  } catch (err) {
    return { kind: 'text', title: `/omh ${sub}`, text: `oh-my-herdr server part did not answer: ${errorText(err)}`, ok: false }
  }
}
