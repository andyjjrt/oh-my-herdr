// Where the run's progress shows, as the `display` option says:
//
//   statusline  added to the end of Claude Code's own hint line under the prompt, while a run is open —
//                 ⏵⏵ auto mode on · esc to interrupt · omh ██░░░░ 2/5 ⚠1
//               The engine keeps drawing its line (mode pill, background tasks, …); the mod only adds
//               its `tail`, which the terminal draws dim and cuts where the row ends.
//   panel       one row above the prompt while a run is open —
//                 omh ██░░░░ 2/5 · W2/3 · ⚠1
//   off         neither.
//
// Anything else (model, folder, branch, usage) belongs in Claude Code's own status line; the mod
// writes .omh/status.json for one (statusline/omh-wave).

import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { OmhRunView } from '../../types'
import { runProgress } from './plan'

export type Display = 'statusline' | 'panel' | 'off'

export function displayOf(v: unknown): Display {
  return v === 'panel' || v === 'off' ? v : 'statusline'
}

// The run the mod keeps (hooks/lib/runtime.ts); a read must name a const of its own file, and reading
// it while drawing redraws when the run changes.
const RUN = atom({ plugin: 'oh-my-herdr', key: 'run' } as const, null, { shape: 'run-1' })

export function progressBar(done: number, total: number, width = 6): string {
  const filled = total > 0 ? Math.max(0, Math.min(width, Math.round((done / total) * width))) : 0
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** omh ██░░░░ 2/5, then ⚠1 while a task needs you; null with no open run. */
export function progressText(run: OmhRunView | null): string | null {
  const prog = run ? runProgress(run) : null
  if (!prog) return null
  return `omh ${progressBar(prog.done, prog.total)} ${prog.done}/${prog.total}${prog.alerts > 0 ? ` ⚠${prog.alerts}` : ''}`
}

/** `display: statusline`: what to add to the engine's hint line, or null to leave it as it is. */
export async function statusTail($: EngineInterface): Promise<string | null> {
  return progressText(await read($, RUN))
}

/** `display: panel`: one row above the prompt while a run is open; null otherwise. */
export async function progressPanel($: EngineInterface, el: { Box: any; Text: any }): Promise<unknown> {
  const run = await read($, RUN)
  const prog = run ? runProgress(run) : null
  if (run === null || prog === null) return null
  const { Box, Text } = el
  const cells = progressBar(prog.done, prog.total)
  return (
    <Box flexDirection="row" flexWrap="nowrap">
      <Text wrap="truncate-end">
        <Text color="claude" bold>omh </Text>
        <Text color={prog.alerts > 0 ? 'warning' : 'claude'}>{cells.replace(/░/g, '')}</Text>
        <Text dimColor>{cells.replace(/█/g, '')}</Text>
        <Text> {prog.done}/{prog.total}</Text>
        <Text dimColor> · W{run.current}/{run.waves.length}</Text>
        {prog.alerts > 0 ? <Text color="warning"> · ⚠{prog.alerts}</Text> : ''}
      </Text>
    </Box>
  )
}
