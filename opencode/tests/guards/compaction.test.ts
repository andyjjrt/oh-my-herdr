import { afterEach, describe, expect, test } from 'bun:test'

import { installCompaction } from '../../src/server/compaction'
import { resetForTest } from '../server/fake'
import { fire, seedRun, settle, startGuards, waitFor } from './fixture'

afterEach(() => {
  resetForTest()
})

describe('compaction', () => {
  test('appends the run board after the lead compacts', async () => {
    const { fake, engine, hooks } = await startGuards()
    try {
      await installCompaction(fake.context as any, engine)
      const { run } = await seedRun(engine)
      await fire(hooks, 'session', 'compaction', { sessionID: 'ses_lead', agent: 'build', messages: [] })
      await settle()
      await waitFor(() => fake.synthetic.length === 1)
      const text = fake.synthetic[0].text
      expect(text).toContain('[oh-my-herdr] Board after compaction')
      expect(text).toContain(`Run \`${run}\``)
      expect(text).toContain('Guard run')
      expect(text).toContain('Task one')
      expect(fake.synthetic[0].sessionID).toBe('ses_lead')
      expect(fake.synthetic[0].resume).toBe(false)
    } finally {
      await fake.close()
    }
  })

  test('ignores a compaction in another session', async () => {
    const { fake, engine, hooks } = await startGuards()
    try {
      await installCompaction(fake.context as any, engine)
      await seedRun(engine)
      await fire(hooks, 'session', 'compaction', { sessionID: 'ses_other', agent: 'build', messages: [] })
      await settle()
      expect(fake.synthetic).toHaveLength(0)
    } finally {
      await fake.close()
    }
  })
})
