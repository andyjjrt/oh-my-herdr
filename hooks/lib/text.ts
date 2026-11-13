// What the lead reads: wake-up messages, the status summary, the /ulw opening prompt. Pure.

import type { OmhDiagnosis, OmhRunView, OmhTaskStatus, OmhWaveView, OmhWorker } from '../../types'

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

export function statusText(run: OmhRunView | null, workers: Record<string, OmhWorker>): string {
  const lines: string[] = []
  if (run === null) {
    lines.push('No run in progress. Start one with /ulw <goal>, or write a plan with omh_status action "plan".')
  } else {
    lines.push(`Run ${run.id} — ${run.goal}`, `dir: ${run.dir}`, '')
    for (const w of run.waves) {
      const done = w.tasks.filter(t => t.status === 'verified' || t.status === 'abandoned').length
      const mark = w.gatePassed ? '✅ gate passed' : w.id === run.current ? '◀ current' : ''
      lines.push(`Wave ${w.id} (${done}/${w.tasks.length} closed) ${mark} — gate: ${w.gate}`)
      for (const t of w.tasks) {
        lines.push(`  ${ICON[t.status]} ${t.id.padEnd(10)} ${t.status.padEnd(9)} ${t.title}${t.worker ? ` → ${t.worker}${t.profile ? ` (${t.profile})` : ''}` : ''}${t.note ? ` — ${t.note}` : ''}`)
      }
    }
  }
  const ws = Object.values(workers)
  if (ws.length > 0) {
    lines.push('', 'Workers:')
    for (const w of ws) {
      lines.push(`  ${w.name.padEnd(14)} ${w.phase.padEnd(14)} ${w.profile} [${w.family}] pane ${w.pane}${w.task ? ` task ${w.task}` : ''}${w.diagnosis ? ` — ${w.diagnosis.verdict}` : ''}`)
    }
  }
  return lines.join('\n')
}

export function ulwPrompt(goal: string): string {
  return [
    `ulw — ultrawork with oh-my-herdr. Goal: ${goal.trim() || '(ask me what the goal is)'}`,
    '',
    'Run the oh-my-herdr loop with the `mcp__oh-my-herdr__*` tools:',
    '1. Explore enough to plan (read code yourself or dispatch `explore` tasks).',
    '2. Intent Gate: for every task decide its intent (explore, research, implement, fix, review, plan, write) and category.',
    '3. Write the plan with `omh_status` action `plan`: waves of tasks, each task with the files it owns; a gate per wave.',
    '4. Dispatch the current wave with `omh_dispatch` (intent, category, a one-line rationale, the brief). Do not wait or poll: you will be woken when the wave settles or a worker needs you.',
    '5. When woken: `omh_collect`, verify each result yourself, mark it `verified` or `abandon` with a one-line quality note, run the gate, mark it, then dispatch the next wave.',
    '6. Finish with the full acceptance check, a short report, and `omh_teardown`.',
  ].join('\n')
}
