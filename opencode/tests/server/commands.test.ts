import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { approvePlan, draftPlan, writePlan } from '../../../core/actions'
import { setup, waitFor, resetForTest } from './fake'

afterEach(() => {
  resetForTest()
})

describe('commands', () => {
  test('registers /ulw and /omh', async () => {
    const { fake } = await setup({ tools: false })
    try {
      expect(fake.commands.map(command => command.name).sort()).toEqual(['omh', 'ulw'])
    } finally {
      await fake.close()
    }
  })

  test('/ulw makes its session the lead and prompts it with the opencode tool names', async () => {
    const { fake, engine } = await setup({ tools: false })
    try {
      const ulw = fake.commands.find(command => command.name === 'ulw')!
      await ulw.execute({ sessionID: 'ses_ulw', prompt: { text: 'hello' }, delivery: 'queue' })
      await waitFor(() => fake.prompts.length === 1)
      expect(engine.lead.session).toBe('ses_ulw')
      expect(fake.prompts[0].sessionID).toBe('ses_ulw')
      expect(fake.prompts[0].text).toContain('ulw — ultrawork')
      expect(fake.prompts[0].text).toContain('`omh_dispatch`')
      expect(fake.prompts[0].text).toContain('`omh_*` tools')
      expect(fake.prompts[0].text).not.toContain('mcp__oh-my-herdr__')
    } finally {
      await fake.close()
    }
  })

  test('/omh approve binds the session and restores its session field in lead.json', async () => {
    const { fake } = await setup({ tools: false })
    try {
      expect((await draftPlan('# Demo\n\nGoal: demonstrate the port.\n', 'demo')).ok).toBe(true)
      const omh = fake.commands.find(command => command.name === 'omh')!
      await omh.execute({ sessionID: 'ses_approve', prompt: { text: 'approve' }, delivery: 'queue' })
      const run = (await readFile(join(fake.root, '.omh/current-run'), 'utf8')).trim()
      const lead = JSON.parse(await readFile(join(fake.root, '.omh/runs', run, 'lead.json'), 'utf8'))
      expect(lead).toMatchObject({ pane: 'w1:p1', session: 'ses_approve' })
      expect(fake.synthetic.at(-1)!.text).toContain('now leads')
      expect(fake.synthetic.at(-1)!.resume).toBeUndefined()
    } finally {
      await fake.close()
    }
  })

  test('/ulw lists the oc-subagent kinds the config routes', async () => {
    const { fake } = await setup({ tools: false })
    try {
      await mkdir(join(fake.root, '.omh'), { recursive: true })
      await writeFile(
        join(fake.root, '.omh/config.json'),
        JSON.stringify({
          profiles: { oc: { agent: 'oc-subagent', family: 'deepseek', subagent_type: 'Explore', model: 'haiku' } },
          categories: { explore: ['oc'] },
        }),
      )
      const ulw = fake.commands.find(command => command.name === 'ulw')!
      await ulw.execute({ sessionID: 'ses_ulw_route', prompt: { text: 'hello' }, delivery: 'queue' })
      await waitFor(() => fake.prompts.length === 1)
      expect(fake.prompts[0].text).toContain('only these (type · model, as the config routes them): Explore · haiku')
    } finally {
      await fake.close()
    }
  })

  test('/omh status delivers the board as a synthetic message', async () => {
    const { fake } = await setup({ tools: false })
    try {
      expect((await draftPlan('# Demo\n\nGoal: demonstrate the port.\n', 'demo')).ok).toBe(true)
      expect((await approvePlan()).ok).toBe(true)
      expect(
        (
          await writePlan({
            goal: 'Demo',
            waves: [
              {
                id: 1,
                gate: 'tests pass',
                tasks: [{ id: 't1', title: 'Task one', intent: 'implement', category: 'deep', owns: ['a.ts'], deps: [] }],
              },
            ],
          })
        ).ok,
      ).toBe(true)

      const omh = fake.commands.find(command => command.name === 'omh')!
      await omh.execute({ sessionID: 'ses_status', prompt: { text: 'status' }, delivery: 'queue' })
      const delivered = fake.synthetic.at(-1)!
      expect(delivered.sessionID).toBe('ses_status')
      expect(delivered.delivery).toBe('queue')
      expect(delivered.text).toContain('Demo')
      expect(delivered.text).toContain('Task one')
      expect(delivered.text).toContain('W1')
      expect(delivered.resume).toBe(false)
    } finally {
      await fake.close()
    }
  })
})
