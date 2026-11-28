// What the TUI part draws, as plain data: the progress line (prompt.footer.status or
// session.composer.top, per `display`) and the board lines (session.panel). The .tsx only maps
// tones to theme colours. Mirrors claudecode/hooks/lib/statusbar.tsx and board.tsx.

import { runProgress } from '../../../core/plan'
import { isSubagentWorker } from '../../../core/subagent'
import type { OmhQuota, OmhRunView, OmhTaskStatus, OmhWorker } from '../../../core/types'
import type { Snapshot } from '../rpc/protocol'

export type Tone = 'base' | 'muted' | 'accent' | 'warning' | 'error' | 'success' | 'info'
export type Segment = { text: string; tone: Tone; bold?: boolean }

export function progressBar(done: number, total: number, width = 6): string {
  const filled = total > 0 ? Math.max(0, Math.min(width, Math.round((done / total) * width))) : 0
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** A run id without its date prefix: 20261127-opencode-port -> opencode-port. */
export function shortRun(id: string): string {
  return id.replace(/^\d{8}-/, '')
}

/** Highest top-level window per provider; only the ones near or at their limit make the hint. */
export function quotaHint(quota: Record<string, OmhQuota>, threshold = 80): string | null {
  const hot: string[] = []
  for (const q of Object.values(quota)) {
    if (q.error) continue
    const used = Math.round(Math.max(0, ...q.windows.filter(w => w.scope === null).map(w => w.usedPercent)))
    if (q.limitReached) hot.push(`${q.provider} limit`)
    else if (used >= threshold) hot.push(`${q.provider} ${used}%`)
  }
  return hot.length > 0 ? `quota ${hot.join(' ')}` : null
}

/**
 * omh <run> ██░░░░ 2/5 · W2/3 · ●2 ◆1 ⚠1 · quota claude 92%
 * null when there is nothing to show (no server, no run, no plan.json yet): the slot stays empty.
 */
export function statusSegments(snap: Snapshot | null): Segment[] | null {
  if (snap === null || !snap.active || snap.run === null) return null
  const run = snap.run
  const prog = runProgress(run)
  if (prog === null) return null
  const tasks = run.waves.flatMap(w => w.tasks)
  const count = (...s: OmhTaskStatus[]) => tasks.filter(t => s.includes(t.status)).length
  const working = count('working')
  const reported = count('reported')
  const cells = progressBar(prog.done, prog.total)
  const out: Segment[] = [
    { text: 'omh ', tone: 'accent', bold: true },
    { text: `${shortRun(run.id)} `, tone: 'muted' },
    { text: cells.replace(/░/g, ''), tone: prog.alerts > 0 ? 'warning' : 'accent' },
    { text: cells.replace(/█/g, ''), tone: 'muted' },
    { text: ` ${prog.done}/${prog.total}`, tone: 'base' },
    { text: ` · W${run.current}/${run.waves.length}`, tone: 'muted' },
  ]
  const states: Segment[] = []
  if (working > 0) states.push({ text: ` ●${working}`, tone: 'info' })
  if (reported > 0) states.push({ text: ` ◆${reported}`, tone: 'base' })
  if (prog.alerts > 0) states.push({ text: ` ⚠${prog.alerts}`, tone: 'warning' })
  if (states.length > 0) out.push({ text: ' ·', tone: 'muted' }, ...states)
  const hint = quotaHint(snap.quota)
  if (hint !== null) out.push({ text: ` · ${hint}`, tone: 'warning' })
  return out
}

export function statusLine(snap: Snapshot | null): string | null {
  const segs = statusSegments(snap)
  return segs === null ? null : segs.map(s => s.text).join('')
}

const ICON: Record<OmhTaskStatus, string> = {
  pending: '·',
  working: '●',
  blocked: '⚠',
  alert: '!',
  reported: '◆',
  verified: '✓',
  abandoned: '✗',
}

const TASK_TONE: Record<OmhTaskStatus, Tone> = {
  pending: 'muted',
  working: 'info',
  blocked: 'warning',
  alert: 'error',
  reported: 'accent',
  verified: 'success',
  abandoned: 'muted',
}

/** `wrap: false`: one row, cut at the panel's edge (task and worker rows); the rest wraps. */
export type Line = { text: string; tone: Tone; bold?: boolean; wrap?: boolean }

function workerTone(w: OmhWorker): Tone {
  if (w.phase === 'blocked' || w.phase === 'stalled') return 'warning'
  if (w.phase === 'gone' || w.phase === 'idle-no-result') return 'error'
  return 'base'
}

/** The board: run, waves and tasks, workers, quota. `null` snapshot = no server part answering. */
export function boardLines(snap: Snapshot | null): Line[] {
  const lines: Line[] = []
  if (snap === null || !snap.active) {
    lines.push({ text: 'oh-my-herdr is not active in this opencode server.', tone: 'muted' })
    return lines
  }
  const run: OmhRunView | null = snap.run
  if (run === null) {
    lines.push({ text: 'No run in progress. /ulw <goal> starts one.', tone: 'muted' })
  } else {
    lines.push({ text: run.goal, tone: 'base', bold: true })
    lines.push({ text: run.id, tone: 'muted' })
    for (const w of run.waves) {
      const isCurrent = w.id === run.current
      lines.push({ text: `${w.gatePassed ? '✓' : isCurrent ? '▶' : ' '} Wave ${w.id} — gate: ${w.gate}`, tone: w.gatePassed ? 'muted' : 'base', bold: isCurrent })
      for (const t of w.tasks) {
        const parts = [`   ${ICON[t.status]} ${t.id} ${t.title}`]
        if (t.worker) parts.push(` → ${t.worker}`)
        if (t.profile) parts.push(` (${t.profile})`)
        if (t.note && (t.status === 'alert' || t.status === 'blocked')) parts.push(` — ${t.note}`)
        lines.push({ text: parts.join(''), tone: TASK_TONE[t.status], wrap: false })
      }
    }
  }
  const ws = Object.values(snap.workers)
  if (ws.length > 0) {
    lines.push({ text: ' ', tone: 'base' })
    lines.push({ text: 'Workers', tone: 'base', bold: true })
    for (const w of ws) {
      lines.push({
        text: `${isSubagentWorker(w) ? '◆ ' : '  '}${w.name} ${w.phase} ${w.profile}${w.task ? ` · ${w.task}` : ''}${w.diagnosis ? ` · ${w.diagnosis.verdict}` : ''}`,
        tone: workerTone(w),
        wrap: false,
      })
    }
  }
  const qs = Object.values(snap.quota)
  if (qs.length > 0) {
    lines.push({ text: ' ', tone: 'base' })
    lines.push({
      text: `quota: ${qs.map(q => (q.error ? `${q.provider} ?` : `${q.provider} ${Math.round(Math.max(0, ...q.windows.filter(w => w.scope === null).map(w => w.usedPercent)))}%`)).join(' · ')}`,
      tone: 'muted',
    })
  }
  return lines
}
