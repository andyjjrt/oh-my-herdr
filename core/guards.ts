// File ownership while workers run. Pure.
//
// A task's `owns` (plan.json) belongs to its worker from dispatch until the task is reported,
// verified or abandoned; the lead editing those files meanwhile would race the worker. This only
// catches Edit/Write/NotebookEdit: a Bash command that writes a file is not seen (it is a guard
// against slips, not a sandbox).

import type { OmhRunView } from './types'
import type { Plan } from './plan'
import { normalizePath, overlaps } from './plan'

/** Project-relative path, or null when the path is outside the project. */
export function relativeTo(root: string, path: string): string | null {
  const r = root.replace(/\/+$/, '')
  if (!path.startsWith('/')) return normalizePath(path)
  if (path === r) return ''
  if (!path.startsWith(`${r}/`)) return null
  return normalizePath(path.slice(r.length + 1))
}

export type Owner = { task: string; worker: string | null; owns: string }

/** Which running task owns this file, if any. */
export function ownerOf(rel: string, plan: Plan, run: OmhRunView): Owner | null {
  for (const wave of run.waves) {
    for (const t of wave.tasks) {
      if (t.status !== 'working' && t.status !== 'blocked' && t.status !== 'alert') continue
      const planned = plan.waves.find(w => w.id === wave.id)?.tasks.find(x => x.id === t.id)
      const hit = planned?.owns.find(f => overlaps(rel, f))
      if (hit !== undefined) return { task: t.id, worker: t.worker, owns: hit }
    }
  }
  return null
}
