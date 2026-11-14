// The mod as the engine loads it: when it wakes up, and what it registers.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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
