// GENERATED FILE - do not edit; source: /core/layout.ts
// Regenerate with: bun scripts/sync.ts
// Claude Code needs real files in the plugin; this header also keeps the generated copy
// distinct from the source in Git rename detection, so the source keeps its history.
// Where the next pane worker goes. Pure.
//
// Worker panes live in omh-workers tabs in the lead's own workspace (a new tab lands after the
// lead's). A tab takes at most `maxPanes` panes; then the next tab opens (omh-workers-2, …). In a
// tab, a fresh tab's root pane is used first, then the last pane is split, right and down in turn.

export type TabSlot = {
  tab: string
  /** The tab's root pane, while no worker has taken it yet. */
  freeRoot: string | null
  /** Panes in the tab now, or null when the tab is gone. */
  count: number | null
  /** The last pane in the tab, to split from. */
  lastPane: string | null
}

export type Placement =
  | { kind: 'root'; tab: string; pane: string }
  | { kind: 'split'; tab: string; anchor: string; direction: 'right' | 'down' }
  | { kind: 'new-tab'; label: string }

export const TAB_LABEL = 'omh-workers'

export function place(tabs: readonly TabSlot[], maxPanes: number): Placement {
  const cap = Math.max(1, Math.floor(maxPanes))
  for (const t of tabs) {
    if (t.count === null) continue
    if (t.freeRoot !== null) return { kind: 'root', tab: t.tab, pane: t.freeRoot }
    if (t.count < cap && t.lastPane !== null) return { kind: 'split', tab: t.tab, anchor: t.lastPane, direction: t.count % 2 === 1 ? 'right' : 'down' }
  }
  const live = tabs.filter(t => t.count !== null).length
  return { kind: 'new-tab', label: live === 0 ? TAB_LABEL : `${TAB_LABEL}-${live + 1}` }
}
