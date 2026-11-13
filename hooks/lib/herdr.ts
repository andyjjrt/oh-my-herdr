// The herdr CLI, through `$.process.run`. Every call returns parsed JSON or throws HerdrError.

import type { Engine } from './engine'

export class HerdrError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly output: string,
  ) {
    super(message)
  }
}

type Json = Record<string, unknown>
const rec = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})

export async function herdr($: Engine, args: readonly string[], timeoutMs = 30_000): Promise<Json> {
  const res = await $.process.run(['herdr', ...args], { timeoutMs })
  const out = res.stdout.trim()
  if (res.exitCode !== 0) {
    let code: string | null = null
    let message = res.stderr.trim() || out || `herdr ${args[0]} exited ${res.exitCode}`
    try {
      const err = rec(rec(JSON.parse(res.stderr.trim() || out)).error)
      code = typeof err.code === 'string' ? err.code : null
      if (typeof err.message === 'string') message = err.message
    } catch {
      // plain-text error
    }
    throw new HerdrError(message, code, `${out}\n${res.stderr}`.trim())
  }
  if (!out) return {}
  try {
    return rec(JSON.parse(out))
  } catch {
    return { text: out }
  }
}

/** Agent status of a pane or agent name: idle|working|blocked|done|unknown, 'none' without an agent, 'gone' without a pane. */
export async function agentStatus($: Engine, target: string): Promise<string> {
  try {
    const r = await herdr($, ['agent', 'get', target])
    const a = rec(rec(r.result).agent)
    return (typeof a.agent_status === 'string' && a.agent_status) || (typeof a.status === 'string' && a.status) || 'unknown'
  } catch (err) {
    if (err instanceof HerdrError && err.code === 'agent_not_found') {
      return (await paneExists($, target)) ? 'none' : 'gone'
    }
    throw err
  }
}

export async function paneExists($: Engine, pane: string): Promise<boolean> {
  try {
    await herdr($, ['pane', 'get', pane])
    return true
  } catch (err) {
    if (err instanceof HerdrError) return false
    throw err
  }
}

/** The pane's recent text (agent read works only while an agent occupies it; pane read always). */
export async function readScreen($: Engine, pane: string, lines = 80): Promise<string> {
  const res = await $.process.run(['herdr', 'pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', String(lines)], { timeoutMs: 15_000 })
  return res.exitCode === 0 ? res.stdout : ''
}

export async function splitPane($: Engine, anchor: string, direction: 'right' | 'down', cwd: string): Promise<string> {
  const r = await herdr($, ['pane', 'split', anchor, '--direction', direction, '--cwd', cwd, '--env', 'OMH_ROLE=worker', '--no-focus'])
  const id = rec(rec(r.result).pane).pane_id
  if (typeof id !== 'string') throw new HerdrError('pane split returned no pane id', null, JSON.stringify(r))
  return id
}

export async function createTab($: Engine, label: string, cwd: string): Promise<{ tab: string; pane: string }> {
  const r = await herdr($, ['tab', 'create', '--label', label, '--cwd', cwd, '--env', 'OMH_ROLE=worker', '--no-focus'])
  const res = rec(r.result)
  const tab = rec(res.tab).tab_id ?? rec(res.tab).id
  const pane = rec(res.root_pane).pane_id
  if (typeof tab !== 'string' || typeof pane !== 'string') throw new HerdrError('tab create returned no ids', null, JSON.stringify(r))
  return { tab, pane }
}

export async function closePane($: Engine, pane: string): Promise<void> {
  await herdr($, ['pane', 'close', pane])
}

export async function notify($: Engine, title: string, body: string, sound: 'none' | 'done' | 'request'): Promise<void> {
  await $.process.run(['herdr', 'notification', 'show', title, '--body', body, '--sound', sound], { timeoutMs: 10_000 }).catch(() => undefined)
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}
