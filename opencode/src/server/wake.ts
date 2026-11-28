// One synthetic wake per settled piece of work. opencode's own `id` deduplicates admission but
// still calls execution.wake, so a repeated call would start an empty turn; the in-process set is
// the real guard. A reload loses it, at worst repeating one already-delivered wake.

import { createHash, randomUUID } from 'node:crypto'

import type { EngineContext } from './engine'

const sent = new Set<string>()

/** A stable `msg_...` id for a wake's text; two calls with the same text are the same settle. */
export function settleKeyFor(text: string): string {
  return `msg_omh_${createHash('sha256').update(text).digest('hex').slice(0, 24)}`
}

function idOf(key: string): string {
  if (key.startsWith('msg_')) return key
  return `msg_omh_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
}

/** Wake `sessionID` with a synthetic queued message. `dedupe=false` is for a one-shot prompt submit. */
export async function wakeLead(context: EngineContext, sessionID: string, text: string, settleKey = settleKeyFor(text), dedupe = true): Promise<boolean> {
  if (sessionID.trim() === '') return false
  if (dedupe && sent.has(settleKey)) return false
  await context.session.synthetic({
    sessionID,
    text,
    delivery: 'queue',
    id: idOf(settleKey),
    description: 'oh-my-herdr wake',
    metadata: { source: 'oh-my-herdr', settleKey },
  })
  if (dedupe) sent.add(settleKey)
  return true
}

/** A prompt.submit is a distinct event every time, even when two submissions have identical text. */
export async function wakeNow(context: EngineContext, sessionID: string, text: string): Promise<boolean> {
  return wakeLead(context, sessionID, text, `msg_omh_wake_${randomUUID()}`, false)
}

/** Tests and plugin dispose: forget the sent keys so a fresh setup starts clean. */
export function resetWakeGuard(): void {
  sent.clear()
}

export function sentWakeCount(): number {
  return sent.size
}
