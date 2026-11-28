// Core actions on a host with no subagent capability: a task routed to a subagent profile must be
// refused with a clear message, not crash on a missing method.

import { describe, expect, test } from 'bun:test'

import { dispatch } from '../actions'
import { Paths } from '../files'
import { optionsOf, rt } from '../runtime'
import { fakeHost } from '../testing/fake-host'

const AGENTS = { claude: { launch: 'herdr-kind', kind: 'claude', bin: 'claude' }, subagent: { launch: 'subagent' } }
const CONFIG = {
  profiles: {
    'sub-explore': { agent: 'subagent', family: 'claude', subagent_type: 'Explore', model: 'haiku' },
  },
  categories: { explore: ['sub-explore'] },
}

describe('dispatch to a subagent profile without a subagent host', () => {
  test('refuses instead of starting nothing', async () => {
    const host = fakeHost({
      assets: { agents: AGENTS, config: CONFIG },
      lead: { pane: 'w1:p1', session: null },
    })
    const saved = { $: rt.$, paths: rt.paths, cfg: rt.cfg, paneSeen: rt.paneSeen, wakeGuards: rt.wakeGuards, watchers: rt.watchers, options: rt.options }
    rt.$ = host as never
    rt.paths = new Paths('/work', '/work/.omh')
    rt.cfg = null
    rt.paneSeen = new Map()
    rt.wakeGuards = new Map()
    rt.watchers = new Map()
    rt.options = optionsOf({})
    try {
      const result = await dispatch({ task: 'scout-auth', intent: 'explore', rationale: 'look it up', brief: 'Find the session check.' })
      expect(result.ok).toBe(false)
      expect(result.text).toContain('subagents are not available on this host; use a profile that runs in a pane')
      expect('subagent' in host).toBe(false)
    } finally {
      Object.assign(rt, saved)
    }
  })
})
