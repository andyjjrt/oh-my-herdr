import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { resetForTest } from '../server/fake'
import { fire, seedRun, startGuards, SUBAGENT_CONFIG } from './fixture'
import { installGuards, type GuardHost } from '../../src/server/guards'

afterEach(() => {
  resetForTest()
})

const edit = (sessionID: string, path: string) => ({ tool: 'edit', sessionID, input: { path } })

describe('guards', () => {
  test('edit and write are denied on a file another working task owns', async () => {
    const { fake, engine, hooks } = await startGuards()
    try {
      await installGuards(fake.context as unknown as GuardHost)
      const { root } = await seedRun(engine, { worker: true })
      for (const tool of ['edit', 'write'] as const) {
        await expect(fire(hooks, 'tool', 'execute.before', { tool, sessionID: 'ses_lead', input: { path: 'owned.ts' } })).rejects.toThrow('belongs to task t1')
        await expect(fire(hooks, 'tool', 'execute.before', { tool, sessionID: 'ses_lead', input: { path: join(root, 'owned.ts') } })).rejects.toThrow('belongs to task t1')
      }
    } finally {
      await fake.close()
    }
  })

  test('a file no running task owns is allowed', async () => {
    const { fake, engine, hooks } = await startGuards()
    try {
      await installGuards(fake.context as unknown as GuardHost)
      await seedRun(engine, { worker: true })
      await expect(fire(hooks, 'tool', 'execute.before', edit('ses_lead', 'free.ts'))).resolves.toBeUndefined()
    } finally {
      await fake.close()
    }
  })

  test('no run means no ownership guard', async () => {
    const { fake, hooks } = await startGuards()
    try {
      await installGuards(fake.context as unknown as GuardHost)
      await expect(fire(hooks, 'tool', 'execute.before', edit('ses_lead', 'owned.ts'))).resolves.toBeUndefined()
    } finally {
      await fake.close()
    }
  })

  test('the subagent guard runs before a run is bound', async () => {
    const { fake, engine, hooks } = await startGuards(null)
    try {
      await installGuards(fake.context as unknown as GuardHost)
      engine.lead.session = 'ses_lead'
      await expect(fire(hooks, 'tool', 'execute.before', { tool: 'subagent', sessionID: 'ses_lead', input: { agent: 'Explore' } })).rejects.toThrow('routes no category to a subagent')
    } finally {
      await fake.close()
    }
  })

  test('patch is denied through permission resources', async () => {
    const { fake, engine, hooks } = await startGuards()
    try {
      await installGuards(fake.context as unknown as GuardHost)
      await seedRun(engine, { worker: true })
      // patch's execute.before has no path; it must not throw here.
      await expect(fire(hooks, 'tool', 'execute.before', { tool: 'patch', sessionID: 'ses_lead', input: { patchText: '*** Begin Patch\n*** Update File: owned.ts\n*** End Patch' } })).resolves.toBeUndefined()
      const event: { sessionID: string; action: string; resources: string[]; effect: string; message?: string } = { sessionID: 'ses_lead', action: 'edit', resources: ['owned.ts'], effect: 'allow' }
      await fire(hooks, 'permission', 'evaluate', event)
      expect(event.effect).toBe('deny')
      expect(event.message).toContain('belongs to task t1')
    } finally {
      await fake.close()
    }
  })

  test('subagent is denied under the default config', async () => {
    const { fake, engine, hooks } = await startGuards(null)
    try {
      await installGuards(fake.context as unknown as GuardHost)
      await seedRun(engine)
      await expect(fire(hooks, 'tool', 'execute.before', { tool: 'subagent', sessionID: 'ses_lead', input: { agent: 'Explore' } })).rejects.toThrow('routes no category to a subagent')
    } finally {
      await fake.close()
    }
  })

  test('subagent is allowed and its model rewritten when a category routes to it', async () => {
    const { fake, engine, hooks } = await startGuards(SUBAGENT_CONFIG)
    try {
      await installGuards(fake.context as unknown as GuardHost)
      await seedRun(engine)
      const input: { agent: string; model?: string } = { agent: 'Explore' }
      await fire(hooks, 'tool', 'execute.before', { tool: 'subagent', sessionID: 'ses_lead', input })
      expect(input.model).toBe('haiku')
      await expect(fire(hooks, 'tool', 'execute.before', { tool: 'subagent', sessionID: 'ses_lead', input: { agent: 'general-purpose' } })).rejects.toThrow('is not one the config')
      await expect(fire(hooks, 'tool', 'execute.before', { tool: 'subagent', sessionID: 'ses_lead', input: { agent: 'general' } })).rejects.toThrow('is not one the config')
    } finally {
      await fake.close()
    }
  })

  test('a rule with no model strips the input model and maps general', async () => {
    const { fake, engine, hooks } = await startGuards({
      agents: { 'oc-none': { launch: 'subagent', host: 'opencode', kind: 'general-purpose' } },
      profiles: { oc: { agent: 'oc-none', family: 'opencode' } },
      categories: { deep: ['oc'], explore: ['oc'] },
    })
    try {
      await installGuards(fake.context as unknown as GuardHost)
      await seedRun(engine)
      const input: { agent: string; model?: string } = { agent: 'general', model: 'lead-model' }
      await fire(hooks, 'tool', 'execute.before', { tool: 'subagent', sessionID: 'ses_lead', input })
      expect('model' in input).toBe(false)
    } finally {
      await fake.close()
    }
  })

  test('no guard runs in a worker (no runtime binding)', async () => {
    const { fake, engine, hooks } = await startGuards()
    try {
      await installGuards(fake.context as unknown as GuardHost)
      await seedRun(engine, { worker: true })
      resetForTest()
      await expect(fire(hooks, 'tool', 'execute.before', edit('ses_lead', 'owned.ts'))).resolves.toBeUndefined()
      await expect(fire(hooks, 'tool', 'execute.before', { tool: 'subagent', sessionID: 'ses_lead', input: { agent: 'Explore' } })).resolves.toBeUndefined()
      await expect(fire(hooks, 'permission', 'evaluate', { sessionID: 'ses_lead', action: 'edit', resources: ['owned.ts'], effect: 'allow' })).resolves.toBeUndefined()
    } finally {
      await fake.close()
    }
  })
})
