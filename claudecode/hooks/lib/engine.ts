// The Claude Code binding of the host contract in core/host.ts. `$` itself may only be
// spelled `$.noun.method(...)` at a call site, never stored, so timers, watchers and tool handlers
// reach the engine through that facade, built once per session (and per reload) by `bind($)`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Engine, EnvName, Options } from '../../core/host'

// The state atoms. A read or write must name a const of its own file, so register.tsx reads the
// values through the facade; statusbar.tsx declares the RUN ref again for its drawing subscription.
const RUN = atom({ plugin: 'oh-my-herdr', key: 'run' } as const, null, { shape: 'run-1' })
const WORKERS = atom({ plugin: 'oh-my-herdr', key: 'workers' } as const, {}, { shape: 'workers-1' })
const QUOTA = atom({ plugin: 'oh-my-herdr', key: 'quota' } as const, {}, { shape: 'quota-1' })
const CONTINUE = atom({ plugin: 'oh-my-herdr', key: 'continueCount' } as const, 0)
const WAKE = atom({ plugin: 'oh-my-herdr', key: 'wake' } as const, { sections: [], settleKey: '' }, { shape: 'wake-1' })
const BOUND = atom({ plugin: 'oh-my-herdr', key: 'bound' } as const, null, { shape: 'bound-1' })

/** Every environment variable the mod reads, read once at boot ($.env.get takes literals only). */
export type { EnvName } from '../../core/host'

export async function readEnv($: EngineInterface): Promise<Partial<Record<EnvName, string>>> {
  const pairs: [EnvName, string | undefined][] = [
    ['HERDR_ENV', await $.env.get('HERDR_ENV')],
    ['HERDR_PANE_ID', await $.env.get('HERDR_PANE_ID')],
    ['HC_TERMINAL_ID', await $.env.get('HC_TERMINAL_ID')],
    ['PATH', await $.env.get('PATH')],
    ['OMH_ROLE', await $.env.get('OMH_ROLE')],
    ['OMH_DIR', await $.env.get('OMH_DIR')],
    ['OMH_CONFIG', await $.env.get('OMH_CONFIG')],
    ['OMH_RUN', await $.env.get('OMH_RUN')],
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

/** `leadId()`'s exact value: the herdr pane, else `hc:<terminal>`, else null. */
function leadOf(env: Partial<Record<EnvName, string>>): string | null {
  return env.HERDR_PANE_ID ?? (env.HC_TERMINAL_ID !== undefined ? `hc:${env.HC_TERMINAL_ID}` : null)
}

export function bind($: EngineInterface, env: Partial<Record<EnvName, string>>, options: Options): Engine {
  return {
    plugin: { root: $.plugin.root },
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
    prompt: {
      submit: args =>
        $.prompt.submit({
          text: args.text,
          ...(args.asUser === true ? { asUser: true as const } : {}),
        }),
    },
    subagent: {
      spawn: args => $.agent.spawn(args),
      list: () => $.agent.list(),
    },
    ui: {
      log: text => $.ui.log(text, { to: 'debug' }),
    },
    session: {
      append: args => $.session.append(args),
      messages: async () => {
        const messages = await $.session.messages()
        return Array.isArray(messages) ? messages : []
      },
    },
    state: {
      run: { get: () => read($, RUN), set: fn => update($, RUN, fn) },
      workers: { get: () => read($, WORKERS), set: fn => update($, WORKERS, fn) },
      quota: { get: () => read($, QUOTA), set: fn => update($, QUOTA, fn) },
      continueCount: { get: () => read($, CONTINUE), set: fn => update($, CONTINUE, fn) },
      wake: { get: () => read($, WAKE), set: fn => update($, WAKE, fn) },
      bound: { get: () => read($, BOUND), set: fn => update($, BOUND, fn) },
    },
    lead: { pane: leadOf(env), session: null },
    options,
  }
}
