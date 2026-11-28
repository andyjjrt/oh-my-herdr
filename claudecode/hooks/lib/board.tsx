// The /omh board pane. The run's progress also shows under or above the prompt (claudecode/hooks/lib/statusbar.tsx) and in .omh/status.json.

import { isSubagentWorker } from '../../core/subagent'
import type { OmhQuota, OmhRunView, OmhTaskStatus, OmhWorker } from '../../core/types'

export const BOARD_ID = 'omh-board'

type Elements = { Box: any; Text: any }

const COLOR: Partial<Record<OmhTaskStatus, string>> = { blocked: 'yellow', alert: 'red', verified: 'green', reported: 'cyan', working: 'blue' }

const ICON: Record<OmhTaskStatus, string> = {
  pending: '·',
  working: '●',
  blocked: '⚠',
  alert: '!',
  reported: '◆',
  verified: '✓',
  abandoned: '✗',
}

export function bar(done: number, total: number, width: number): string {
  const filled = total > 0 ? Math.round((done / total) * width) : 0
  return '▓'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

export function boardView(el: Elements, run: OmhRunView | null, workers: Record<string, OmhWorker>, quota: Record<string, OmhQuota>, rows: number): unknown {
  const { Box, Text } = el
  const lines: unknown[] = []
  if (run === null) {
    lines.push(<Text dimColor>No run in progress. /ulw &lt;goal&gt; starts one.</Text>)
  } else {
    lines.push(<Text bold>{run.goal}</Text>)
    lines.push(<Text dimColor>{run.id}</Text>)
    for (const w of run.waves) {
      const isCurrent = w.id === run.current
      lines.push(
        <Text bold={isCurrent} dimColor={w.gatePassed}>
          {w.gatePassed ? '✓' : isCurrent ? '▶' : ' '} Wave {w.id} — gate: {w.gate}
        </Text>,
      )
      for (const t of w.tasks) {
        lines.push(
          <Text color={COLOR[t.status]} dimColor={t.status === 'pending' || t.status === 'abandoned'}>
            {'   '}
            {ICON[t.status]} {t.id} {t.title}
            {t.worker ? ` → ${t.worker}` : ''}
            {t.profile ? ` (${t.profile})` : ''}
            {t.note && (t.status === 'alert' || t.status === 'blocked') ? ` — ${t.note}` : ''}
          </Text>,
        )
      }
    }
  }
  const ws = Object.values(workers)
  if (ws.length > 0) {
    lines.push(<Text> </Text>)
    lines.push(<Text bold>Workers</Text>)
    for (const w of ws) {
      lines.push(
        <Text color={w.phase === 'blocked' || w.phase === 'stalled' ? 'yellow' : w.phase === 'gone' || w.phase === 'idle-no-result' ? 'red' : undefined}>
          {isSubagentWorker(w) ? '◆ ' : '  '}
          {w.name} {w.phase} {w.profile}
          {w.task ? ` · ${w.task}` : ''}
          {w.diagnosis ? ` · ${w.diagnosis.verdict}` : ''}
        </Text>,
      )
    }
  }
  const qs = Object.values(quota)
  if (qs.length > 0) {
    lines.push(<Text> </Text>)
    lines.push(
      <Text dimColor>
        quota:{' '}
        {qs
          .map(q => (q.error ? `${q.provider} ?` : `${q.provider} ${Math.round(Math.max(0, ...q.windows.filter(w => w.scope === null).map(w => w.usedPercent)))}%`))
          .join(' · ')}
      </Text>,
    )
  }
  return <Box flexDirection="column">{lines.slice(0, Math.max(3, rows))}</Box>
}
