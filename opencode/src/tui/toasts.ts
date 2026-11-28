// Toasts from one snapshot to the next: a worker that became blocked, stalled, idle without a
// result or gone, and a wave whose tasks all came back. The first snapshot is the baseline and
// raises nothing, so a TUI start or reload does not replay old trouble.

import type { OmhPhase, OmhRunView, OmhWaveView, OmhWorker } from '../../../core/types'
import type { Snapshot } from '../rpc/protocol'

export type Toast = { title: string; message: string; variant: 'info' | 'success' | 'warning' | 'error'; duration?: number }

const TROUBLE: Partial<Record<OmhPhase, { what: string; variant: Toast['variant'] }>> = {
  blocked: { what: 'is blocked', variant: 'warning' },
  stalled: { what: 'stalled', variant: 'warning' },
  'idle-no-result': { what: 'stopped without a result', variant: 'warning' },
  gone: { what: 'died', variant: 'error' },
}

function workerToast(w: OmhWorker): Toast | null {
  const t = TROUBLE[w.phase]
  if (t === undefined) return null
  const bits = [w.task ? `task ${w.task}` : null, w.diagnosis ? `${w.diagnosis.verdict}: ${w.diagnosis.hint}` : null, 'the lead has been woken'].filter(Boolean)
  return { title: `omh: ${w.name} ${t.what}`, message: bits.join(' · '), variant: t.variant, duration: 10_000 }
}

/** All of a wave's tasks are back (reported, verified or abandoned): the wave settled. */
export function waveSettled(w: OmhWaveView): boolean {
  return w.tasks.length > 0 && w.tasks.every(t => t.status === 'reported' || t.status === 'verified' || t.status === 'abandoned')
}

function settledWaves(run: OmhRunView | null): Set<number> {
  return new Set(run === null ? [] : run.waves.filter(w => !w.gatePassed && waveSettled(w)).map(w => w.id))
}

export function toastsBetween(prev: Snapshot | null, next: Snapshot | null): Toast[] {
  if (prev === null || next === null || !next.active) return []
  const out: Toast[] = []
  for (const w of Object.values(next.workers)) {
    const before = prev.workers[w.name]
    if (before !== undefined && before.phase === w.phase && before.task === w.task) continue
    const toast = workerToast(w)
    if (toast !== null) out.push(toast)
  }
  const run = next.run
  if (run !== null) {
    const was = prev.run !== null && prev.run.id === run.id ? settledWaves(prev.run) : new Set<number>()
    const wasGated = new Set(prev.run !== null && prev.run.id === run.id ? prev.run.waves.filter(w => w.gatePassed).map(w => w.id) : [])
    for (const id of settledWaves(run)) {
      if (was.has(id) || wasGated.has(id)) continue
      const wave = run.waves.find(w => w.id === id)!
      out.push({ title: `omh: wave ${id} settled`, message: `${wave.tasks.length} task${wave.tasks.length === 1 ? '' : 's'} back; the lead verifies them against the gate: ${wave.gate}`, variant: 'success', duration: 8_000 })
    }
  }
  return out
}
