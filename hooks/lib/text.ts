// What the lead reads: wake-up messages, the status summary, the /ulw opening prompt. Pure.

import type { OmhDiagnosis, OmhRunView, OmhTaskStatus, OmhWaveView, OmhWorker } from '../../types'
import { code, table } from './md'
import { isSubagentWorker, subagentIdOf } from './subagent'

const ICON: Record<OmhTaskStatus, string> = {
  pending: '⏳',
  working: '🔄',
  blocked: '⚠️',
  alert: '❗',
  reported: '📝',
  verified: '✅',
  abandoned: '✖️',
}

export function alertText(w: OmhWorker, phase: string, d: OmhDiagnosis, screen: string): string {
  return [
    `[oh-my-herdr] ⚠ worker \`${w.name}\`${w.task ? ` (task ${w.task})` : ''} is **${phase}**.`,
    `Diagnosis: **${d.verdict}** — ${d.evidence}`,
    `Hint: ${d.hint}`,
    ...(screen.trim() ? ['Screen (last lines):', '```', screen.trim(), '```'] : []),
    'Do not answer dialogs that change files or permissions without asking the user. Other workers keep running; you will be woken again when the wave settles.',
  ].join('\n')
}

export function settleText(run: OmhRunView, wave: OmhWaveView, workers: Record<string, OmhWorker>): string {
  const rows = wave.tasks.map(t => {
    const w = t.worker ? workers[t.worker] : undefined
    const detail =
      t.status === 'reported'
        ? 'result.md written'
        : t.status === 'pending'
          ? 'not dispatched'
          : w?.diagnosis
            ? `${w.diagnosis.verdict}: ${w.diagnosis.evidence}`.slice(0, 120)
            : (t.note ?? '')
    return `| ${ICON[t.status]} ${t.id} | ${t.title} | ${t.status} | ${t.worker ?? ''}${t.profile ? ` (${t.profile})` : ''} | ${detail.replace(/\|/g, '/')} |`
  })
  const reported = wave.tasks.filter(t => t.status === 'reported').map(t => t.id)
  const pending = wave.tasks.filter(t => t.status === 'pending').map(t => t.id)
  return [
    `[oh-my-herdr] Wave ${wave.id} of run \`${run.id}\` has settled: no worker is still busy on it.`,
    '',
    '| Task | Title | Status | Worker | Detail |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    'Next:',
    ...(reported.length > 0
      ? [`- \`omh_collect\` each reported task (${reported.join(', ')}). A report is a claim: check it yourself (run the tests, read the diff).`]
      : []),
    '- For each task, `omh_status` with action `verified` (or `abandon`) and a one-line `quality` note on how good the result was.',
    ...(pending.length > 0 ? [`- Still not dispatched in this wave: ${pending.join(', ')}.`] : []),
    `- When every task in wave ${wave.id} is verified or abandoned, run its gate (“${wave.gate}”) and mark it with \`omh_status\` action \`gate\`.`,
  ].join('\n')
}

/** The full board, for the lead (omh_status show, after a compaction) and /omh status full. */
export function statusText(run: OmhRunView | null, workers: Record<string, OmhWorker>): string {
  const out: string[] = []
  if (run === null) {
    out.push('No run in progress. Start one with /ulw <goal>, or write a plan with omh_status action "plan".')
  } else {
    out.push(`Run ${code(run.id)}: ${run.goal}`, '', `dir ${code(run.dir)}`)
    for (const w of run.waves) {
      const done = w.tasks.filter(t => t.status === 'verified' || t.status === 'abandoned').length
      const mark = w.gatePassed ? ' · ✅ gate passed' : w.id === run.current ? ' · ◀ current' : ''
      out.push('', `### Wave ${w.id} · ${done}/${w.tasks.length} closed${mark}`, '', `Gate: ${w.gate}`, '')
      out.push(
        table(
          ['Task', 'Status', 'Title', 'Worker', 'Note'],
          w.tasks.map(t => [`${ICON[t.status]} ${t.id}`, t.status, t.title, t.worker ? `${t.worker}${t.profile ? ` (${t.profile})` : ''}` : '', t.note ?? '']),
        ),
      )
    }
  }
  const ws = Object.values(workers)
  if (ws.length > 0) {
    out.push('', '### Workers', '')
    out.push(
      table(
        ['Worker', 'Phase', 'Profile', 'Family', 'Where', 'Task', 'Diagnosis'],
        ws.map(w => [w.name, w.phase, w.profile, w.family, isSubagentWorker(w) ? `◆ subagent ${subagentIdOf(w)}` : `pane ${w.pane}`, w.task ?? '', w.diagnosis?.verdict ?? '']),
      ),
    )
  }
  return out.join('\n')
}

/**
 * /omh status for a person: the current wave in detail, every other wave on one line, and only the
 * workers that are busy or in trouble. The full board (run dir, profiles, panes) is `/omh status full`
 * and what the lead reads.
 */
export function statusBrief(run: OmhRunView | null, workers: Record<string, OmhWorker>): string {
  const out: string[] = []
  if (run === null) {
    out.push('No run in progress. /ulw <goal> starts one.')
  } else {
    const all = run.waves.flatMap(w => w.tasks)
    const closed = all.filter(t => t.status === 'verified' || t.status === 'abandoned').length
    const trouble = all.filter(t => t.status === 'alert' || t.status === 'blocked').length
    const at = run.current === null ? 'done' : `W${run.current}/${run.waves.length}`
    out.push(`**${run.goal}** · ${at} · ${closed}/${all.length} closed${trouble > 0 ? ` · ⚠ ${trouble}` : ''}`, '')
    for (const w of run.waves) {
      const done = w.tasks.filter(t => t.status === 'verified' || t.status === 'abandoned').length
      if (w.id !== run.current) {
        out.push(w.gatePassed ? `- ✓ W${w.id} gate passed (${w.tasks.length} task${w.tasks.length === 1 ? '' : 's'})` : `- · W${w.id} ${done}/${w.tasks.length}`)
        continue
      }
      out.push(`- ▶ **W${w.id}** ${done}/${w.tasks.length} · gate: ${w.gate}`)
      for (const t of w.tasks) {
        const who = t.worker && (t.status === 'working' || t.status === 'blocked' || t.status === 'alert') ? ` → ${t.worker}` : ''
        out.push(`  - ${ICON[t.status]} ${t.id} ${t.title}${who}${t.note && t.status !== 'verified' ? ` · ${t.note}` : ''}`)
      }
    }
  }
  const ws = Object.values(workers)
  const shown = ws.filter(w => w.phase !== 'idle')
  const idle = ws.length - shown.length
  if (ws.length > 0) {
    const bits = shown.map(w => `${isSubagentWorker(w) ? '◆' : ''}${w.name} ${w.diagnosis ? w.diagnosis.verdict : w.phase}`)
    if (idle > 0) bits.push(`${idle} idle`)
    out.push('', `Workers: ${bits.join(', ')}`)
  }
  return out.join('\n')
}

export type ScoutRow = { id: string; worker: string; state: string; detail: string }

/** Every scout out is back (or stuck): what the lead reads before planning on. */
export function scoutsText(rows: readonly ScoutRow[]): string {
  const reported = rows.filter(r => r.state === 'reported').map(r => r.id)
  const other = rows.filter(r => r.state !== 'reported').map(r => r.id)
  return [
    '[oh-my-herdr] Scouts are back: no scout is still busy.',
    '',
    '| Scout | Worker | State | Detail |',
    '|---|---|---|---|',
    ...rows.map(r => `| ${r.id} | ${r.worker} | ${r.state} | ${r.detail.replace(/\|/g, '/').slice(0, 120)} |`),
    '',
    'Next:',
    ...(reported.length > 0 ? [`- \`omh_collect\` each one (${reported.join(', ')}); collecting closes the scout and frees its worker. Spot-check the file:line evidence before you rely on it.`] : []),
    ...(other.length > 0 ? [`- Without a report: ${other.join(', ')}. Dispatch it again, or \`omh_status\` action \`abandon\` with a one-line quality note.`] : []),
    '- Then keep planning: send more scouts if something is still unclear, or draft plan.md (`omh_status` action `draft`) and end your turn for the user\'s approval.',
  ].join('\n')
}

export function ulwPrompt(goal: string): string {
  return [
    `ulw — ultrawork with oh-my-herdr. Goal: ${goal.trim() || '(ask me what the goal is)'}`,
    '',
    'Run the oh-my-herdr loop with the `mcp__oh-my-herdr__*` tools:',
    '1. Explore enough to plan, in parallel. Read the entry points yourself, and fan the rest out — this ulw is my explicit request for helpers, so use them:',
    '   - Claude Code subagents: several `Explore` (or `Plan`) agents via the Agent tool, launched in ONE message so they run at once, each owning a different area and returning file:line evidence. Best for quick look-ups; they come back within this turn.',
    '   - herdr scouts: `omh_dispatch` with a task id `scout-<name>`, intent `explore` or `research`, before any plan exists. They run read-only on routed (cheaper) models in worker panes; best for long reads and external docs. After dispatching them END YOUR TURN: you are woken when they are all back, then `omh_collect` each.',
    '2. Intent Gate: for every task decide its intent (explore, research, implement, fix, review, plan, write) and category.',
    '3. Draft the plan in prose with `omh_status` action `draft` (plan.md: goal, findings with file:line, approach, tasks with acceptance checks, risks, open questions). Summarise it for me and END YOUR TURN: I read it and approve it with /omh approve, or ask for changes.',
    '4. Once approved, derive the waves from plan.md with `omh_status` action `plan`: waves of tasks, each task with the files it owns; a gate per wave.',
    '5. Dispatch the current wave with `omh_dispatch` (intent, category, a one-line rationale, the brief). Do not wait or poll: you will be woken when the wave settles or a worker needs you.',
    '6. When woken: `omh_collect`, verify each result yourself, mark it `verified` or `abandon` with a one-line quality note, run the gate, mark it, then dispatch the next wave.',
    '7. Finish with the full acceptance check, a short report, and `omh_teardown`.',
  ].join('\n')
}
