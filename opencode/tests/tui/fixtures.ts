// Sample snapshots for the TUI tests, and a fake RPC transport: what the TUI's client.rpc(OmhRpc)
// would reach, minus the wire. Inputs and outputs are JSON round-tripped like the real channel.

import type { OmhRpc, Snapshot } from '../../src/rpc/protocol'
import type { OmhQuota, OmhRunView, OmhWorker } from '../../../core/types'

type Handler = (input: any) => Promise<any>

export function fakeTransport() {
  const registered = new Map<string, Record<string, Handler>>()
  const calls: Array<{ id: string; method: string; input: unknown }> = []
  const wire = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
  return {
    calls,
    /** The server context's ctx.rpc. */
    server: {
      register: async (definition: typeof OmhRpc, handlers: Record<string, Handler>) => {
        registered.set(definition.id, handlers)
        return { dispose: async () => void registered.delete(definition.id) }
      },
    },
    /** The TUI context's client. */
    client: {
      rpc: (definition: typeof OmhRpc) =>
        new Proxy(
          {},
          {
            get: (_, method: string) => async (input: unknown) => {
              const handlers = registered.get(definition.id)
              if (handlers === undefined) throw new Error('rpc.unavailable')
              if (!(method in definition.methods) || handlers[method] === undefined) throw new Error('rpc.method_not_found')
              calls.push({ id: definition.id, method, input: wire(input) })
              return wire(await handlers[method]!(wire(input ?? {})))
            },
          },
        ),
    },
  }
}

export function worker(name: string, phase: OmhWorker['phase'], task: string | null = null): OmhWorker {
  return {
    name,
    pane: 'w1:p2',
    profile: 'claude-sonnet',
    family: 'anthropic',
    agent: 'claude',
    phase,
    task,
    run: '20261127-demo',
    dispatchedAt: 1,
    sawWorking: phase !== 'dispatched',
    checkSince: null,
    lastStatus: '',
    diagnosis: null,
  }
}

export function sampleRun(): OmhRunView {
  return {
    id: '20261127-demo',
    dir: '/tmp/x/.omh/runs/20261127-demo',
    goal: 'Port omh to opencode',
    current: 2,
    waves: [
      { id: 1, gate: 'tests pass', gatePassed: true, tasks: [{ id: 'T1', title: 'core', category: 'deep', status: 'verified', worker: 'w1', profile: 'claude-sonnet', note: null }, { id: 'T2', title: 'sync', category: 'quick', status: 'verified', worker: 'w2', profile: null, note: null }] },
      {
        id: 2,
        gate: 'tui works',
        gatePassed: false,
        tasks: [
          { id: 'T3', title: 'server', category: 'deep', status: 'working', worker: 'w1', profile: 'claude-sonnet', note: null },
          { id: 'T4', title: 'tui', category: 'visual', status: 'blocked', worker: 'w2', profile: 'opencode-go', note: 'permission prompt' },
          { id: 'T5', title: 'docs', category: 'writing', status: 'reported', worker: 'w3', profile: null, note: null },
        ],
      },
      { id: 3, gate: 'review', gatePassed: false, tasks: [] },
    ],
  }
}

export function quota(provider: string, used: number, limitReached = false): OmhQuota {
  return { provider, checkedAt: 1, windows: [{ name: '5h', usedPercent: used, resetsAt: null, scope: null }], limitReached, error: null, source: null }
}

export function snap(over: Partial<Snapshot> = {}): Snapshot {
  return { active: true, display: 'statusline', run: sampleRun(), workers: {}, quota: {}, ...over }
}
