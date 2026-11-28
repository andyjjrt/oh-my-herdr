// A fake opencode Plugin.Context: temp project, in-memory ctx.storage, captured tools/commands,
// synthetic wakes and prompts. The server adapter is exercised without an opencode process.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setConfigHost } from '../../../core/config'
import { optionsOf } from '../../../core/runtime'
import { boot, resetRuntime, type ServerContext } from '../../src/server/index'
import { assetRoot, createEngine } from '../../src/server/engine'
import { installTools, type ToolHost } from '../../src/server/tools'
import { installCommands, type CommandHost } from '../../src/server/commands'

export type Fake = {
  context: ServerContext
  root: string
  storage: Map<string, unknown>
  tools: any[]
  commands: any[]
  synthetic: any[]
  prompts: any[]
  messages: any[]
  close: () => Promise<void>
}

export async function fakeContext(options: Record<string, unknown> = {}): Promise<Fake> {
  const root = await mkdtemp(join(tmpdir(), 'omh-oc-'))
  const storage = new Map<string, unknown>()
  const tools: any[] = []
  const commands: any[] = []
  const synthetic: any[] = []
  const prompts: any[] = []
  const messages: any[] = []
  const context = {
    app: { name: 'test', version: '2.4.2', channel: 'test' },
    location: { directory: root, project: { id: 'test', directory: root, canonical: root } },
    options,
    tool: {
      transform: async (fn: (editor: any) => void | Promise<void>) => {
        await fn({
          add: (definition: any) => tools.push(definition),
          list: () => tools,
          get: (id: string) => tools.find(tool => tool.name === id),
          remove: () => undefined,
          update: () => undefined,
          namespace: () => undefined,
        })
      },
      list: async () => tools,
      hook: async () => undefined,
      reload: async () => undefined,
    },
    command: {
      transform: async (fn: (editor: any) => void | Promise<void>) => {
        await fn({ add: (definition: any) => commands.push(definition) })
      },
      list: async () => ({ data: commands }),
      reload: async () => undefined,
    },
    session: {
      synthetic: async (input: any) => {
        synthetic.push(input)
        return input
      },
      prompt: async (input: any) => {
        prompts.push(input)
        return input
      },
      context: async () => messages,
      hook: async () => undefined,
      create: async () => ({ id: 'ses_child' }),
      get: async () => ({}),
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
      scan: async () => ({ entries: [] }),
    },
    permission: { hook: async () => undefined },
    event: { subscribe: async function* () {} },
    rpc: { register: async () => undefined },
    plugin: { list: async () => [] },
  } as unknown as ServerContext
  return {
    context,
    root,
    storage,
    tools,
    commands,
    synthetic,
    prompts,
    messages,
    close: async () => {
      resetRuntime()
      setConfigHost('claudecode')
      await rm(root, { recursive: true, force: true })
    },
  }
}

export type SetupOptions = {
  options?: Record<string, unknown>
  env?: Record<string, string>
  tools?: boolean
  commands?: boolean
}

// core/runtime.ts is process-wide. Bun may run test files in parallel, so let one test own the
// adapter at a time; fake.close releases the next.
let gate: Promise<void> = Promise.resolve()
let releaseGate: (() => void) | null = null

async function acquire(): Promise<void> {
  const previous = gate
  let release: () => void = () => undefined
  gate = new Promise<void>(resolve => (release = resolve))
  await previous
  releaseGate = release
}

function release(): void {
  const fn = releaseGate
  releaseGate = null
  fn?.()
}

/** Boot the adapter in a temp project, with the tools/commands registered by default. */
export async function setup(options: SetupOptions = {}) {
  await acquire()
  try {
    const fake = await fakeContext(options.options ?? {})
    const opts = optionsOf(options.options ?? {})
    const engine = createEngine(fake.context, opts, assetRoot(), options.env ?? { HERDR_PANE_ID: 'w1:p1' })
    const active = await boot(fake.context, engine, opts)
    if (!active) throw new Error('server booted dormant')
    if (options.tools !== false) await installTools(fake.context as unknown as ToolHost)
    if (options.commands !== false) await installCommands(fake.context as unknown as CommandHost)
    const close = fake.close
    fake.close = async () => {
      try {
        await close()
      } finally {
        release()
      }
    }
    return { fake, engine, opts }
  } catch (err) {
    release()
    throw err
  }
}

export async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The state is process-wide; a test must not leak it into the next one. */
export function resetForTest(): void {
  resetRuntime()
  setConfigHost('claudecode')
}
