import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { agentCallRule, isSubagentProfile, normalizeConfig, routedSubagents } from '../config'

const AGENTS = {
  subagent: { launch: 'subagent', host: 'claudecode' },
  'oc-subagent': { launch: 'subagent', host: 'opencode', kind: 'general', model: 'opencode-go/deepseek-v4.1-flash' },
}

const RAW = {
  profiles: {
    'sub-cc': { agent: 'subagent', family: 'claude', subagent_type: 'Explore', model: 'haiku' },
    'oc-deep': { agent: 'oc-subagent', family: 'deepseek' },
  },
  categories: {
    explore: ['sub-cc', 'oc-deep'],
    deep: ['oc-deep'],
    quick: ['sub-cc'],
  },
}

describe('host-specific subagent profiles', () => {
  test('a profile gets the target host and the agent default model/type', () => {
    const cc = normalizeConfig('/c.json', RAW, AGENTS, 'claudecode')
    const oc = normalizeConfig('/c.json', RAW, AGENTS, 'opencode')

    expect(cc.host).toBe('claudecode')
    expect(oc.host).toBe('opencode')
    expect(oc.profiles['oc-deep']).toMatchObject({ agent: 'oc-subagent', model: 'opencode-go/deepseek-v4.1-flash', subagentType: 'general' })
    expect(cc.profiles['sub-cc']).toMatchObject({ agent: 'subagent', model: 'haiku', subagentType: 'Explore' })
  })

  test('CC profiles are hidden from opencode categories and vice versa', () => {
    const cc = normalizeConfig('/c.json', RAW, AGENTS, 'claudecode')
    const oc = normalizeConfig('/c.json', RAW, AGENTS, 'opencode')

    expect(cc.categories.explore!.profiles).toEqual(['sub-cc'])
    expect(cc.categories.deep!.profiles).toEqual([])
    expect(oc.categories.explore!.profiles).toEqual(['oc-deep'])
    expect(oc.categories.quick!.profiles).toEqual([])

    expect(isSubagentProfile(cc, 'sub-cc')).toBe(true)
    expect(isSubagentProfile(cc, 'oc-deep')).toBe(false)
    expect(isSubagentProfile(oc, 'oc-deep')).toBe(true)
    expect(isSubagentProfile(oc, 'sub-cc')).toBe(false)
  })

  test('routed subagents and the Agent rule use only the host profiles', () => {
    const cc = normalizeConfig('/c.json', RAW, AGENTS, 'claudecode')
    const oc = normalizeConfig('/c.json', RAW, AGENTS, 'opencode')

    expect(routedSubagents(cc)).toEqual([{ type: 'Explore', model: 'haiku' }])
    expect(routedSubagents(oc)).toEqual([{ type: 'general', model: 'opencode-go/deepseek-v4.1-flash' }])
    expect(agentCallRule(oc, { subagent_type: 'general' })).toEqual({ model: 'opencode-go/deepseek-v4.1-flash' })
    expect(agentCallRule(oc, { subagent_type: 'Explore' })).toMatchObject({ deny: expect.stringContaining("subagent_type 'Explore'") })
  })

  test('the shipped default routes no category to an opencode subagent', async () => {
    const raw = JSON.parse(await readFile(join(import.meta.dir, '../../skills/oh-my-herdr/assets/config.default.json'), 'utf8')) as unknown
    const oc = normalizeConfig('/default.json', raw, AGENTS, 'opencode')
    expect(oc.categories.explore!.profiles).not.toContain('sub-explore')
    expect(routedSubagents(oc)).toEqual([])
    expect(agentCallRule(oc, { subagent_type: 'general' })).toMatchObject({ deny: expect.stringContaining('routes no category to a subagent') })
  })
})
