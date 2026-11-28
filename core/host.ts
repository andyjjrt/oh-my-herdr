// The host contract the orchestration core is written against. Types only: this file must stay free
// of any Claude Code import (and of runtime code) so a second host can implement the same shapes.
//
// The Claude Code binding is claudecode/hooks/lib/engine.ts. A host supplies its own binding, then
// installs it as `rt.$`; core/runtime.ts and the rest of core use only these members.

import type { OmhBoundRun, OmhQuota, OmhRunView, OmhWake, OmhWorker } from './types'

/** Where the run's progress shows (`display`). */
export type Display = 'statusline' | 'panel' | 'off'

/** Where new pane workers start (`backend`); a config.json value overrides it. */
export type BackendSetting = 'auto' | 'herdr' | 'hc'

/** The plugin options, after normalization (`optionsOf` in runtime.ts). */
export type Options = {
  display: Display
  backend: BackendSetting
  wakeOnSettle: boolean
  notifyHuman: boolean
  autoContinue: boolean
  autoContinueMax: number
  verbose: boolean
}

/** Every environment variable the core reads, snapshotted once at boot. */
export type EnvName =
  | 'HERDR_ENV'
  | 'HERDR_PANE_ID'
  | 'HC_TERMINAL_ID'
  | 'PATH'
  | 'OMH_ROLE'
  | 'OMH_DIR'
  | 'OMH_CONFIG'
  | 'OMH_RUN'
  | 'HOME'
  | 'XDG_CONFIG_HOME'
  | 'XDG_DATA_HOME'
  | 'XDG_STATE_HOME'
  | 'CLAUDE_CONFIG_DIR'
  | 'CLAUDE_CODE_OAUTH_TOKEN'
  | 'OPENCODE_GO_API_KEY'
  | 'OPENCODE_API_KEY'
  | 'SENPI_CODING_AGENT_DIR'
  | 'PI_CODING_AGENT_DIR'

/** A value kept by the host across hook dispatches (and, for atoms, hot reloads). */
export type Cell<T> = { get: () => Promise<T>; set: (fn: (old: T) => T) => Promise<T> }

export type FsEntry = {
  name: string
  kind: 'file' | 'dir' | 'other'
  size: number
  mtimeMs: number
  isLink: boolean
}

export type FsStat = {
  kind: 'file' | 'dir' | 'other'
  size: number
  mtimeMs: number
  isLink: boolean
  realPath?: string
}

export type ProcessRunInit = {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}

export type ProcessRunResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type ProcessSpawnRequest = {
  argv: readonly string[]
  cwd?: string
  env?: Record<string, string>
  input?: string
}

export type ProcessSpawnChunk = {
  stream: 'stdout' | 'stderr'
  text: string
}

export type HttpInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export type HttpResponse = {
  status: number
  ok: boolean
  text: string
}

/** A pending timer from `clock.after` / `clock.every`. */
export type Timer = { cancel: () => void }

/** The subagent status vocabulary the core's state machine understands. */
export type SubagentStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

export type SubagentSpawnArgs = {
  prompt: string
  description?: string
  subagentType?: string
  model?: string
  cwd?: string
}

export type SubagentSpawnResult = {
  agentId?: string
  model?: string
  deny?: string
}

export type SubagentInfo = { id: string; status: SubagentStatus }

/** The lead's own subagents, when the host has them at all. */
export type SubagentCapability = {
  spawn: (args: SubagentSpawnArgs) => Promise<SubagentSpawnResult>
  list: () => Promise<SubagentInfo[]>
}

export type SessionAppendArgs = {
  message: {
    type: 'user'
    content: Array<{ type: 'text'; text: string }>
  }
}

export type SessionMessage = {
  role: 'user' | 'assistant'
  toolUses: Array<{ tool: string }>
  toolResults?: unknown[]
}

/**
 * What the core may ask of its host. Every member is a plain promise/in-out shape; no member
 * references the Claude Code `EngineInterface`.
 */
export type Engine = {
  plugin: { root: string }
  env: { get: (name: EnvName) => Promise<string | undefined> }
  fs: {
    read: (path: string) => Promise<string>
    write: (path: string, text: string) => Promise<void>
    list: (path: string) => Promise<FsEntry[]>
    exists: (path: string) => Promise<boolean>
    stat: (path: string) => Promise<FsStat>
  }
  process: {
    run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
    spawn: (request: ProcessSpawnRequest) => AsyncIterable<ProcessSpawnChunk>
  }
  clock: {
    now: () => Promise<number>
    after: (ms: number, fn: () => void) => Timer
    every: (ms: number, fn: () => void) => Timer
  }
  http: { fetch: (url: string, init?: HttpInit) => Promise<HttpResponse> }
  /** Submit into the lead's session. `session` is a target for hosts that can address several. */
  prompt: { submit: (args: { text: string; asUser?: true; session?: string }) => Promise<unknown> }
  /** Optional: when absent, a subagent profile is refused by the dispatch path. */
  subagent?: SubagentCapability
  ui: { log: (text: string) => void }
  session: {
    append: (args: SessionAppendArgs) => Promise<unknown>
    messages: () => Promise<SessionMessage[]>
  }
  state: {
    run: Cell<OmhRunView | null>
    workers: Cell<Record<string, OmhWorker>>
    quota: Cell<Record<string, OmhQuota>>
    continueCount: Cell<number>
    wake: Cell<OmhWake>
    /** The run this session follows. `{ run: null }` is an explicit unbind. */
    bound: Cell<OmhBoundRun | { run: null } | null>
  }
  /** This session's identity: the pane address (or `hc:<terminal>`) and, when it has one, its host session. */
  lead: { pane: string | null; session: string | null }
  options: Options
}
