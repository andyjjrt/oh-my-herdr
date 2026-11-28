// The herdr-core CLI (`hc`), through `$.process.run`: the backend for workers in hc terminals, and
// through them in the Herdr app's window. A worker's pane is recorded as `hc:<address>` (`hc:t7`).
//
// hc never reads a screen for status: a program reports it with OSC 7501 (Claude Code and pi do).
// So `status` is what the program last said, and a program that never says stays 'none'.

import type { HcConfig } from './config'
import type { Engine, EnvName } from './host'
import { HerdrError } from './herdr'

export const HC_PREFIX = 'hc:'

export const isHcPane = (pane: string): boolean => pane.startsWith(HC_PREFIX)
export const hcAddress = (pane: string): string => (isHcPane(pane) ? pane.slice(HC_PREFIX.length) : pane)
export const hcPane = (address: string): string => `${HC_PREFIX}${address}`

type Json = Record<string, unknown>
const rec = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})

/**
 * One hc command with `--json`; parsed JSON, or a HerdrError carrying hc's error `kind` as its code
 * (`not_found`, `blocked`, `spawn_failed`, …). `blocked` becomes `agent_blocked`, as herdr names it.
 */
export async function hc($: Engine, args: readonly string[], timeoutMs = 30_000): Promise<Json> {
  const [cmd, ...rest] = args
  const res = await $.process.run(['hc', cmd!, '--json', ...rest], { timeoutMs })
  const out = res.stdout.trim()
  let parsed: Json = {}
  try {
    parsed = out ? rec(JSON.parse(out)) : {}
  } catch {
    parsed = { text: out }
  }
  const err = rec(parsed.error)
  if (res.exitCode !== 0 || Object.keys(err).length > 0) {
    const kind = typeof err.kind === 'string' ? err.kind : null
    const message = (typeof err.message === 'string' && err.message) || res.stderr.trim() || out || `hc ${cmd} exited ${res.exitCode}`
    throw new HerdrError(message, kind === 'blocked' ? 'agent_blocked' : kind, `${out}\n${res.stderr}`.trim())
  }
  return parsed
}

/** A terminal from `hc get` / `hc ls` / an event snapshot, as the worker state machine reads it. Pure. */
export function statusOfTerminal(t: Json): string {
  if (t.state === 'finished') return 'gone'
  const s = rec(t.status).state
  if (typeof s !== 'string') return 'none'
  if (s === 'error') return 'blocked'
  return s === 'idle' || s === 'working' || s === 'blocked' || s === 'done' ? s : 'unknown'
}

/** idle|working|blocked|done|unknown, 'none' while the program reports nothing, 'gone' when it ended or is unknown to hc. */
export async function hcStatus($: Engine, pane: string): Promise<string> {
  try {
    return statusOfTerminal(await hc($, ['get', hcAddress(pane)]))
  } catch (err) {
    if (err instanceof HerdrError && err.code === 'not_found') return 'gone'
    throw err
  }
}

export async function hcExists($: Engine, pane: string): Promise<boolean> {
  return (await hcStatus($, pane).catch(() => 'gone')) !== 'gone'
}

export async function hcRead($: Engine, pane: string, lines = 80): Promise<string> {
  const res = await $.process.run(['hc', 'read', hcAddress(pane), '--lines', String(lines)], { timeoutMs: 15_000 })
  return res.exitCode === 0 ? res.stdout : ''
}

/** Paste and submit. hc refuses a blocked program (HerdrError code agent_blocked) and holds a person's unfinished draft up to a minute. */
export async function hcSend($: Engine, pane: string, text: string): Promise<void> {
  await hc($, ['send', hcAddress(pane), text], 90_000)
}

/** End its program, then drop the finished terminal. */
export async function hcClose($: Engine, pane: string): Promise<void> {
  await hc($, ['kill', hcAddress(pane)])
  await hc($, ['rm', hcAddress(pane)]).catch(() => undefined)
}

/** The lead's own terminal labels: inside the Herdr app they carry `herdr.space` and `herdr.tab`. */
export async function hcLabels($: Engine, terminal: string | null): Promise<Record<string, string>> {
  if (terminal === null) return {}
  try {
    const labels = rec((await hc($, ['get', terminal])).labels)
    return Object.fromEntries(Object.entries(labels).filter((e): e is [string, string] => typeof e[1] === 'string'))
  } catch {
    return {}
  }
}

/** Live terminals carrying every label. */
export async function hcCount($: Engine, labels: Record<string, string>): Promise<number> {
  const r = await hc($, ['ls', ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`])])
  return Array.isArray(r.terminals) ? r.terminals.length : 0
}

/** A short stable hex id for a path, so each project gets its own omh tabs in the Herdr app. Pure. */
export function pathKey(path: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

/** The Herdr app tab id for the n-th omh workers tab of a project (n from 1). Pure. */
export const tabId = (root: string, n: number): string => `tbomh${pathKey(root)}w${n}`

/**
 * Variables a worker needs that the hc core may lack: the core keeps the environment it started
 * with (usually the login's), not the lead's. Secrets are left out on purpose: hc shows a
 * terminal's argv to anyone who lists it.
 */
export const PASS_ENV: readonly EnvName[] = ['PATH', 'CLAUDE_CONFIG_DIR', 'SENPI_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']

export type HcLaunch = {
  name: string
  cwd: string
  /** The program and its arguments. */
  argv: string[]
  /** Set in the worker on top of the core's environment. */
  env: Record<string, string>
  labels: Record<string, string>
  notify: boolean
}

/** The `hc run` arguments for a worker (after `run`). Pure. */
export function runArgs(l: HcLaunch, withName: boolean): string[] {
  const termName = `omh-${l.name}`.slice(0, 32)
  return [
    '--bg',
    '--outlive-parent',
    ...(l.notify ? [] : ['--no-notify']),
    '--cwd',
    l.cwd,
    ...(withName ? ['--name', termName] : []),
    ...Object.entries(l.labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    '--',
    'env',
    ...Object.entries(l.env).map(([k, v]) => `${k}=${v}`),
    ...l.argv,
  ]
}

/** Start the terminal; its address. A taken name is retried without one. */
export async function hcRun($: Engine, l: HcLaunch): Promise<string> {
  let r: Json
  try {
    r = await hc($, ['run', ...runArgs(l, true)])
  } catch (err) {
    if (!(err instanceof HerdrError) || !/name/i.test(err.message)) throw err
    r = await hc($, ['run', ...runArgs(l, false)])
  }
  if (typeof r.address !== 'string') throw new HerdrError('hc run returned no address', null, JSON.stringify(r))
  return r.address
}

/**
 * Wait (in one host call) until the program first reports idle or done. Exit 0 ready, 3 blocked
 * (a trust or login dialog), 5 it ended, 4 timeout; stdout says which status it saw.
 */
export async function hcWaitReady($: Engine, pane: string, timeoutMs: number): Promise<{ ok: boolean; status: string; reason: string }> {
  const wait = await $.process.run(
    [
      'sh',
      '-c',
      `i=0; while [ $i -lt ${Math.ceil(timeoutMs / 1000)} ]; do
         s=$(hc get --json "$1" 2>/dev/null | python3 -c 'import json,sys
d=json.load(sys.stdin); st=d.get("status") or {}
print("finished" if d.get("state")=="finished" else (st.get("state") or ""))' 2>/dev/null)
         case "$s" in idle|done) echo "$s"; exit 0;; blocked|error) echo "$s"; exit 3;; finished) echo finished; exit 5;; esac
         i=$((i+1)); sleep 1
       done; echo "timeout:$s"; exit 4`,
      'sh',
      hcAddress(pane),
    ],
    { timeoutMs: timeoutMs + 15_000 },
  )
  const status = wait.stdout.trim()
  if (wait.exitCode === 0) return { ok: true, status, reason: '' }
  if (wait.exitCode === 3) return { ok: false, status: 'blocked', reason: 'agent_not_ready: stopped at a prompt during startup (login? trust folder?)' }
  if (wait.exitCode === 5) return { ok: false, status: 'gone', reason: 'the program ended during startup (is it on the PATH the worker gets?)' }
  return { ok: false, status: 'blocked', reason: `hc never heard the agent report ready (${status || 'no status'}); it must report status with OSC 7501` }
}

/** Where a new worker goes in the Herdr app: labels for an omh tab with room, or none. */
export async function placement($: Engine, opts: { cfg: HcConfig; root: string; lead: string | null; maxPanes: number }): Promise<Record<string, string>> {
  if (opts.cfg.panes === 'none') return {}
  const space = (await hcLabels($, opts.lead))['herdr.space']
  if (!space) return {} // not in the Herdr app: a plain hc terminal
  for (let n = 1; n < 100; n++) {
    const tab = tabId(opts.root, n)
    if ((await hcCount($, { 'herdr.tab': tab }).catch(() => 0)) < Math.max(1, opts.maxPanes)) return { 'herdr.space': space, 'herdr.tab': tab }
  }
  return {}
}
