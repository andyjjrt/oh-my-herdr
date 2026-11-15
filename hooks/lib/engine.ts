// The engine as `session.start` bound it. `$` itself may only be spelled `$.noun.method(...)` at a
// call site, never stored, so timers, watchers and tool handlers reach the engine through this
// facade, built once per session (and per reload) by `bind($)`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { OmhQuota, OmhRunView, OmhWake, OmhWorker } from '../../types'

// The state atoms. A read or write must name a const of its own file, so register.tsx declares the
// same refs again for drawing; keep the shapes in step.
const RUN = atom({ plugin: 'oh-my-herdr', key: 'run' } as const, null, { shape: 'run-1' })
const WORKERS = atom({ plugin: 'oh-my-herdr', key: 'workers' } as const, {}, { shape: 'workers-1' })
const QUOTA = atom({ plugin: 'oh-my-herdr', key: 'quota' } as const, {}, { shape: 'quota-1' })
const CONTINUE = atom({ plugin: 'oh-my-herdr', key: 'continueCount' } as const, 0)
const WAKE = atom({ plugin: 'oh-my-herdr', key: 'wake' } as const, { sections: [], settleKey: '' }, { shape: 'wake-1' })

/** Every environment variable the mod reads, read once at boot ($.env.get takes literals only). */
export type EnvName =
  | 'HERDR_ENV'
  | 'HERDR_PANE_ID'
  | 'OMH_ROLE'
  | 'OMH_DIR'
  | 'OMH_CONFIG'
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

type E = EngineInterface

type Cell<T> = { get: () => Promise<T>; set: (fn: (old: T) => T) => Promise<T> }

export type Engine = {
  plugin: { root: string; name: string }
  env: { get: (name: EnvName) => Promise<string | undefined> }
  fs: { read: (path: string) => Promise<string>; write: E['fs']['write']; list: E['fs']['list']; exists: E['fs']['exists']; stat: (path: string) => ReturnType<E['fs']['stat']> }
  process: { run: E['process']['run']; spawn: E['process']['spawn'] }
  clock: { now: E['clock']['now']; after: E['clock']['after']; every: E['clock']['every'] }
  http: { fetch: E['http']['fetch'] }
  prompt: { submit: (args: { text: string; asUser?: true }) => Promise<unknown> }
  agent: { spawn: E['agent']['spawn']; list: E['agent']['list'] }
  ui: { log: (text: string) => void; status: E['ui']['status'] }
  session: { append: E['session']['append'] }
  state: {
    run: Cell<OmhRunView | null>
    workers: Cell<Record<string, OmhWorker>>
    quota: Cell<Record<string, OmhQuota>>
    continueCount: Cell<number>
    wake: Cell<OmhWake>
  }
}

export async function readEnv($: EngineInterface): Promise<Partial<Record<EnvName, string>>> {
  const pairs: [EnvName, string | undefined][] = [
    ['HERDR_ENV', await $.env.get('HERDR_ENV')],
    ['HERDR_PANE_ID', await $.env.get('HERDR_PANE_ID')],
    ['OMH_ROLE', await $.env.get('OMH_ROLE')],
    ['OMH_DIR', await $.env.get('OMH_DIR')],
    ['OMH_CONFIG', await $.env.get('OMH_CONFIG')],
    ['HOME', await $.env.get('HOME')],
    ['XDG_CONFIG_HOME', await $.env.get('XDG_CONFIG_HOME')],
    ['XDG_DATA_HOME', await $.env.get('XDG_DATA_HOME')],
    ['XDG_STATE_HOME', await $.env.get('XDG_STATE_HOME')],
    ['CLAUDE_CONFIG_DIR', await $.env.get('CLAUDE_CONFIG_DIR')],
    ['CLAUDE_CODE_OAUTH_TOKEN', await $.env.get('CLAUDE_CODE_OAUTH_TOKEN')],
    ['OPENCODE_GO_API_KEY', await $.env.get('OPENCODE_GO_API_KEY')],
    ['OPENCODE_API_KEY', await $.env.get('OPENCODE_API_KEY')],
    ['SENPI_CODING_AGENT_DIR', await $.env.get('SENPI_CODING_AGENT_DIR')],
    ['PI_CODING_AGENT_DIR', await $.env.get('PI_CODING_AGENT_DIR')],
  ]
  const out: Partial<Record<EnvName, string>> = {}
  for (const [k, v] of pairs) if (v !== undefined && v !== '') out[k] = v
  return out
}

export function bind($: EngineInterface, env: Partial<Record<EnvName, string>>): Engine {
  return {
    plugin: { root: $.plugin.root, name: $.plugin.name },
    env: { get: async name => env[name] },
    fs: {
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      list: path => $.fs.list(path),
      exists: path => $.fs.exists(path),
      stat: path => $.fs.stat(path),
    },
    process: {
      run: (argv, init) => $.process.run(argv, init),
      spawn: request => $.process.spawn(request),
    },
    clock: {
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn),
    },
    http: { fetch: (url, init) => $.http.fetch(url, init) },
    prompt: { submit: args => $.prompt.submit(args) },
    agent: { spawn: args => $.agent.spawn(args), list: () => $.agent.list() },
    ui: {
      log: text => $.ui.log(text, { to: 'debug' }),
      status: text => $.ui.status(text),
    },
    session: { append: args => $.session.append(args) },
    state: {
      run: { get: () => read($, RUN), set: fn => update($, RUN, fn) },
      workers: { get: () => read($, WORKERS), set: fn => update($, WORKERS, fn) },
      quota: { get: () => read($, QUOTA), set: fn => update($, QUOTA, fn) },
      continueCount: { get: () => read($, CONTINUE), set: fn => update($, CONTINUE, fn) },
      wake: { get: () => read($, WAKE), set: fn => update($, WAKE, fn) },
    },
  }
}
