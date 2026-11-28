// GENERATED FILE - do not edit; source: /core/quota.ts
// Regenerate with: bun scripts/sync.ts
// Claude Code needs real files in the plugin; this header also keeps the generated copy
// distinct from the source in Git rename detection, so the source keeps its history.
// Subscription quota, read straight from each provider's usage API.
// The parsers and the evaluation are pure (tested against real responses in claudecode/tests/fixtures/quota);
// `probe` is the part that reaches the network and credential files through `$`.

import { table } from './md'
import type { Engine } from './host'

import type { OmhQuota, OmhQuotaWindow } from './types'
import type { Config, Profile } from './config'

/** Providers read by the mod itself; any other is the user's own, with a `command` in the config. */
export const PROVIDERS = ['claude', 'opencode-go'] as const
type Builtin = (typeof PROVIDERS)[number]
export type Provider = string

const isBuiltin = (p: string): p is Builtin => (PROVIDERS as readonly string[]).includes(p)

/** Every provider checked: the built-in ones, then those the config gives a command. */
export function providersOf(cfg: Config | null): string[] {
  const own = Object.entries(cfg?.quota.providers ?? {})
    .filter(([name, p]) => p.command !== undefined && !isBuiltin(name))
    .map(([name]) => name)
  return [...PROVIDERS, ...own]
}

/**
 * What a provider's command prints: one number, the percent used; or `{ "<window>": <percent>, … }`.
 * Anything else is not usage.
 */
export function parseCommandQuota(stdout: string): { windows: OmhQuotaWindow[]; limitReached: boolean } {
  const v: unknown = JSON.parse(stdout.trim())
  const windows: OmhQuotaWindow[] =
    typeof v === 'number'
      ? [{ name: 'usage', usedPercent: v, resetsAt: null, scope: null }]
      : Object.entries(rec(v)).flatMap(([name, n]) => (num(n) === null ? [] : [{ name, usedPercent: num(n)!, resetsAt: null, scope: null }]))
  if (windows.some(w => !Number.isFinite(w.usedPercent)) || windows.length === 0) throw new Error('no usage in the output')
  return { windows, limitReached: false }
}

type Json = Record<string, unknown>
const rec = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

const MODEL_SCOPES = /opus|sonnet|haiku|fable|mythos/

export function parseClaude(body: unknown): { windows: OmhQuotaWindow[]; limitReached: boolean } {
  const b = rec(body)
  const windows: OmhQuotaWindow[] = []
  const win = (name: string, o: unknown, scope: string | null) => {
    const r = rec(o)
    const used = num(r.utilization)
    if (used !== null) windows.push({ name, usedPercent: used, resetsAt: str(r.resets_at), scope })
  }
  win('5h', b.five_hour, null)
  win('7d', b.seven_day, null)
  win('7d-opus', b.seven_day_opus, 'opus')
  win('7d-sonnet', b.seven_day_sonnet, 'sonnet')
  for (const l of Array.isArray(b.limits) ? b.limits : []) {
    const r = rec(l)
    const used = num(r.percent)
    if (used === null) continue
    const display = str(rec(rec(r.scope).model).display_name)
    const scope = display === null ? null : (display.toLowerCase().match(MODEL_SCOPES)?.[0] ?? null)
    windows.push({ name: str(r.kind) ?? 'limit', usedPercent: used, resetsAt: str(r.resets_at), scope })
  }
  return { windows, limitReached: false }
}

export function parseOpencodeGo(body: unknown): { windows: OmhQuotaWindow[]; limitReached: boolean } {
  const b = rec(body)
  const usage = rec(b.usage ?? b)
  const windows: OmhQuotaWindow[] = []
  let limitReached = false
  for (const [name, v] of Object.entries(usage)) {
    const r = rec(v)
    if (Object.keys(r).length === 0) continue
    const pct = num(r.percent)
    const used = num(r.used)
    const limit = num(r.limit)
    const usedPercent = pct ?? (used !== null && limit !== null && limit > 0 ? (used / limit) * 100 : null)
    if (usedPercent === null) continue
    windows.push({ name, usedPercent, resetsAt: str(r.resetsAt) ?? str(r.resets_at) ?? str(r.reset_at), scope: null })
    if (/exceed|limit|block/.test((str(r.status) ?? '').toLowerCase())) limitReached = true
  }
  return { windows, limitReached }
}

/** Which provider a profile bills against; null when it is not tracked. */
export function providerOf(profile: Profile): Provider | null {
  // Named outright (a provider of the user's own is only ever named); null skips the checks.
  if (profile.quota !== undefined) return profile.quota
  // A subagent runs on the lead's own Claude login.
  if (profile.subagentType !== undefined) return 'claude'
  const args = profile.args.join(' ')
  if (/opencode-go/.test(args)) return 'opencode-go'
  if (/anthropic-subscription|--provider[ =]anthropic\b|(^| )anthropic\//.test(args)) return 'claude'
  if (profile.agent === 'claude') return 'claude'
  return null
}

export type QuotaEval = { status: 'ok' | 'exhausted' | 'unknown'; max: number | null; reason: string }

/** Judge one provider's snapshot for a model (the profile's args, for per-model windows). */
export function evaluate(q: OmhQuota | undefined, threshold: number, modelHint: string): QuotaEval {
  if (q === undefined) return { status: 'unknown', max: null, reason: 'not checked yet' }
  if (q.error !== null) return { status: 'unknown', max: null, reason: q.error }
  const hint = modelHint.toLowerCase()
  const ws = q.windows.filter(w => w.scope === null || hint.includes(w.scope))
  const max = ws.length > 0 ? Math.max(...ws.map(w => w.usedPercent)) : null
  if (q.limitReached) return { status: 'exhausted', max, reason: 'provider reports limit reached' }
  const hot = ws.filter(w => w.usedPercent >= threshold)
  if (hot.length > 0) {
    return {
      status: 'exhausted',
      max,
      reason: hot.map(w => `${w.name} ${Math.floor(w.usedPercent)}% (resets ${w.resetsAt ?? '?'})`).join(', '),
    }
  }
  if (max === null) return { status: 'unknown', max: null, reason: 'no usage windows in response' }
  return { status: 'ok', max, reason: ws.map(w => `${w.name} ${Math.floor(w.usedPercent)}%`).join(', ') }
}

/** true when work may go to this profile; otherwise why not. */
export function quotaAllows(cfg: Config, quota: Record<string, OmhQuota>, profileName: string): true | string {
  if (!cfg.quota.enabled) return true
  const profile = cfg.profiles[profileName]
  if (!profile) return `unknown profile '${profileName}'`
  const provider = providerOf(profile)
  if (provider === null || cfg.quota.providers[provider]?.enabled === false) return true
  // The model a per-model window (7d-opus) applies to: in the args, or a subagent profile's `model`.
  const e = evaluate(quota[provider], cfg.quota.threshold, [...profile.args, profile.model ?? ''].join(' '))
  if (e.status === 'ok') return true
  if (e.status === 'exhausted') return `${provider} quota exhausted: ${e.reason}`
  return cfg.quota.onUnknown === 'block' ? `${provider} quota unknown (${e.reason}); on_unknown=block` : true
}

// ---------------------------------------------------------------- network

type Credential = { token: string; source: string } | { error: string }

async function readJson($: Engine, path: string): Promise<Json | null> {
  try {
    return rec(JSON.parse(await $.fs.read(path)))
  } catch {
    return null
  }
}

async function claudeCredential($: Engine, now: number): Promise<Credential> {
  const home = (await $.env.get('HOME')) ?? ''
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  const file = await readJson($, `${dir}/.credentials.json`)
  const oauth = rec(file?.claudeAiOauth)
  const token = str(oauth.accessToken)
  const expires = num(oauth.expiresAt)
  if (token !== null && (expires === null || expires > now)) return { token, source: 'Claude Code' }
  const env = await $.env.get('CLAUDE_CODE_OAUTH_TOKEN')
  if (env) return { token: env, source: 'environment' }
  return { error: token !== null ? 'token expired — start `claude` once so it refreshes' : 'no Claude credentials found' }
}

async function opencodeCredential($: Engine): Promise<Credential> {
  const go = await $.env.get('OPENCODE_GO_API_KEY')
  if (go) return { token: go, source: 'environment' }
  const any = await $.env.get('OPENCODE_API_KEY')
  if (any) return { token: any, source: 'environment' }
  const home = (await $.env.get('HOME')) ?? ''
  const senpiDir = (await $.env.get('SENPI_CODING_AGENT_DIR')) ?? `${home}/.senpi/agent`
  const piDir = (await $.env.get('PI_CODING_AGENT_DIR')) ?? `${home}/.pi/agent`
  const dataDir = (await $.env.get('XDG_DATA_HOME')) ?? `${home}/.local/share`
  const files: [string, string, (j: Json) => unknown][] = [
    [`${senpiDir}/auth.json`, 'senpi opencode-go', j => rec(j['opencode-go']).key],
    [`${piDir}/auth.json`, 'pi opencode-go', j => rec(j['opencode-go']).key],
    [`${dataDir}/opencode/auth.json`, 'OpenCode', j => rec(j['opencode-go']).key ?? rec(j.opencode).key],
  ]
  for (const [path, source, pick] of files) {
    const j = await readJson($, path)
    const token = j === null ? null : str(pick(j))
    if (token) return { token, source }
  }
  return { error: 'no OpenCode Go key — set OPENCODE_API_KEY or `/login` → OpenCode Go in senpi' }
}

const REQUESTS: Record<Builtin, { url: string; headers: Record<string, string>; parse: (b: unknown) => { windows: OmhQuotaWindow[]; limitReached: boolean } }> = {
  claude: {
    url: 'https://api.anthropic.com/api/oauth/usage',
    headers: { 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
    parse: parseClaude,
  },
  'opencode-go': {
    url: 'https://opencode.ai/zen/go/v1/usage',
    headers: { Accept: 'application/json' },
    parse: parseOpencodeGo,
  },
}

export async function probe($: Engine, provider: Provider, command?: string): Promise<OmhQuota> {
  const checkedAt = await $.clock.now()
  const base = { provider, checkedAt, windows: [], limitReached: false, source: null }
  if (command !== undefined || !isBuiltin(provider)) return probeCommand($, base, command)
  const cred = provider === 'claude' ? await claudeCredential($, checkedAt) : await opencodeCredential($)
  if ('error' in cred) return { ...base, error: cred.error }
  const req = REQUESTS[provider]
  let res
  try {
    res = await $.http.fetch(req.url, { headers: { ...req.headers, Authorization: `Bearer ${cred.token}` } })
  } catch (err) {
    return { ...base, error: `network error reaching usage endpoint: ${(err as Error).message}` }
  }
  if (res.status === 401 || res.status === 403) {
    return { ...base, error: `auth rejected (HTTP ${res.status}, credentials from ${cred.source})` }
  }
  if (!res.ok) return { ...base, error: `usage endpoint HTTP ${res.status}` }
  try {
    const parsed = req.parse(JSON.parse(res.text))
    return { ...base, ...parsed, error: null, source: cred.source }
  } catch {
    return { ...base, error: `response did not parse as JSON (endpoint changed?)` }
  }
}

/** A provider of the user's own: run its command (sh -c) and read what it prints. */
async function probeCommand($: Engine, base: Omit<OmhQuota, 'error'>, command: string | undefined): Promise<OmhQuota> {
  if (command === undefined) return { ...base, error: `no "command" for '${base.provider}' under quota.providers` }
  const res = await $.process.run(['sh', '-c', command], { timeoutMs: 15_000 }).catch(err => ({ exitCode: -1, stdout: '', stderr: (err as Error).message }))
  const why = res.stderr.trim().split('\n')[0] ?? ''
  if (res.exitCode !== 0) return { ...base, error: `command exited ${res.exitCode}${why ? `: ${why}` : ''}` }
  try {
    return { ...base, ...parseCommandQuota(res.stdout), error: null, source: 'command' }
  } catch {
    return { ...base, error: `command printed no usage (a number, or {"window": percent}): ${res.stdout.trim().slice(0, 80)}` }
  }
}

const QUOTA_MARK: Record<string, string> = { ok: '✅ ok', exhausted: '⛔ exhausted', unknown: '❔ unknown' }

/** /omh quota (and the quota part of /omh check): one line of settings, then a table. */
export function formatQuota(cfg: Config, quota: Record<string, OmhQuota>): string {
  const rows = providersOf(cfg).map(p => {
    if (cfg.quota.providers[p]?.enabled === false) return [p, '· disabled', '', '']
    const q = quota[p]
    const e = evaluate(q, cfg.quota.threshold, '')
    return [p, QUOTA_MARK[e.status] ?? e.status, e.reason, q?.source ?? '']
  })
  return [
    `Quota · skip a provider at ${cfg.quota.threshold}% · cached ${cfg.quota.cacheSeconds}s · unknown usage: ${cfg.quota.onUnknown}`,
    '',
    table(['Provider', 'Status', 'Usage', 'Read via'], rows),
  ].join('\n')
}
