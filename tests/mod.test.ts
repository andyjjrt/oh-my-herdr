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

describe('band', () => {
  const VIEW = {
    id: 'r1',
    dir: '/work/.omh/runs/r1',
    goal: 'g',
    current: 1,
    waves: [
      {
        id: 1,
        gate: 'tests pass',
        gatePassed: false,
        tasks: [
          { id: 'T1', title: 'a', category: 'quick', status: 'verified', worker: 'w1-t1', profile: 'go-fast', note: null },
          { id: 'T2', title: 'b', category: 'quick', status: 'alert', worker: 'w1-t2', profile: 'go-fast', note: 'crashed' },
          { id: 'T3', title: 'c', category: 'quick', status: 'working', worker: 'w1-t3', profile: 'go-fast', note: null },
        ],
      },
    ],
  }
  const BAND = {
    plugin: 'oh-my-herdr',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  } as const

  test('draws the current wave on every surface that has a band', async ($, on) => {
    recorder(on)
    mock.env(on, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HOME: '/home/u' })
    mock.clock(on)
    on('state.get', ($, e) => (e.key === 'run' ? { value: { value: { shape: 'run-1', value: VIEW }, version: 1 } } : undefined) as never)
    await $.session.start(SESSION)
    for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface } as never)
      const found = (await ui.find({ type: 'Progress' } as never)) ?? (await ui.find({ type: 'Text', text: /omh W1/ }))
      expect(found).toBeDefined()
      await ui.unmount()
    }
  })
})
