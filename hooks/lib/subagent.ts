// Workers that are Claude Code subagents of the lead ($.agent.spawn) instead of agents in herdr
// panes. Pure. A subagent worker is recorded like any other, its `pane` spelled `agent:<id>`, and
// fed to the same state machine (settle.ts): its status comes from `$.agent.list()` and its end
// from `turn.complete`, whose answer is its report.

import type { OmhWorker } from '../../types'

export const SUBAGENT_PANE = 'agent:'

export const isSubagentPane = (pane: string): boolean => pane.startsWith(SUBAGENT_PANE)
export const isSubagentWorker = (w: Pick<OmhWorker, 'pane'>): boolean => isSubagentPane(w.pane)
export const subagentPane = (agentId: string): string => `${SUBAGENT_PANE}${agentId}`
export const subagentIdOf = (w: Pick<OmhWorker, 'pane'>): string | null => (isSubagentWorker(w) ? w.pane.slice(SUBAGENT_PANE.length) : null)

/** `$.agent.list()`'s status as the state machine's: a waiting subagent is blocked on something. */
export function settleStatusOf(status: string | undefined): string {
  switch (status) {
    case 'pending':
    case 'running':
      return 'working'
    case 'waiting':
      return 'blocked'
    case 'idle':
    case 'completed':
      return 'done'
    case 'failed':
    case 'killed':
    case undefined: // no longer listed: ended a while ago
      return 'gone'
    default:
      return 'unknown'
  }
}

/** How a subagent's run ended, from `turn.complete`'s reason, as the state machine's status. */
export function endStatusOf(reason: string): string {
  return reason === 'answer' ? 'done' : 'gone'
}

/**
 * What diagnose() reads in place of a screen: the end reason and the answer's tail, matched by the
 * `subagent` rules (diagnose.ts).
 */
export function subagentScreen(end: { reason: string; answer: string } | undefined, listed: string | undefined): string {
  const lines = [`subagent status: ${listed ?? 'not listed'}`]
  if (end) lines.push(`subagent ended: ${end.reason}`, end.answer.trim().split('\n').slice(-20).join('\n'))
  return lines.join('\n')
}

/** The brief's last section for a subagent: its final reply is the report, saved by the mod. */
export function subagentReporting(result: string): string[] {
  return [
    '## How to report back (required)',
    'Your final reply is your report: oh-my-herdr saves it to',
    '',
    `    ${result}`,
    '',
    'Do not write that file yourself. Include: a summary of what you did or found, files changed (if any), how you verified it (commands and their outcome), and open questions or risks.',
    'If you cannot continue, start your final reply with `BLOCKED: <one-sentence reason>`.',
    '',
  ]
}
