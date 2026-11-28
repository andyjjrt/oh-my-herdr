import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { setConfigHost } from '../../../core/config'
import { approveRun, draftPlan, writePlan } from '../../../core/actions'
import { optionsOf, rt } from '../../../core/runtime'
import { createEngine } from '../../src/server/engine'
import { boot } from '../../src/server/index'
import { fakeContext, resetForTest } from '../server/fake'

afterEach(() => {
  resetForTest()
  setConfigHost('claudecode')
})

async function booted(fake: Awaited<ReturnType<typeof fakeContext>>, env: Record<string, string> = {}) {
  const engine = createEngine(fake.context, optionsOf({}), undefined, env)
  await boot(fake.context, engine, optionsOf({}))
  return engine
}

describe('per-lead opencode storage', () => {
  test('two projects sharing one storage see different bound, workers, wake and continue state', async () => {
    const a = await fakeContext()
    const b = await fakeContext()
    ;(b.context as any).storage = (a.context as any).storage
    try {
      const ea = await booted(a, { HERDR_PANE_ID: 'w1:p1' })
      const eb = await booted(b, { HERDR_PANE_ID: 'w2:p2' })

      await ea.state.bound.set(() => ({ run: 'run-a', root: a.root }))
      await ea.state.workers.set(() => ({ wa: { name: 'wa' } as any }))
      await ea.state.wake.set(w => ({ ...w, sections: ['wake-a'] }))
      await ea.state.continueCount.set(() => 7)

      expect(await eb.state.bound.get()).toBeNull()
      expect(await eb.state.workers.get()).toEqual({})
      expect(await eb.state.wake.get()).toEqual({ sections: [], settleKey: '' })
      expect(await eb.state.continueCount.get()).toBe(0)
      expect(await ea.state.bound.get()).toEqual({ run: 'run-a', root: a.root })
      expect(await ea.state.wake.get()).toEqual({ sections: ['wake-a'], settleKey: '' })
    } finally {
      await a.close()
      await b.close()
    }
  })

  test('a worktree lead and the main-checkout lead on one .omh keep separate state', async () => {
    const a = await fakeContext()
    const b = await fakeContext()
    ;(b.context as any).storage = (a.context as any).storage
    try {
      const omh = join(a.root, '.omh')
      const ea = await booted(a, { OMH_DIR: omh, HERDR_PANE_ID: 'w1:p1' })
      await ea.state.bound.set(() => ({ run: 'run-a', root: a.root }))
      await ea.state.wake.set(w => ({ ...w, sections: ['wake-a'] }))
      const eb = await booted(b, { OMH_DIR: omh, HERDR_PANE_ID: 'w2:p2' })
      expect(await eb.state.bound.get()).toBeNull()
      expect(await eb.state.wake.get()).toEqual({ sections: [], settleKey: '' })
      expect(await ea.state.bound.get()).toEqual({ run: 'run-a', root: a.root })
      expect(await ea.state.wake.get()).toEqual({ sections: ['wake-a'], settleKey: '' })
    } finally {
      await a.close()
      await b.close()
    }
  })

  test('two panes in one checkout on one .omh keep separate state', async () => {
    const a = await fakeContext()
    const b = await fakeContext()
    ;(b.context as any).storage = (a.context as any).storage
    ;(b.context as any).location = { ...(a.context as any).location, directory: a.root }
    try {
      const ea = await booted(a, { HERDR_PANE_ID: 'w1:p1' })
      const eb = await booted(b, { HERDR_PANE_ID: 'w1:p2' })
      await ea.state.bound.set(() => ({ run: 'run-a', root: a.root }))
      expect(await eb.state.bound.get()).toBeNull()
      expect(await ea.state.bound.get()).toEqual({ run: 'run-a', root: a.root })
    } finally {
      await a.close()
      await b.close()
    }
  })

  test('a second lead cannot approve a run held by a live pane', async () => {
    const a = await fakeContext()
    const b = await fakeContext()
    ;(b.context as any).location = { ...(a.context as any).location, directory: a.root }
    try {
      const ea = await booted(a, { HERDR_PANE_ID: 'wA:p1' })
      expect((await draftPlan('# A\n\nGoal: A\n', 'a-run')).ok).toBe(true)
      expect((await approveRun()).ok).toBe(true)
      const run = rt.paths!.boundRun!
      expect((await writePlan({ goal: 'A', waves: [{ id: 1, gate: 'g', tasks: [{ id: 't1', title: 'T', intent: 'implement', category: 'deep', owns: [], deps: [] }] }] })).ok).toBe(true)
      expect(run).toContain('a-run')

      const eb = await booted(b, { HERDR_PANE_ID: 'wB:p1' })
      const original = eb.process.run.bind(eb.process)
      eb.process.run = async (argv, init) => {
        if (argv[0] === 'herdr' && argv[1] === 'pane' && argv[2] === 'get') {
          return { exitCode: 0, stdout: JSON.stringify({ result: { pane: { pane_id: 'wA:p1' } } }), stderr: '' }
        }
        return original(argv, init)
      }
      const answer = await approveRun(run)
      expect(answer.ok).toBe(false)
      expect(answer.text).toContain('led by a live session')
    } finally {
      await a.close()
      await b.close()
    }
  })

  test('restores the lead session from lead.json for a seeded run', async () => {
    const a = await fakeContext()
    try {
      const run = '20261128-restore'
      await mkdir(join(a.root, '.omh/runs', run), { recursive: true })
      await writeFile(
        join(a.root, '.omh/runs', run, 'lead.json'),
        JSON.stringify({ pane: 'w1:p1', root: a.root, session: 'ses_restored' }),
      )
      const e = await booted(a, { OMH_RUN: run, HERDR_PANE_ID: 'w1:p1' })
      expect(e.lead.session).toBe('ses_restored')
      expect(rt.paths!.boundRun).toBe(run)
      const lead = JSON.parse(await Bun.file(join(a.root, '.omh/runs', run, 'lead.json')).text())
      expect(lead.session).toBe('ses_restored')
    } finally {
      await a.close()
    }
  })

  test('two prompt.submit calls with identical text both reach synthetic', async () => {
    const a = await fakeContext()
    try {
      const e = await booted(a, { HERDR_PANE_ID: 'w1:p1' })
      e.lead.session = 'ses_lead'
      await e.prompt.submit({ text: 'same' })
      await e.prompt.submit({ text: 'same' })
      expect(a.synthetic).toHaveLength(2)
      expect(a.synthetic[0].id).not.toBe(a.synthetic[1].id)
      expect(a.synthetic.every(item => item.delivery === 'queue')).toBe(true)
    } finally {
      await a.close()
    }
  })

  test('a serve process that inherits OMH_ROLE=worker logs a loud dormant warning', async () => {
    const a = await fakeContext()
    const saved = process.argv
    try {
      process.argv = [...saved, 'serve']
      const e = createEngine(a.context, optionsOf({}), undefined, { OMH_ROLE: 'worker' })
      const logs: string[] = []
      e.ui.log = text => logs.push(text)
      expect(await boot(a.context, e, optionsOf({}))).toBe(false)
      expect(logs.join('\n')).toContain('DORMANT opencode serve/service')
      expect(logs.join('\n')).toContain('not through a shared service')
    } finally {
      process.argv = saved
      await a.close()
    }
  })

  test('resetForTest restores the Claude Code config host', async () => {
    const a = await fakeContext()
    try {
      createEngine(a.context, optionsOf({}), undefined, {})
      resetForTest()
      const { configHost } = await import('../../../core/config')
      expect(configHost()).toBe('claudecode')
    } finally {
      await a.close()
    }
  })
})
