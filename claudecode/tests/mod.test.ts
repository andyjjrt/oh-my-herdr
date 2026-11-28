// The mod as the engine loads it: when it wakes up, and what it registers.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { configProblems, normalizeConfig, statusReportProblems } from '../core/config'
import { pickProfile } from '../core/route'

const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

function recorder(on: On) {
  const tools: string[] = []
  const commands: string[] = []
  on('tool.register', ($, e) => {
    tools.push(e.name)
    return { value: { tool: `mcp__oh-my-herdr__${e.name}` } }
  })
  on('command.register', ($, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return { tools, commands }
}

describe('dormancy', () => {
  test('outside herdr the mod registers nothing', async ($, on) => {
    const seen = recorder(on)
    mock.env(on, { HOME: '/home/u' })
    mock.clock(on)
    await $.session.start(SESSION)
    expect(seen.tools).toEqual([])
    expect(seen.commands).toEqual([])
  })

  test('inside a worker pane (OMH_ROLE=worker) the mod registers nothing', async ($, on) => {
    const seen = recorder(on)
    mock.env(on, { HERDR_ENV: '1', OMH_ROLE: 'worker', HOME: '/home/u' })
    mock.clock(on)
    await $.session.start(SESSION)
    expect(seen.tools).toEqual([])
    expect(seen.commands).toEqual([])
  })

  test('in a herdr lead pane it registers the tools and commands', async ($, on) => {
    const seen = recorder(on)
    mock.env(on, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HOME: '/home/u' })
    mock.clock(on)
    await $.session.start(SESSION)
    expect(seen.tools.sort()).toEqual(['omh_collect', 'omh_dispatch', 'omh_spawn', 'omh_status', 'omh_teardown'])
    expect(seen.commands.sort()).toEqual(['omh', 'ulw'])
  })
})

describe('status reporting', () => {
  const AGENTS = {
    claude: { launch: 'herdr-kind', kind: 'claude', reports: ['herdr', 'hc'] },
    senpi: { launch: 'command', command: ['senpi'], reports: ['herdr', 'hc'], min_version: { hc: '2026.11.21' }, version_cmd: ['senpi', '--version'] },
  }
  const RAW = {
    profiles: { c: { agent: 'claude', family: 'a' }, s: { agent: 'senpi', family: 'b' } },
    categories: { quick: ['s', 'c'] },
  }
  const cfg = normalizeConfig('/x/config.json', RAW, AGENTS)

  test('parses reports, min_version and version_cmd', () => {
    expect(cfg.agents.senpi!.reports).toEqual(['herdr', 'hc'])
    expect(cfg.agents.senpi!.min_version).toEqual({ hc: '2026.11.21' })
    expect(cfg.agents.senpi!.version_cmd).toEqual(['senpi', '--version'])
    expect(cfg.agents.claude!.min_version).toBeUndefined()
    expect(configProblems(cfg)).toEqual([])
  })

  test('flags an old senpi on hc, not a new one, nothing on herdr', () => {
    expect(statusReportProblems(cfg, 'hc', { senpi: '2026.10.16-3', claude: null }).length).toBe(1)
    expect(statusReportProblems(cfg, 'hc', { senpi: '2026.11.21-2', claude: null })).toEqual([])
    expect(statusReportProblems(cfg, 'herdr', { senpi: '2026.10.16-3', claude: null })).toEqual([])
  })

  test('flags an agent that does not list the backend', () => {
    const c = normalizeConfig('/x/config.json', RAW, { ...AGENTS, claude: { ...AGENTS.claude, reports: ['herdr'] } })
    expect(statusReportProblems(c, 'hc', {}).length).toBe(1)
  })

  test('routing skips an unusable profile and falls through', () => {
    const base = { intent: null, avoidFamilies: [], quotaOk: () => true }
    expect(pickProfile(cfg, 'quick', base)).toMatchObject({ ok: true, profile: 's' })
    expect(pickProfile(cfg, 'quick', { ...base, unusable: new Set(['s']) })).toMatchObject({ ok: true, profile: 'c' })
  })
})
