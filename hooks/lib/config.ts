// config.json and agents.json: types, normalization (pure) and loading (through `$`).
// Search order: $OMH_CONFIG → <project>/.omh/config.json → ~/.config/oh-my-herdr/config.json →
// the plugin's skills/oh-my-herdr/assets/config.default.json.

import type { Engine } from './engine'

/**
 * A named agent + model. For an agent whose launch is `subagent`, `model` (an alias or id) and
 * `subagentType` (`general-purpose`, `Explore`, a plugin's agent) say what Claude Code starts; `args`
 * is unused there.
 */
export type Profile = { agent: string; family: string; args: string[]; quota?: string | null; model?: string; subagentType?: string }

export type DiagnoseRules = Partial<Record<string, string[]>>

export type AgentSpec = {
  name: string
  launch: 'herdr-kind' | 'command' | 'subagent'
  kind?: string
  command?: string[]
  detect_as?: string
  env?: Record<string, string>
  bin: string
  stall_seconds?: number
  diagnose?: DiagnoseRules
}

export type Category = { profiles: string[]; preamble: string | null }

export type QuotaConfig = {
  enabled: boolean
  threshold: number
  cacheSeconds: number
  onUnknown: 'allow' | 'block'
  /**
   * Per provider: `enabled: false` skips its checks; `command` (a shell line) makes it a provider of
   * the user's own, read by running the command (hooks/lib/quota.ts, parseCommandQuota).
   */
  providers: Record<string, { enabled?: boolean; command?: string }>
}

/** Where pane workers run: herdr panes, or herdr-core (`hc`) terminals; `auto` picks herdr inside herdr. */
export type BackendSetting = 'auto' | 'herdr' | 'hc'

export type HcConfig = {
  /** Let hc type notes about a worker into the lead (off: the mod's own wake-ups say it). */
  notify: boolean
  /**
   * Inside the Herdr app: `tab` puts workers in omh tabs of the lead's space (by herdr.space /
   * herdr.tab labels); `none` leaves them as sub-agents, in the agents list without a pane.
   */
  panes: 'tab' | 'none'
}

export type Config = {
  file: string
  dir: string
  backend: BackendSetting
  hc: HcConfig
  lead: string | null
  maxConcurrent: number
  /** Panes in one omh-workers tab before the next tab opens. */
  maxPanesPerTab: number
  quota: QuotaConfig
  profiles: Record<string, Profile>
  categories: Record<string, Category>
  agents: Record<string, AgentSpec>
}

type Json = Record<string, unknown>

const asRecord = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [])

export function normalizeCategory(raw: unknown): Category {
  if (typeof raw === 'string' || Array.isArray(raw)) return { profiles: asStrings(raw), preamble: null }
  const r = asRecord(raw)
  return { profiles: asStrings(r.profiles), preamble: typeof r.preamble === 'string' ? r.preamble : null }
}

export function normalizeAgent(name: string, raw: unknown): AgentSpec {
  const r = asRecord(raw)
  const launch = r.launch === 'command' ? 'command' : r.launch === 'subagent' ? 'subagent' : 'herdr-kind'
  const command = asStrings(r.command)
  const kind = typeof r.kind === 'string' ? r.kind : undefined
  return {
    name,
    launch,
    ...(kind !== undefined && { kind }),
    ...(command.length > 0 && { command }),
    ...(typeof r.detect_as === 'string' && { detect_as: r.detect_as }),
    ...(r.env !== undefined && { env: asRecord(r.env) as Record<string, string> }),
    bin: typeof r.bin === 'string' ? r.bin : (command[0] ?? kind ?? name),
    ...(typeof r.stall_seconds === 'number' && { stall_seconds: r.stall_seconds }),
    ...(r.diagnose !== undefined && { diagnose: asRecord(r.diagnose) as DiagnoseRules }),
  }
}

/** `"name": "<command>"` is short for `{ "command": "<command>" }`. */
function normalizeProviders(raw: unknown): QuotaConfig['providers'] {
  const out: QuotaConfig['providers'] = {}
  for (const [name, v] of Object.entries(asRecord(raw))) {
    if (typeof v === 'string') {
      if (v.trim()) out[name] = { command: v.trim() }
      continue
    }
    const r = asRecord(v)
    out[name] = {
      ...(typeof r.enabled === 'boolean' && { enabled: r.enabled }),
      ...(typeof r.command === 'string' && r.command.trim() !== '' && { command: r.command.trim() }),
    }
  }
  return out
}

export function normalizeConfig(file: string, raw: unknown, builtinAgents: unknown): Config {
  const r = asRecord(raw)
  const q = asRecord(r.quota)
  const h = asRecord(r.hc)
  const profiles: Record<string, Profile> = {}
  for (const [name, p] of Object.entries(asRecord(r.profiles))) {
    const pr = asRecord(p)
    const agent = typeof pr.agent === 'string' ? pr.agent : typeof pr.kind === 'string' ? pr.kind : ''
    profiles[name] = {
      agent,
      family: typeof pr.family === 'string' ? pr.family : 'unknown',
      args: asStrings(pr.args),
      ...('quota' in pr && { quota: typeof pr.quota === 'string' ? pr.quota : null }),
      ...(typeof pr.model === 'string' && { model: pr.model }),
      ...(typeof pr.subagent_type === 'string' && { subagentType: pr.subagent_type }),
    }
  }
  const categories: Record<string, Category> = {}
  for (const [name, c] of Object.entries(asRecord(r.categories))) categories[name] = normalizeCategory(c)
  const agents: Record<string, AgentSpec> = {}
  for (const [name, a] of Object.entries(asRecord(builtinAgents))) if (!name.startsWith('_')) agents[name] = normalizeAgent(name, a)
  for (const [name, a] of Object.entries(asRecord(r.agents))) {
    agents[name] = normalizeAgent(name, { ...asRecord(builtinAgents)[name] as Json, ...asRecord(a) })
  }
  // A subagent profile always names its type, so `subagentType` alone marks one (providerOf reads it).
  for (const p of Object.values(profiles)) if (agents[p.agent]?.launch === 'subagent' && p.subagentType === undefined) p.subagentType = 'general-purpose'
  return {
    file,
    dir: file.slice(0, file.lastIndexOf('/')),
    backend: r.backend === 'herdr' || r.backend === 'hc' ? r.backend : 'auto',
    hc: { notify: h.notify === true, panes: h.panes === 'none' ? 'none' : 'tab' },
    lead: typeof r.lead === 'string' ? r.lead : null,
    maxConcurrent: typeof r.max_concurrent === 'number' ? r.max_concurrent : 0,
    maxPanesPerTab: typeof r.max_panes_per_tab === 'number' && r.max_panes_per_tab >= 1 ? Math.floor(r.max_panes_per_tab) : 4,
    quota: {
      enabled: q.enabled !== false,
      threshold: typeof q.threshold === 'number' ? q.threshold : 95,
      cacheSeconds: typeof q.cache_seconds === 'number' ? q.cache_seconds : 120,
      onUnknown: q.on_unknown === 'block' ? 'block' : 'allow',
      providers: normalizeProviders(q.providers),
    },
    profiles,
    categories,
    agents,
  }
}

/** A subagent the config routes some category to: its type and model (undefined: the lead's). */
export type SubagentKind = { type: string; model: string | undefined }

/** Every subagent kind the categories route to, in config order, each once. Pure. */
export function routedSubagents(cfg: Config): SubagentKind[] {
  const out: SubagentKind[] = []
  for (const c of Object.values(cfg.categories)) {
    for (const name of c.profiles) {
      if (!isSubagentProfile(cfg, name)) continue
      const p = cfg.profiles[name]!
      const k = { type: p.subagentType ?? 'general-purpose', model: p.model }
      if (!out.some(o => o.type === k.type && o.model === k.model)) out.push(k)
    }
  }
  return out
}

export const kindText = (k: SubagentKind): string => `${k.type} · ${k.model ?? "the lead's model"}`

/**
 * The lead's own Agent tool call, held to the subagents the config routes to. Pure. With none, the
 * user chose external agents only: refused, with scouts named instead. A type the config does not
 * route to is refused; a model it does not list for that type becomes its first listed one.
 */
export function agentCallRule(cfg: Config, input: { subagent_type?: unknown; model?: unknown }): { deny: string } | { model: string | undefined } | null {
  const kinds = routedSubagents(cfg)
  if (kinds.length === 0) {
    return {
      deny: `oh-my-herdr: the config (${cfg.file}) routes no category to a subagent, only to external agents, so the lead starts no subagents. Explore with omh_dispatch scouts instead (task id \`scout-<name>\`, intent explore or research), or read it yourself. To allow subagents, add a subagent profile to a category.`,
    }
  }
  const type = typeof input.subagent_type === 'string' && input.subagent_type !== '' ? input.subagent_type : 'general-purpose'
  const models = kinds.filter(k => k.type === type).map(k => k.model)
  if (models.length === 0) {
    return { deny: `oh-my-herdr: subagent_type '${type}' is not one the config (${cfg.file}) routes to. Allowed: ${kinds.map(kindText).join('; ')}. Use one of those, or an omh_dispatch scout.` }
  }
  const asked = typeof input.model === 'string' && input.model !== '' ? input.model : undefined
  if (models.includes(asked)) return null
  return { model: models[0] }
}

/** Whether a profile runs as a Claude Code subagent of the lead rather than in a herdr pane. */
export function isSubagentProfile(cfg: Config, profile: string): boolean {
  const p = cfg.profiles[profile]
  return p !== undefined && cfg.agents[p.agent]?.launch === 'subagent'
}

/** Problems that make a config unusable or a category misroute; empty when fine. */
export function configProblems(cfg: Config): string[] {
  const out: string[] = []
  for (const [name, p] of Object.entries(cfg.profiles)) {
    if (!p.agent) out.push(`profile '${name}' has no "agent"`)
    else if (!cfg.agents[p.agent]) out.push(`profile '${name}' uses unknown agent '${p.agent}'`)
  }
  for (const [name, c] of Object.entries(cfg.categories)) {
    if (c.profiles.length === 0) out.push(`category '${name}' lists no profiles`)
    for (const p of c.profiles) if (!cfg.profiles[p]) out.push(`category '${name}' lists undefined profile '${p}'`)
  }
  if (cfg.lead !== null && !cfg.profiles[cfg.lead]) out.push(`lead profile '${cfg.lead}' is not defined`)
  const known = new Set(['claude', 'opencode-go', ...Object.keys(cfg.quota.providers).filter(n => cfg.quota.providers[n]!.command !== undefined)])
  for (const [name, p] of Object.entries(cfg.profiles)) {
    if (typeof p.quota === 'string' && !known.has(p.quota)) out.push(`profile '${name}' bills quota '${p.quota}', which is neither built in nor given a "command" under quota.providers`)
  }
  return out
}

export async function configCandidates($: Engine, omhDir: string): Promise<string[]> {
  const home = (await $.env.get('HOME')) ?? ''
  const xdg = (await $.env.get('XDG_CONFIG_HOME')) ?? `${home}/.config`
  const explicit = await $.env.get('OMH_CONFIG')
  return [
    ...(explicit ? [explicit] : []),
    `${omhDir}/config.json`,
    `${xdg}/oh-my-herdr/config.json`,
    `${$.plugin.root}/skills/oh-my-herdr/assets/config.default.json`,
  ]
}

export async function loadConfig($: Engine, omhDir: string): Promise<Config> {
  const builtin = JSON.parse(await $.fs.read(`${$.plugin.root}/skills/oh-my-herdr/assets/agents.json`)) as unknown
  for (const file of await configCandidates($, omhDir)) {
    if (!(await $.fs.exists(file))) continue
    let raw: unknown
    try {
      raw = JSON.parse(await $.fs.read(file))
    } catch (err) {
      throw new Error(`invalid JSON in ${file}: ${(err as Error).message}`)
    }
    return normalizeConfig(file, raw, builtin)
  }
  throw new Error('no config.json found')
}
