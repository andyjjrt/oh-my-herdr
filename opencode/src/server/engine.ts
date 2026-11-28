// The opencode V2 binding of the host contract in core/host.ts. one plugin process serves every
// session in a project, so the Engine is process-wide; the lead session is chosen by /ulw or a
// tool call (lead.ts) and the state cells persist through ctx.storage.

import { createHash, randomUUID } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile, readdir, access, lstat, realpath, mkdir, stat as fsStat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { setConfigHost } from '../../../core/config'
import type { Cell, Engine, EnvName, FsEntry, FsStat, HttpInit, HttpResponse, Options, ProcessRunInit, ProcessRunResult, ProcessSpawnChunk, ProcessSpawnRequest, SessionMessage, Timer } from '../../../core/host'
import type { OmhBoundRun, OmhQuota, OmhRunView, OmhWake, OmhWorker } from '../../../core/types'
import { wakeNow } from './wake'

/** The part of an opencode Plugin.Context this adapter uses; tests can fake it. */
export type EngineContext = {
  storage: {
    get: (key: string) => Promise<any>
    set: (key: string, value: any) => Promise<void>
  }
  session: {
    synthetic: (input: any) => Promise<unknown>
    context: (input: any) => Promise<ReadonlyArray<any>>
  }
}

export const ENV_NAMES: readonly EnvName[] = [
  'HERDR_ENV',
  'HERDR_PANE_ID',
  'HC_TERMINAL_ID',
  'PATH',
  'OMH_ROLE',
  'OMH_DIR',
  'OMH_CONFIG',
  'OMH_RUN',
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENCODE_GO_API_KEY',
  'OPENCODE_API_KEY',
  'SENPI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_DIR',
]

/** Snapshot every variable core may read. opencode's server may outlive the pane it was started from. */
export function readProcessEnv(): Partial<Record<EnvName, string>> {
  const out: Partial<Record<EnvName, string>> = {}
  for (const name of ENV_NAMES) {
    const value = process.env[name]
    if (value !== undefined && value !== '') out[name] = value
  }
  return out
}

/**
 * The repository (or, once packaged, the package root) that has `skills/oh-my-herdr/assets`.
 * In this tree the package is `opencode/`, one level below the repo root.
 */
export function assetRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [resolve(here, '../../..'), resolve(here, '../..')]) {
    if (existsSync(join(candidate, 'skills/oh-my-herdr/assets/agents.json'))) return candidate
  }
  return resolve(here, '../..')
}

let storageTail: Promise<void> = Promise.resolve()

function serialStorage<R>(fn: () => Promise<R>): Promise<R> {
  const run = storageTail.then(fn, fn)
  storageTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function stored<T>(context: EngineContext, key: string, initial: T): Cell<T> {
  // opencode's kv table does not accept a bare null value, and concurrent writes can collide on
  // the same SQLite connection. Keep every cell in an envelope and serialise storage operations.
  const envelope = '__ohmyherdr'
  const readRaw = async (): Promise<T> => {
    const raw = await context.storage.get(key)
    if (raw === undefined) return structuredClone(initial)
    const wrapped = raw !== null && typeof raw === 'object' && (raw as Record<string, unknown>)[envelope] === true
    return (wrapped ? (raw as Record<string, unknown>).value : raw) as T
  }
  return {
    get: () => serialStorage(readRaw),
    set: (fn: (old: T) => T) =>
      serialStorage(async () => {
        const next = fn(await readRaw())
        // ctx.storage is a JSON store: Effect rejects undefined inside a value, while core's view
        // types use optional fields. Round-trip through JSON to drop them (and to clone).
        const json = next === undefined ? null : JSON.parse(JSON.stringify(next))
        await context.storage.set(key, { [envelope]: true, value: json })
        return next
      }),
  }
}

function kindOf(st: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): 'file' | 'dir' | 'other' {
  return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other'
}

function timerOf(handle: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): Timer {
  // Timers must not keep an idle opencode server alive.
  ;(handle as { unref?: () => void }).unref?.()
  return {
    cancel: () => {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
      clearInterval(handle as ReturnType<typeof setInterval>)
    },
  }
}

function runProcess(argv: readonly string[], init: ProcessRunInit = {}): Promise<ProcessRunResult> {
  return new Promise(resolve => {
    if (argv.length === 0) {
      resolve({ exitCode: 126, stdout: '', stderr: 'no command' })
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    let deadline: ReturnType<typeof setTimeout> | null = null
    const finish = (exitCode: number) => {
      if (done) return
      done = true
      if (deadline !== null) clearTimeout(deadline)
      resolve({ exitCode, stdout, stderr })
    }
    let child: ReturnType<typeof nodeSpawn>
    try {
      child = nodeSpawn(argv[0]!, argv.slice(1), {
        cwd: init.cwd,
        env: { ...process.env, ...init.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ exitCode: 127, stdout: '', stderr: (err as Error).message })
      return
    }
    child.stdout!.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr!.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', err => {
      stderr += err.message
      finish(127)
    })
    child.on('close', code => finish(code ?? 0))
    if (init.stdin !== undefined) child.stdin!.end(init.stdin)
    else child.stdin!.end()
    if (init.timeoutMs !== undefined && init.timeoutMs > 0) {
      deadline = setTimeout(() => {
        stderr += `\ntimed out after ${init.timeoutMs}ms`
        child.kill('SIGKILL')
        finish(124)
      }, init.timeoutMs)
      deadline.unref?.()
    }
  })
}

function spawnProcess(request: ProcessSpawnRequest): AsyncIterable<ProcessSpawnChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      if (request.argv.length === 0) return
      const queue: ProcessSpawnChunk[] = []
      let done = false
      let notify: (() => void) | null = null
      const wake = () => {
        const fn = notify
        notify = null
        fn?.()
      }
      const child = nodeSpawn(request.argv[0]!, request.argv.slice(1), {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      child.stdout!.on('data', chunk => {
        queue.push({ stream: 'stdout', text: String(chunk) })
        wake()
      })
      child.stderr!.on('data', chunk => {
        queue.push({ stream: 'stderr', text: String(chunk) })
        wake()
      })
      child.on('error', err => {
        queue.push({ stream: 'stderr', text: err.message })
        done = true
        wake()
      })
      child.on('close', () => {
        done = true
        wake()
      })
      if (request.input !== undefined) child.stdin!.end(request.input)
      else child.stdin!.end()
      try {
        while (!done || queue.length > 0) {
          if (queue.length === 0) await new Promise<void>(resolve => (notify = resolve))
          const chunk = queue.shift()
          if (chunk !== undefined) yield chunk
        }
      } finally {
        if (!child.killed) child.kill('SIGTERM')
      }
    },
  }
}

function messageOf(raw: any): SessionMessage {
  const content: any[] = Array.isArray(raw?.content) ? raw.content : []
  const toolUses = content
    .filter(part => part && typeof part === 'object' && typeof part.type === 'string' && /tool/i.test(part.type))
    .map(part => ({ tool: String(part.tool ?? part.name ?? part.toolName ?? 'tool') }))
  const toolResults = content.filter(part => part && typeof part === 'object' && /tool.*result|result.*tool/i.test(String(part.type)))
  return {
    role: raw?.type === 'assistant' || raw?.role === 'assistant' ? 'assistant' : 'user',
    toolUses,
    ...(toolResults.length > 0 && { toolResults }),
  }
}

/** Each project's cells live under its own kv prefix: opencode storage is shared by every project. */
export function stateCells(context: EngineContext, scope: string): Engine['state'] {
  const project = createHash('sha256').update(scope).digest('hex').slice(0, 16)
  const key = (name: string) => `oh-my-herdr:${project}:state:${name}`
  return {
    run: stored<OmhRunView | null>(context, key('run'), null),
    workers: stored<Record<string, OmhWorker>>(context, key('workers'), {}),
    quota: stored<Record<string, OmhQuota>>(context, key('quota'), {}),
    continueCount: stored<number>(context, key('continueCount'), 0),
    wake: stored<OmhWake>(context, key('wake'), { sections: [], settleKey: '' }),
    bound: stored<OmhBoundRun | { run: null } | null>(context, key('bound'), null),
  }
}
/** Build the host contract. `pluginRoot` is where core finds skills/oh-my-herdr/assets. */
export function createEngine(
  context: EngineContext,
  options: Options,
  pluginRoot = assetRoot(),
  env: Partial<Record<EnvName, string>> = readProcessEnv(),
): Engine {
  setConfigHost('opencode')
  const lead = {
    pane: env.HERDR_PANE_ID ?? (env.HC_TERMINAL_ID !== undefined ? `hc:${env.HC_TERMINAL_ID}` : null),
    session: null as string | null,
  }
  return {
    plugin: { root: pluginRoot },
    env: { get: async name => env[name] },
    fs: {
      read: path => readFile(path, 'utf8'),
      write: async (path, text) => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, text, 'utf8')
      },
      list: async path => {
        const entries = await readdir(path, { withFileTypes: true })
        const out: FsEntry[] = []
        for (const entry of entries) {
          const full = join(path, entry.name)
          try {
            const st = await lstat(full)
            out.push({ name: entry.name, kind: kindOf(st), size: st.size, mtimeMs: st.mtimeMs, isLink: st.isSymbolicLink() })
          } catch {
            out.push({ name: entry.name, kind: 'other', size: 0, mtimeMs: 0, isLink: false })
          }
        }
        return out
      },
      exists: async path => {
        try {
          await access(path)
          return true
        } catch {
          return false
        }
      },
      stat: async path => {
        const link = await lstat(path)
        const target = link.isSymbolicLink() ? await fsStat(path) : link
        const out: FsStat = { kind: kindOf(target), size: target.size, mtimeMs: target.mtimeMs, isLink: link.isSymbolicLink() }
        if (out.isLink) out.realPath = await realpath(path).catch(() => undefined)
        return out
      },
    },
    process: {
      run: runProcess,
      spawn: spawnProcess,
    },
    clock: {
      now: async () => Date.now(),
      after: (ms, fn) => timerOf(setTimeout(fn, ms)),
      every: (ms, fn) => timerOf(setInterval(fn, ms)),
    },
    http: {
      fetch: async (url: string, init?: HttpInit): Promise<HttpResponse> => {
        const res = await fetch(url, {
          ...(init?.method !== undefined && { method: init.method }),
          ...(init?.headers !== undefined && { headers: init.headers }),
          ...(init?.body !== undefined && { body: init.body }),
        })
        return { status: res.status, ok: res.ok, text: await res.text() }
      },
    },
    prompt: {
      submit: async args => {
        const session = args.session ?? lead.session
        if (session === null) throw new Error('oh-my-herdr: no lead session to wake')
        return wakeNow(context, session, args.text)
      },
    },
    ui: { log: text => console.error(`[oh-my-herdr] ${text}`) },
    session: {
      append: async args => {
        const session = lead.session
        if (session === null) throw new Error('oh-my-herdr: no lead session to append to')
        const text = args.message.content.map(part => part.text).join('\n')
        return context.session.synthetic({
          sessionID: session,
          text,
          delivery: 'queue',
          id: `msg_omh_append_${randomUUID()}`,
          description: 'oh-my-herdr append',
          metadata: { source: 'oh-my-herdr' },
          // A board append is context, not a request for a new turn.
          resume: false,
        })
      },
      messages: async () => {
        if (lead.session === null) return []
        const messages = await context.session.context({ sessionID: lead.session })
        return messages.map(messageOf)
      },
    },
    state: stateCells(context, `unscoped:${randomUUID()}`),
    lead,
    options,
  }
}
