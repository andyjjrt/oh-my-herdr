import { afterEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { wakeLead, resetWakeGuard, settleKeyFor } from '../../src/server/wake'
import { setup, resetForTest } from './fake'

afterEach(() => {
  resetForTest()
  resetWakeGuard()
})

describe('tool registration', () => {
  test('registers the five omh tools with the CC names and schemas', async () => {
    const { fake, engine } = await setup()
    try {
      expect('subagent' in engine).toBe(false)
      expect(engine.lead.pane).toBe('w1:p1')
      expect(fake.tools.map(tool => tool.name).sort()).toEqual(['omh_collect', 'omh_dispatch', 'omh_spawn', 'omh_status', 'omh_teardown'])
      const by = Object.fromEntries(fake.tools.map(tool => [tool.name, tool])) as Record<string, any>
      expect(by.omh_dispatch.input.required).toEqual(['task', 'intent', 'rationale', 'brief'])
      expect(by.omh_dispatch.input.properties.intent.enum).toEqual(['explore', 'research', 'implement', 'fix', 'review', 'plan', 'write'])
      expect(by.omh_status.input.required).toEqual(['action'])
      expect(by.omh_status.input.properties.action.enum).toEqual(['show', 'draft', 'plan', 'verified', 'abandon', 'gate', 'recheck', 'finish'])
      expect(by.omh_collect.input.required).toEqual(['task'])
      expect(by.omh_spawn.input.required).toEqual(['name'])
      expect(by.omh_teardown.input.required).toBeUndefined()
    } finally {
      await fake.close()
    }
  })

  test('a tool call makes its session the lead and records it in lead.json with the pane', async () => {
    const { fake, engine } = await setup()
    try {
      const tool = fake.tools.find(t => t.name === 'omh_status')!
      const result = await tool.execute(
        { action: 'draft', name: 'demo', markdown: '# Demo\n\nGoal: demonstrate the port.\n' },
        { sessionID: 'ses_tool' },
      )
      expect(result.content).toContain('draft written')
      expect(engine.lead.session).toBe('ses_tool')
      const run = (await readFile(join(fake.root, '.omh/current-run'), 'utf8')).trim()
      const lead = JSON.parse(await readFile(join(fake.root, '.omh/runs', run, 'lead.json'), 'utf8'))
      expect(lead).toMatchObject({ pane: 'w1:p1', session: 'ses_tool' })
    } finally {
      await fake.close()
    }
  })
})

describe('wake', () => {
  test('sends one synthetic per settle key and queues it', async () => {
    const { fake } = await setup({ tools: false, commands: false })
    try {
      expect(await wakeLead(fake.context, 'ses_lead', 'settled', 'settle-1')).toBe(true)
      expect(await wakeLead(fake.context, 'ses_lead', 'settled', 'settle-1')).toBe(false)
      expect(fake.synthetic).toHaveLength(1)
      expect(fake.synthetic[0]).toMatchObject({ sessionID: 'ses_lead', delivery: 'queue', text: 'settled' })
      expect(fake.synthetic[0].id.startsWith('msg_')).toBe(true)
      expect(await wakeLead(fake.context, 'ses_lead', 'settled', 'settle-2')).toBe(true)
      expect(fake.synthetic).toHaveLength(2)
    } finally {
      await fake.close()
    }
  })

  test('derives a stable msg_ id from the wake text', () => {
    const a = settleKeyFor('same')
    expect(a).toBe(settleKeyFor('same'))
    expect(a).not.toBe(settleKeyFor('other'))
    expect(a.startsWith('msg_omh_')).toBe(true)
  })
})
