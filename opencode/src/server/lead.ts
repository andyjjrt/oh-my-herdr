// opencode has no single lead session at setup: the session that runs /ulw or any omh_* tool
// becomes the lead. The herdr pane is still recorded (lead.json's pane), and additionally the
// opencode session ID, so wake can address the conversation even when the server did not inherit
// HERDR_PANE_ID.

import { writeJson } from '../../../core/files'
import { host, isClosed, leadId, openRun, paths, readLead, rt, flushWake } from '../../../core/runtime'

/** The session wake should address, once one has claimed the lead role. */
export function leadSession(): string | null {
  return rt.$?.lead.session ?? null
}

/** Record `sessionID` as the lead. Writes runs/<run>/lead.json with pane, root and session when a
 * run is open; a failed write is logged, never turned into a tool failure. */
export async function claimLead(sessionID: string): Promise<void> {
  const $ = rt.$
  if ($ === null || rt.paths === null || sessionID.trim() === '') return
  $.lead.session = sessionID
  let run: string | null = rt.paths.boundRun
  if (run === null) run = await openRun().catch(() => null)
  if (run === null || (await isClosed(run).catch(() => false))) return
  try {
    const prior = await readLead(run)
    const root = prior?.root ?? paths().root
    // core's bindRun/writeLeadFile rewrites lead.json without the session. Read the file rather
    // than caching the last write, so a claim after approval restores the session field.
    if (prior !== null && prior.pane === leadId() && prior.root === root && (prior as { session?: string }).session === sessionID) return
    await writeJson(host(), `${paths().run(run)}/lead.json`, {
      pane: leadId(),
      root,
      session: sessionID,
    })
    // Wake-ups queued before a restart (or before the first session claimed the lead) can only be
    // addressed now; flushWake keeps the sections until this point.
    await flushWake().catch(() => undefined)
  } catch (err) {
    $.ui.log(`oh-my-herdr: could not write lead.json: ${(err as Error).message}`)
  }
}

/** /omh is also a lead action, but it must not steal a run from the session already leading it. */
export async function ensureLead(sessionID: string): Promise<void> {
  if (leadSession() === null) await claimLead(sessionID)
}
