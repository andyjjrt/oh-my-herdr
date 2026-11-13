// $.state contract for oh-my-herdr. These are a cache for drawing; the files under .omh/ are the
// source of truth and every value here is rebuilt from them after a reload.

/** Where a worker stands, from the mod's state machine (hooks/lib/settle.ts). */
export type OmhPhase =
  | 'idle' // alive, no task
  | 'dispatched' // prompt sent, `working` not seen yet
  | 'running' // seen working
  | 'checking' // went idle after working; waiting for result.md within the grace period
  | 'finished' // result.md written
  | 'blocked' // waiting on a dialog or question
  | 'stalled' // never started working after the prompt
  | 'idle-no-result' // stopped without result.md
  | 'gone' // pane closed or agent exited

export type OmhVerdict =
  | 'finished-late'
  | 'quota-exhausted'
  | 'permission-prompt'
  | 'config-error'
  | 'crashed'
  | 'interrupted'
  | 'unknown'

export type OmhDiagnosis = { verdict: OmhVerdict; evidence: string; hint: string; at: number }

export type OmhWorker = {
  name: string
  pane: string
  profile: string
  family: string
  agent: string
  phase: OmhPhase
  task: string | null
  run: string | null
  dispatchedAt: number | null
  sawWorking: boolean
  checkSince: number | null
  lastStatus: string
  diagnosis: OmhDiagnosis | null
}

export type OmhTaskStatus = 'pending' | 'working' | 'blocked' | 'alert' | 'reported' | 'verified' | 'abandoned'

export type OmhTaskView = {
  id: string
  title: string
  category: string
  status: OmhTaskStatus
  worker: string | null
  profile: string | null
  note: string | null
}

export type OmhWaveView = { id: number; gate: string; gatePassed: boolean; tasks: OmhTaskView[] }

export type OmhRunView = { id: string; dir: string; goal: string; current: number | null; waves: OmhWaveView[] }

/** What the status line shows besides the engine's own mode pill. */
export type OmhStatusbar = {
  cwd: string
  /** The checked-out branch, a short commit id when detached; null outside a git repository. */
  branch: string | null
  model: string
  effort: string | null
  contextPercent: number | null
  limits: { kind: string; percent: number }[]
}

export type OmhWake = { sections: string[]; settleKey: string }

export type OmhQuotaWindow = { name: string; usedPercent: number; resetsAt: string | null; scope: string | null }

export type OmhQuota = {
  provider: string
  checkedAt: number
  windows: OmhQuotaWindow[]
  limitReached: boolean
  error: string | null
  source: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'oh-my-herdr': {
      run: Shaped<OmhRunView | null>
      workers: Shaped<Record<string, OmhWorker>>
      quota: Shaped<Record<string, OmhQuota>>
      continueCount: number
      /** Wake-ups not yet sent to the lead, and the last wave state it was told about. Kept here so a reload loses neither. */
      wake: Shaped<OmhWake>
      boardOpen: boolean
      statusbar: Shaped<OmhStatusbar | null>
    }
  }
}
