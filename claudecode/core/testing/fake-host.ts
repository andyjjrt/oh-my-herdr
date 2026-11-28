// GENERATED FILE - do not edit; source: /core/testing/fake-host.ts
// Regenerate with: bun scripts/sync.ts
// Claude Code needs real files in the plugin; this header also keeps the generated copy
// distinct from the source in Git rename detection, so the source keeps its history.
// A complete, host-neutral Engine for tests. In-memory disk, in-memory state, and a process table
// the test supplies. It imports only the core contract and domain types (never Claude Code), so
// both the core suite and the Claude Code suite can use it.

import type {
  Cell,
  Engine,
  EnvName,
  FsEntry,
  FsStat,
  HttpInit,
  HttpResponse,
  Options,
  ProcessRunInit,
  ProcessRunResult,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  SessionAppendArgs,
  SessionMessage,
  SubagentCapability,
  Timer,
} from '../host'
import type { OmhBoundRun, OmhQuota, OmhRunView, OmhWake, OmhWorker } from '../types'

export type FakeProcess = (
  argv: readonly string[],
  init?: ProcessRunInit,
) => ProcessRunResult | undefined | Promise<ProcessRunResult | undefined>

export type FakeHostOptions = {
  /** The plugin root; default `/plug`. */
  root?: string
  /** The in-memory disk, absolute paths. */
  files?: Iterable<readonly [string, string]>
  /** The plugin's two JSON assets, served under `<root>/skills/oh-my-herdr/assets/`. */
  assets?: { agents?: unknown; config?: unknown }
  env?: Partial<Record<EnvName, string>>
  lead?: { pane: string | null; session: string | null }
  options?: Partial<Options>
  /** Fixed clock, or a function read at each `now()`. */
  now?: number | (() => number)
  /** Answer a process; `undefined` falls through to the built-in rm/mv/sh-cat table. */
  process?: FakeProcess
  http?: (url: string, init?: HttpInit) => Promise<HttpResponse>
  prompt?: (args: { text: string; asUser?: true; session?: string }) => Promise<unknown>
  /** Present or absent, per test. Omit to model a host with no subagent capability. */
  subagent?: SubagentCapability | false
  messages?: SessionMessage[]
  state?: {
    run?: OmhRunView | null
    workers?: Record<string, OmhWorker>
    quota?: Record<string, OmhQuota>
    continueCount?: number
    wake?: OmhWake
    bound?: OmhBoundRun | { run: null } | null
  }
  log?: (text: string) => void
}

export type FakeHost = Engine & {
  files: Map<string, string>
  calls: string[][]
  spawns: ProcessSpawnRequest[]
  prompts: Array<{ text: string; asUser?: true; session?: string }>
  logs: string[]
  appends: SessionAppendArgs[]
  timers: { after: number[]; every: number[] }
}

const ASSET = /\/skills\/oh-my-herdr\/assets\/(agents|config\.default)\.json$/

export function fakeCell<T>(initial: T): Cell<T> {
  let value = initial
  return {
    get: async () => value,
    set: async fn => (value = fn(value)),
  }
}

function entriesUnder(files: Map<string, string>, path: string): FsEntry[] {
  const dir = `${path.replace(/\/$/, '')}/`
  const names = new Set(
    [...files.keys()].filter(k => k.startsWith(dir)).map(k => k.slice(dir.length).split('/')[0]!),
  )
  return [...names].map(name => {
    const full = dir + name
    const isFile = files.has(full)
    return {
      name,
      kind: isFile ? 'file' : 'dir',
      size: isFile ? files.get(full)!.length : 0,
      mtimeMs: 0,
      isLink: false,
    }
  })
}

export function fakeHost(options: FakeHostOptions = {}): FakeHost {
  const root = options.root ?? '/plug'
  const files = options.files instanceof Map ? options.files : new Map(options.files ?? [])
  const env = options.env ?? {}
  const calls: string[][] = []
  const spawns: ProcessSpawnRequest[] = []
  const prompts: FakeHost['prompts'] = []
  const logs: string[] = []
  const appends: SessionAppendArgs[] = []
  const timers: FakeHost['timers'] = { after: [], every: [] }
  const now = options.now ?? Date.UTC(2026, 10, 21)

  const asset = (path: string): string | undefined => {
    const name = ASSET.exec(path)?.[1]
    if (name === undefined || options.assets === undefined) return undefined
    const value = name === 'agents' ? options.assets.agents : options.assets.config
    return value === undefined ? undefined : JSON.stringify(value)
  }
  const dirOf = (path: string) => [...files.keys()].some(k => k.startsWith(`${path.replace(/\/$/, '')}/`))
  const exists = (path: string) => asset(path) !== undefined || files.has(path) || dirOf(path)

  const read = async (path: string): Promise<string> => {
    const text = asset(path) ?? files.get(path)
    if (text === undefined) throw new Error(`ENOENT ${path}`)
    return text
  }

  const statOf = (path: string): FsStat => {
    const text = asset(path) ?? files.get(path)
    if (text !== undefined) return { kind: 'file', size: text.length, mtimeMs: 0, isLink: false }
    if (dirOf(path)) return { kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
    throw new Error(`ENOENT ${path}`)
  }

  const run = async (argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> => {
    calls.push([...argv])
    const custom = await options.process?.(argv, init)
    if (custom !== undefined) return custom
    const ok = (stdout = ''): ProcessRunResult => ({ exitCode: 0, stdout, stderr: '' })
    const no: ProcessRunResult = { exitCode: 1, stdout: '', stderr: '' }
    if (argv[0] === 'rm') {
      files.delete(argv[argv.length - 1]!)
      return ok()
    }
    if (argv[0] === 'mv') {
      const from = argv[1]!
      if (!files.has(from)) return no
      files.set(argv[2]!, files.get(from)!)
      files.delete(from)
      return ok()
    }
    if (argv[0] === 'sh' && String(argv[2] ?? '').includes('cat >>')) {
      const path = argv[5]!
      files.set(path, (files.get(path) ?? '') + String(init?.stdin ?? ''))
      return ok()
    }
    return no
  }

  const base: Engine = {
    plugin: { root },
    env: {
      get: async (name: EnvName) => env[name],
    },
    fs: {
      read,
      write: async (path, text) => void files.set(path, text),
      list: async path => entriesUnder(files, path),
      exists: async path => exists(path),
      stat: async path => statOf(path),
    },
    process: {
      run,
      spawn: (request): AsyncIterable<ProcessSpawnChunk> => {
        spawns.push(request)
        return (async function* () {})()
      },
    },
    clock: {
      now: async () => (typeof now === 'function' ? now() : now),
      after: (ms, _fn): Timer => (timers.after.push(ms), { cancel() {} }),
      every: (ms, _fn): Timer => (timers.every.push(ms), { cancel() {} }),
    },
    http: {
      fetch: options.http ?? (async (url: string) => {
        throw new Error(`offline: ${url}`)
      }),
    },
    prompt: {
      submit: async args => {
        prompts.push(args)
        return options.prompt ? options.prompt(args) : {}
      },
    },
    ui: {
      log: text => {
        logs.push(text)
        options.log?.(text)
      },
    },
    session: {
      append: async args => {
        appends.push(args)
        return undefined
      },
      messages: async () => options.messages ?? [],
    },
    state: {
      run: fakeCell(options.state?.run ?? null),
      workers: fakeCell(options.state?.workers ?? {}),
      quota: fakeCell(options.state?.quota ?? {}),
      continueCount: fakeCell(options.state?.continueCount ?? 0),
      wake: fakeCell(options.state?.wake ?? { sections: [], settleKey: '' }),
      bound: fakeCell(options.state?.bound ?? null),
    },
    lead: options.lead ?? { pane: null, session: null },
    options: {
      display: options.options?.display ?? 'off',
      backend: options.options?.backend ?? 'auto',
      wakeOnSettle: options.options?.wakeOnSettle ?? true,
      notifyHuman: options.options?.notifyHuman ?? false,
      autoContinue: options.options?.autoContinue ?? false,
      autoContinueMax: options.options?.autoContinueMax ?? 3,
      verbose: options.options?.verbose ?? false,
    },
  }

  const withSubagent: Pick<Engine, 'subagent'> =
    options.subagent === undefined || options.subagent === false ? {} : { subagent: options.subagent }

  return { ...base, ...withSubagent, files, calls, spawns, prompts, logs, appends, timers }
}
