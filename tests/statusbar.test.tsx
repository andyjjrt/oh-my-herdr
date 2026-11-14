// The run's progress under or above the prompt, as each `display` draws it.

import { describe, expect, test } from 'claude-code/testing'

import { progressBar, progressText } from '../hooks/lib/statusbar'

const RUN = {
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
        { id: 'T1', title: 'a', category: 'quick', status: 'verified', worker: 'w1', profile: 'go-fast', note: null },
        { id: 'T2', title: 'b', category: 'quick', status: 'alert', worker: 'w2', profile: 'go-fast', note: 'crashed' },
        { id: 'T3', title: 'c', category: 'quick', status: 'working', worker: 'w3', profile: 'go-fast', note: null },
      ],
    },
    { id: 2, gate: 'review', gatePassed: false, tasks: [] },
  ],
}

/** state.get answers: the run, none unless given. */
function state(run: unknown = null) {
  return (() => ({ value: { value: { shape: 'run-1', value: run }, version: 1 } })) as never
}

const HINT = {
  plugin: 'oh-my-herdr',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '(shift+tab to cycle) · esc to interrupt' },
} as const

const ABOVE = {
  plugin: 'oh-my-herdr',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20 },
} as const

type Drawn = { type: string; props: Record<string, unknown>; children: unknown[] }
const nodes = (d: Drawn) => d.children.filter((c): c is Drawn => typeof c === 'object' && c !== null && 'props' in c)
const textOf = (d: unknown): string =>
  typeof d === 'string' || typeof d === 'number' ? String(d) : d && typeof d === 'object' && 'children' in d ? (d as Drawn).children.map(textOf).join('') : ''

/** Stands in for the engine: draws the hint, then the tail a hook added. */
function engine(on: any) {
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.component === 'PromptHint' ? `${e.props.hint}${e.props.tail ? ` | ${e.props.tail}` : ''}` : 'engine'}</Text>
  })
}

describe('pieces', () => {
  test('bar and text', () => {
    expect(progressBar(0, 5)).toBe('░░░░░░')
    expect(progressBar(2, 5)).toBe('██░░░░')
    expect(progressBar(5, 5)).toBe('██████')
    expect(progressBar(0, 0)).toBe('░░░░░░')
    expect(progressText(RUN as never)).toBe('omh ██░░░░ 1/3 ⚠1')
    expect(progressText(null)).toBe(null)
    expect(progressText({ ...RUN, current: null } as never)).toBe(null)
  })
})

describe('display: statusline (the default)', () => {
  test('the engine keeps its line; the progress is added to its end', async ($, on) => {
    on('state.get', state(RUN))
    engine(on as never)
    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' } as never)
    expect(textOf(await ui.drawn())).toBe('(shift+tab to cycle) · esc to interrupt | omh ██░░░░ 1/3 ⚠1')
    await ui.unmount()
    const above = await $.ui.mount({ ...ABOVE, surface: 'terminal' } as never)
    expect(textOf(await above.drawn())).toBe('engine')
    await above.unmount()
  })

  test('no run, no change', async ($, on) => {
    on('state.get', state(null))
    engine(on as never)
    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' } as never)
    expect(textOf(await ui.drawn())).toBe('(shift+tab to cycle) · esc to interrupt')
    await ui.unmount()
  })
})

describe('display: panel', () => {
  test('a row above the prompt shows the run; the hint line is left alone', { options: { display: 'panel' } }, async ($, on) => {
    on('state.get', state(RUN))
    engine(on as never)
    const hint = await $.ui.mount({ ...HINT, surface: 'terminal' } as never)
    expect(textOf(await hint.drawn())).toBe('(shift+tab to cycle) · esc to interrupt')
    await hint.unmount()
    const ui = await $.ui.mount({ ...ABOVE, surface: 'terminal' } as never)
    const drawn = (await ui.drawn()) as Drawn
    expect(textOf(nodes(drawn)[0])).toBe('omh ██░░░░ 1/3 · W1/2 · ⚠1')
    // What else is drawn above the prompt stays, under the row.
    expect(textOf(drawn).endsWith('engine')).toBe(true)
    await ui.unmount()
  })

  test('no row without an open run', { options: { display: 'panel' } }, async ($, on) => {
    on('state.get', state(null))
    engine(on as never)
    const ui = await $.ui.mount({ ...ABOVE, surface: 'terminal' } as never)
    expect(textOf(await ui.drawn())).toBe('engine')
    await ui.unmount()
  })
})

describe('display: off', () => {
  test('neither', { options: { display: 'off' } }, async ($, on) => {
    on('state.get', state(RUN))
    engine(on as never)
    for (const site of [HINT, ABOVE]) {
      const ui = await $.ui.mount({ ...site, surface: 'terminal' } as never)
      expect(textOf(await ui.drawn())).not.toContain('omh')
      await ui.unmount()
    }
  })
})
