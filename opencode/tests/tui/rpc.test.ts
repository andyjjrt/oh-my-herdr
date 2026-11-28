// RPC round-trip: the TUI's /omh -> client.rpc(OmhRpc) -> fake transport -> the server part's
// registered handlers -> core, and back.

import { afterEach, describe, expect, test } from 'bun:test'

import { approvePlan, draftPlan, writePlan } from '../../../core/actions'
import { rt } from '../../../core/runtime'
import { rpcApi } from '../../src/rpc/client'
import { installRpc, type RpcHost } from '../../src/rpc/server'
import { runOmh } from '../../src/tui/commands'
import { resetForTest, setup } from '../server/fake'
import { fakeTransport } from './fixtures'

afterEach(() => resetForTest())

async function wired(hermetic = false) {
  const { fake, engine } = await setup({ tools: false, commands: false })
  if (hermetic) {
    // Keep quota/check hermetic: no subprocess, no network.
    engine.process.run = async () => ({ exitCode: 1, stdout: '', stderr: '' })
    engine.http.fetch = async () => ({ status: 503, ok: false, text: '' })
  }
  const transport = fakeTransport()
  ;(fake.context as any).rpc = transport.server
  const registration = await installRpc(fake.context as unknown as RpcHost)
  const api = rpcApi({ client: transport.client })
  return { fake, engine, transport, registration, api }
}

async function withRun() {
  expect((await draftPlan('# Demo\n\nGoal: demonstrate the TUI.\n', 'demo')).ok).toBe(true)
  expect((await approvePlan()).ok).toBe(true)
  const written = await writePlan({
    goal: 'demonstrate the TUI',
    waves: [{ id: 1, gate: 'tests pass', tasks: [{ id: 'T1', title: 'tui', intent: 'implement', category: 'deep', owns: ['src/tui.ts'], deps: [] }] }],
  })
  expect(written.ok).toBe(true)
}

describe('TUI /omh over RPC', () => {
  test('each immediate subcommand round-trips with no run', async () => {
    const { fake, api, transport } = await wired(true)
    try {
      const status = await runOmh(api, 'status', 'ses_1')
      expect(status).toMatchObject({ kind: 'text', title: '/omh status', ok: true })
      expect((status as any).text).toContain('No run in progress')

      const runs = await runOmh(api, 'runs\n', 'ses_1')
      expect(runs).toMatchObject({ kind: 'text', title: '/omh runs', ok: true })
      expect((runs as any).text).toContain('no runs yet')

      const quota = await runOmh(api, 'quota', 'ses_1')
      expect(quota).toMatchObject({ kind: 'text', title: '/omh quota' })
      expect((quota as any).text.length).toBeGreaterThan(0)

      const check = await runOmh(api, 'check', 'ses_1')
      expect(check).toMatchObject({ kind: 'text', title: '/omh check' })
      expect((check as any).text).toContain('Check')

      expect(await runOmh(api, 'board', 'ses_1')).toEqual({ kind: 'panel', name: 'omh.board' })

      const plan = await runOmh(api, 'plan', 'ses_1')
      expect(plan).toMatchObject({ kind: 'text', ok: false })
      expect((plan as any).text).toContain('no plan.md yet')

      expect(transport.calls.map(c => `${c.id}.${c.method}`)).toEqual(Array(6).fill('omh.command'))
      expect(transport.calls[1]!.input).toEqual({ args: 'runs', sessionID: 'ses_1' })
      // No model turn: nothing was prompted into, or appended to, the session.
      expect(fake.prompts).toEqual([])
      expect(fake.synthetic).toEqual([])
    } finally {
      await fake.close()
    }
  })

  test('with a run: status, plan, snapshot and plan text', async () => {
    const { fake, api } = await wired()
    try {
      await withRun()
      const status = await runOmh(api, 'status', 'ses_1')
      expect((status as any).text).toContain('demonstrate the TUI')
      expect(await runOmh(api, 'plan', 'ses_1')).toEqual({ kind: 'panel', name: 'omh.plan' })
      const plan = await api.plan()
      expect(plan.file).toEndWith('plan.md')
      expect(plan.markdown).toContain('Goal: demonstrate the TUI.')
      const snap = await api.snapshot()
      expect(snap).toMatchObject({ active: true, display: 'statusline' })
      expect(snap.run?.goal).toBe('demonstrate the TUI')
      expect(fake.prompts).toEqual([])
      expect(fake.synthetic).toEqual([])
    } finally {
      await fake.close()
    }
  })

  test('unknown subcommand prints usage; mutating ones go through the server command', async () => {
    const { fake, api } = await wired()
    try {
      expect(await runOmh(api, 'bogus', 'ses_1')).toMatchObject({ kind: 'text', ok: false, text: expect.stringContaining('usage: /omh') })
      expect(await runOmh(api, 'teardown', undefined)).toMatchObject({ ok: false, text: '/omh teardown needs an open session' })
      const teardown = await runOmh(api, 'teardown', 'ses_1')
      expect(teardown).toMatchObject({ kind: 'text', ok: true })
      expect(fake.synthetic).toHaveLength(1)
      expect(fake.synthetic[0].sessionID).toBe('ses_1')
    } finally {
      await fake.close()
    }
  })

  test('a dormant server and a missing server part stay quiet', async () => {
    const { fake, api, registration } = await wired()
    try {
      rt.$ = null
      expect(await api.snapshot()).toMatchObject({ active: false, run: null })
      expect(await runOmh(api, 'status', 'ses_1')).toMatchObject({ ok: false, text: expect.stringContaining('not active') })
      await registration!.dispose()
      await expect(api.snapshot()).rejects.toThrow('rpc.unavailable')
      expect(await runOmh(api, 'status', 'ses_1')).toMatchObject({ kind: 'text', ok: false, text: expect.stringContaining('did not answer') })
    } finally {
      await fake.close()
    }
  })
})
