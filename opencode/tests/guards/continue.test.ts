import { afterEach, describe, expect, test } from 'bun:test'

import { installContinue } from '../../src/server/continue'
import { rt } from '../../../core/runtime'
import { resetForTest } from '../server/fake'
import { fire, seedRun, startGuards } from './fixture'

afterEach(() => {
  resetForTest()
})

async function startContinue(opts: { worker?: boolean } = {}) {
  const started = await startGuards()
  await installContinue(started.fake.context as any, started.engine)
  await seedRun(started.engine, opts)
  started.engine.lead.session = 'ses_lead'
  return started
}

describe('auto-continue', () => {
  test('continues up to the cap, then stops', async () => {
    const { fake, engine, hooks } = await startContinue()
    try {
      rt.options = { ...rt.options, autoContinue: true, autoContinueMax: 2 }

      await fire(hooks, 'session', 'experimental.idle', { sessionID: 'ses_lead', background: [] })
      await fire(hooks, 'session', 'experimental.idle', { sessionID: 'ses_lead', background: [] })
      await fire(hooks, 'session', 'experimental.idle', { sessionID: 'ses_lead', background: [] })
      expect(fake.synthetic).toHaveLength(2)
      expect(await engine.state.continueCount.get()).toBe(2)
      expect(fake.synthetic[0].text).toContain('auto-continue 1/2')
      expect(fake.synthetic[1].text).toContain('auto-continue 2/2')
    } finally {
      await fake.close()
    }
  })

  test('a human prompt resets the count; synthetic input does not', async () => {
    const { fake, engine, hooks } = await startContinue()
    try {
      rt.options = { ...rt.options, autoContinue: true, autoContinueMax: 1 }
      await fire(hooks, 'session', 'experimental.idle', { sessionID: 'ses_lead', background: [] })
      expect(await engine.state.continueCount.get()).toBe(1)
      await fire(hooks, 'session', 'prompt', { sessionID: 'ses_lead', metadata: { source: 'oh-my-herdr' } })
      expect(await engine.state.continueCount.get()).toBe(1)
      await fire(hooks, 'session', 'prompt', { sessionID: 'ses_lead', metadata: null })
      expect(await engine.state.continueCount.get()).toBe(0)
      await fire(hooks, 'session', 'experimental.idle', { sessionID: 'ses_lead', background: [] })
      expect(fake.synthetic).toHaveLength(2)
      expect(fake.synthetic[0].id).not.toBe(fake.synthetic[1].id)
    } finally {
      await fake.close()
    }
  })

  test('stops for a busy worker, a background job, another session, and a question', async () => {
    const { fake, engine, hooks } = await startContinue({ worker: true })
    try {
      rt.options = { ...rt.options, autoContinue: true, autoContinueMax: 2 }
      await fire(hooks, 'session', 'experimental.idle', { sessionID: 'ses_lead', background: [] })
      expect(fake.synthetic).toHaveLength(0) // w1 is working

      await engine.state.workers.set(() => ({}))
      await fire(hooks, 'session', 'experimental.idle', { sessionID: 'ses_other', background: [] })
      expect(fake.synthetic).toHaveLength(0)
      await fire(hooks, 'session', 'experimental.idle', { sessionID: 'ses_lead', background: [{ kind: 'shell' }] })
      expect(fake.synthetic).toHaveLength(0)

      fake.messages.push({ type: 'user', text: 'go' }, { type: 'assistant', content: [{ type: 'tool', name: 'question' }] })
      await fire(hooks, 'session', 'experimental.idle', { sessionID: 'ses_lead', background: [] })
      expect(fake.synthetic).toHaveLength(0)
    } finally {
      await fake.close()
    }
  })

  test('does nothing when autoContinue is off', async () => {
    const { fake, hooks } = await startContinue()
    try {
      await fire(hooks, 'session', 'experimental.idle', { sessionID: 'ses_lead', background: [] })
      expect(fake.synthetic).toHaveLength(0)
    } finally {
      await fake.close()
    }
  })
})
