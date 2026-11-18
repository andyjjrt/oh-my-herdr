// Pane workers run in herdr panes or in herdr-core (`hc`) terminals. config.json's `backend` picks
// where new ones start; every call on an existing worker goes by its pane id (`hc:t7` or a herdr
// pane), so workers started before a change of backend keep working.

import type { BackendSetting } from './config'
import type { Engine } from './engine'
import { hcClose, hcExists, hcRead, hcSend, hcStatus, isHcPane, hcAddress } from './hc'
import { agentStatus as herdrStatus, closePane as herdrClose, herdr, paneExists as herdrExists, readScreen as herdrRead } from './herdr'

export type BackendKind = 'herdr' | 'hc'

/** Where new workers start, or why none can. Pure. */
export function resolveBackend(setting: BackendSetting, env: { inHerdr: boolean; inHc: boolean }): { kind: BackendKind } | { error: string } {
  if (setting === 'hc') return { kind: 'hc' }
  if (setting === 'herdr') return env.inHerdr ? { kind: 'herdr' } : { error: 'config "backend": "herdr" needs the lead inside herdr (HERDR_ENV=1); set "backend" to "hc" or "auto"' }
  return { kind: env.inHerdr ? 'herdr' : 'hc' }
}

/** Agent status of a worker's pane: idle|working|blocked|done|unknown, 'none' without an agent, 'gone' without a pane. */
export function agentStatus($: Engine, pane: string): Promise<string> {
  return isHcPane(pane) ? hcStatus($, pane) : herdrStatus($, pane)
}

export function paneExists($: Engine, pane: string): Promise<boolean> {
  return isHcPane(pane) ? hcExists($, pane) : herdrExists($, pane)
}

export function readScreen($: Engine, pane: string, lines = 80): Promise<string> {
  return isHcPane(pane) ? hcRead($, pane, lines) : herdrRead($, pane, lines)
}

export function closePane($: Engine, pane: string): Promise<void> {
  return isHcPane(pane) ? hcClose($, pane) : herdrClose($, pane)
}

/** Hand a worker its next instruction. A blocked worker throws HerdrError code agent_blocked. */
export async function promptWorker($: Engine, w: { name: string; pane: string }, text: string): Promise<void> {
  if (isHcPane(w.pane)) await hcSend($, w.pane, text)
  else await herdr($, ['agent', 'prompt', w.name, text])
}

/** The command a person (or the lead) runs to see a worker's screen. */
export function readCommand(w: { name: string; pane: string }): string {
  return isHcPane(w.pane) ? `hc read ${hcAddress(w.pane)}` : `herdr agent read ${w.name}`
}

/** The watcher process for a worker (scripts/omh-watch.py): JSON lines of its status. */
export function watchArgv(script: string, pane: string, name: string): string[] {
  return isHcPane(pane)
    ? ['python3', '-I', script, '--backend', 'hc', '--pane', hcAddress(pane), '--name', name]
    : ['python3', '-I', script, '--pane', pane, '--name', name]
}
