// Why a worker stopped without a clean result. Pure: screen text + rules in, verdict out.
//
// herdr's idle/done/blocked are read off the screen and can be wrong (hc's are the agent's own reports); this turns the worker's last
// screen, the quota snapshot and the result file into one verdict the lead reads on waking.
// Rules live in agents.json under each agent's "diagnose" (verdict → regex list), so they grow
// as new cases turn up; the defaults below cover what has been seen so far.

import type { OmhDiagnosis, OmhPhase, OmhVerdict } from '../../types'
import type { DiagnoseRules } from './config'

/** Checked in this order; the first verdict with a matching line wins. */
export const RULE_ORDER: readonly OmhVerdict[] = ['quota-exhausted', 'permission-prompt', 'config-error', 'crashed', 'interrupted']

export const DEFAULT_RULES: Record<string, DiagnoseRules> = {
  claude: {
    'quota-exhausted': ['usage limit', 'rate limit', 'limit will reset', 'out of extra usage', "You've hit your"],
    'permission-prompt': [
      'Do you want to (proceed|make this edit|create|run)',
      'Is this a project you created or one you trust',
      'Allow .*\\?',
      '❯ 1\\. Yes',
    ],
    'config-error': ['Invalid model', 'Please run /login', 'not authenticated', 'Invalid API key', 'model .* not (found|available)'],
    crashed: ['Error: .*\\n\\s+at ', 'panicked at', 'Segmentation fault', 'command not found'],
    interrupted: ['Interrupted by user', '\\[Request interrupted'],
  },
  senpi: {
    // Not a bare "quota": senpi lists its extensions (pi-quotas, …) on screen.
    'quota-exhausted': ['usage limit', 'rate limit', 'quota (exceeded|exhausted|reached)', '(exceeded|insufficient|out of).{0,20}quota', 'limit (reached|exceeded)', '\\b429\\b'],
    'permission-prompt': ['\\(y/n\\)', 'Allow .*\\?', 'Do you want to'],
    'config-error': ['Unknown model', 'model .* not found', '[Mm]odel is unavailable', 'No API key', '/login', 'Invalid API key', 'unauthorized', '\\b401\\b'],
    crashed: ['Error: .*\\n\\s+at ', 'panicked at', 'command not found', 'Traceback \\(most recent call last\\)'],
    interrupted: ['Operation aborted', 'Interrupted', '\\^C'],
  },
  // A subagent has no screen: subagentScreen() (subagent.ts) writes its status, end reason and answer.
  subagent: {
    'quota-exhausted': ['usage limit', 'rate limit', 'limit will reset', 'out of extra usage', "You've hit your"],
    'permission-prompt': ['^subagent status: waiting'],
    'config-error': ['Invalid model', 'model .* not (found|available)', 'not authenticated'],
    crashed: ['^subagent ended: (error|refused)', '^subagent status: failed'],
    interrupted: ['^subagent ended: aborted', '^subagent status: killed'],
  },
}

const HINTS: Record<OmhVerdict, string> = {
  'finished-late': 'The result arrived after the grace period; collect and verify it as usual.',
  'quota-exhausted': 'Its subscription is out of quota: dispatch the task again without naming a worker so routing skips that provider, or wait for the reset.',
  'permission-prompt': 'It is waiting on a dialog. Read it (`herdr agent read <name>` in herdr, `hc read <address>` in herdr-core; a subagent asks in this session) and ask the user before answering anything that changes files or permissions.',
  'config-error': 'The agent or model is misconfigured (login, model id, API key). Tell the user what to fix; re-dispatching will fail the same way.',
  crashed: 'The agent crashed. Read the pane, then spawn a fresh worker for the task.',
  interrupted: 'The agent was interrupted (by the user or a keypress). Ask before re-dispatching.',
  unknown: 'Nothing recognisable on screen. Read the excerpt and decide; add a rule to agents.json "diagnose" if this repeats.',
}

export type DiagnoseInput = {
  agent: string
  phase: OmhPhase
  screen: string
  hasResult: boolean
  quotaExhausted: string | null // the reason, when the worker's provider is over its threshold
  rules?: DiagnoseRules
  at: number
}

function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'im')
  } catch {
    return null
  }
}

/** The last `lines` non-empty lines of the screen. */
export function excerpt(screen: string, lines = 12): string {
  return screen
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '')
    .slice(-lines)
    .join('\n')
}

export function diagnose(input: DiagnoseInput): OmhDiagnosis {
  const done = (verdict: OmhVerdict, evidence: string): OmhDiagnosis => ({ verdict, evidence, hint: HINTS[verdict], at: input.at })

  if (input.hasResult) return done('finished-late', 'result.md exists')

  const rules: DiagnoseRules = { ...(DEFAULT_RULES[input.agent] ?? {}), ...(input.rules ?? {}) }
  // Only the bottom of the screen describes the present; older lines are history.
  const recent = excerpt(input.screen, 40)
  for (const verdict of RULE_ORDER) {
    for (const pattern of rules[verdict] ?? []) {
      const re = compile(pattern)
      const m = re?.exec(recent)
      if (m) {
        const at = recent.lastIndexOf('\n', m.index) + 1
        const end = recent.indexOf('\n', m.index + m[0].length)
        return done(verdict, recent.slice(at, end < 0 ? undefined : end).trim().slice(0, 300))
      }
    }
  }
  if (input.quotaExhausted !== null) return done('quota-exhausted', input.quotaExhausted)
  // A subagent's "screen" is its status and answer (a BLOCKED reason, say): show it rather than guess.
  if (input.phase === 'gone' && input.agent !== 'subagent') return done('crashed', 'the pane closed or the agent exited before writing result.md')
  return done('unknown', excerpt(input.screen, 8).slice(-600))
}
