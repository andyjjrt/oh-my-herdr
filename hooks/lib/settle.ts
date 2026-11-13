// The worker state machine. Pure: no `$`, so it is tested directly.
//
//   dispatched ──working──► running ──idle|done──► result.md?
//       │                      │                     ├─ yes → finished
//       │                      │                     └─ no  → checking ──grace──► idle-no-result
//       │                      ├──blocked──► blocked
//       │                      └──gone────► gone
//       └── no `working` within stallMs ──► stalled
//
// A worker must be seen `working` after a dispatch before `idle`/`done` counts as the end: right
// after a prompt is submitted the agent is still idle, and that idle is not completion.

import type { OmhPhase, OmhWorker } from '../../types'

export type SettleEvent =
  | { kind: 'dispatch'; at: number; task: string; run: string }
  | { kind: 'status'; at: number; status: string } // idle | working | blocked | done | unknown | none | gone
  | { kind: 'tick'; at: number }

export type SettleFacts = { hasResult: boolean; stallMs: number; graceMs: number }

export type SettleEffect =
  | { type: 'timer'; ms: number } // call step again with a tick after ms
  | { type: 'settled'; phase: 'finished' } // clean completion
  | { type: 'alert'; phase: 'blocked' | 'stalled' | 'idle-no-result' | 'gone' } // needs the lead
  | { type: 'recovered' } // left blocked/stalled by itself

export type SettleStep = { worker: OmhWorker; effects: SettleEffect[] }

/** Phases with a task in flight. */
export const ACTIVE: ReadonlySet<OmhPhase> = new Set(['dispatched', 'running', 'checking', 'blocked', 'stalled'])

/** Phases where the worker's task has ended, cleanly or not. */
export const TERMINAL: ReadonlySet<OmhPhase> = new Set(['finished', 'idle-no-result', 'gone'])

export function newWorker(fields: Pick<OmhWorker, 'name' | 'pane' | 'profile' | 'family' | 'agent'>): OmhWorker {
  return {
    ...fields,
    phase: 'idle',
    task: null,
    run: null,
    dispatchedAt: null,
    sawWorking: false,
    checkSince: null,
    lastStatus: 'unknown',
    diagnosis: null,
  }
}

export function step(worker: OmhWorker, event: SettleEvent, facts: SettleFacts): SettleStep {
  const w: OmhWorker = { ...worker }
  const effects: SettleEffect[] = []
  const to = (phase: OmhPhase) => {
    w.phase = phase
  }
  const finish = () => {
    to('finished')
    w.checkSince = null
    effects.push({ type: 'settled', phase: 'finished' })
  }

  if (event.kind === 'dispatch') {
    w.task = event.task
    w.run = event.run
    w.dispatchedAt = event.at
    w.sawWorking = false
    w.checkSince = null
    w.diagnosis = null
    to('dispatched')
    effects.push({ type: 'timer', ms: facts.stallMs })
    return { worker: w, effects }
  }

  if (event.kind === 'status') {
    w.lastStatus = event.status
    const st = event.status

    if (st === 'gone') {
      if (ACTIVE.has(w.phase)) {
        if (facts.hasResult) finish()
        else {
          to('gone')
          effects.push({ type: 'alert', phase: 'gone' })
        }
      } else if (w.phase !== 'finished' && w.phase !== 'idle-no-result') {
        to('gone')
      }
      return { worker: w, effects }
    }

    if (!ACTIVE.has(w.phase)) {
      return { worker: w, effects }
    }

    if (st === 'working') {
      const wasStuck = w.phase === 'blocked' || w.phase === 'stalled'
      w.sawWorking = true
      w.checkSince = null
      to('running')
      if (wasStuck) effects.push({ type: 'recovered' })
      return { worker: w, effects }
    }

    if (st === 'blocked') {
      // A dialog after the prompt is proof the prompt arrived.
      w.sawWorking = true
      if (w.phase !== 'blocked') {
        to('blocked')
        effects.push({ type: 'alert', phase: 'blocked' })
      }
      return { worker: w, effects }
    }

    if (st === 'idle' || st === 'done') {
      if (!w.sawWorking) {
        // The idle right after a prompt; the stall timer decides if it never starts.
        return { worker: w, effects }
      }
      if (facts.hasResult) {
        finish()
        return { worker: w, effects }
      }
      if (w.phase !== 'checking') {
        if (w.phase === 'blocked') effects.push({ type: 'recovered' })
        to('checking')
        w.checkSince = event.at
        effects.push({ type: 'timer', ms: facts.graceMs })
      }
      return { worker: w, effects }
    }

    return { worker: w, effects } // unknown / none: no evidence either way
  }

  // tick
  if (facts.hasResult && ACTIVE.has(w.phase) && w.phase !== 'blocked') {
    // result.md can land after the grace period, or while herdr missed the transition.
    if (w.phase !== 'dispatched' || w.sawWorking) {
      const wasStuck = w.phase === 'stalled'
      finish()
      if (wasStuck) effects.unshift({ type: 'recovered' })
      return { worker: w, effects }
    }
  }
  if (w.phase === 'dispatched' && !w.sawWorking && w.dispatchedAt !== null && event.at - w.dispatchedAt >= facts.stallMs) {
    if (facts.hasResult) {
      finish()
    } else {
      to('stalled')
      effects.push({ type: 'alert', phase: 'stalled' })
    }
    return { worker: w, effects }
  }
  if (w.phase === 'checking' && w.checkSince !== null) {
    if (facts.hasResult) finish()
    else if (event.at - w.checkSince >= facts.graceMs) {
      to('idle-no-result')
      effects.push({ type: 'alert', phase: 'idle-no-result' })
    } else {
      effects.push({ type: 'timer', ms: facts.graceMs - (event.at - w.checkSince) })
    }
  }
  return { worker: w, effects }
}

/** A worker whose task ended, cleanly or not, can take a new task. */
export function isFree(w: OmhWorker): boolean {
  return w.phase === 'idle' || w.phase === 'finished' || w.phase === 'idle-no-result'
}
