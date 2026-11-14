// The status line under the prompt: its pieces, and the line as each surface draws it.

import { describe, expect, test } from 'claude-code/testing'

import { contextBar as bar, limitsOf, prettyModel, shortPath, splitHint } from '../hooks/lib/statusbar'

describe('pieces', () => {
  test('the mode pill becomes one icon; the rest of the line stays', () => {
    const a = splitHint('⏵⏵ auto mode on (shift+tab to cycle)')
    expect(a.mode?.name).toBe('auto')
    expect(a.rest).toBe('')
    const b = splitHint('⏸ plan mode on (shift+tab to cycle) · esc to interrupt')
    expect(b.mode?.name).toBe('plan')
    expect(b.rest).toBe('esc to interrupt')
    const c = splitHint('? for shortcuts')
    expect(c.mode).toBe(null)
    expect(c.rest).toBe('')
    expect(splitHint('⏵⏵ accept edits on (shift+tab to cycle)').mode?.name).toBe('acceptEdits')
    expect(splitHint('Press Ctrl-C again to exit').rest).toBe('Press Ctrl-C again to exit')
    // What the terminal actually hands over: its mode pill is drawn outside the hint.
    expect(splitHint('(shift+tab to cycle) · ← for agents').rest).toBe('')
    expect(splitHint('(shift+tab to cycle) · esc to interrupt').rest).toBe('esc to interrupt')
  })
  test('model ids read as names', () => {
    expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(prettyModel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(prettyModel('claude-fable-5-2[1m]')).toBe('Fable 5.2')
    expect(prettyModel('claude-opus-4-20250514')).toBe('Opus 4')
    expect(prettyModel('opus')).toBe('Opus')
  })
  test('paths', () => {
    expect(shortPath('/home/u/codes/x', '/home/u')).toBe('~/codes/x')
    expect(shortPath('/home/u', '/home/u')).toBe('~')
    expect(shortPath('/home/u/a/very/long/path/that/goes/on/and/on/project', '/home/u').length).toBeLessThanOrEqual(32)
    expect(shortPath('/home/u/a/very/long/path/that/goes/on/and/on/project', '/home/u').endsWith('/project')).toBe(true)
  })
  test('quota figures survive a response without rate-limit headers', () => {
    const last = [{ kind: 'five_hour', percent: 70 }, { kind: 'seven_day', percent: 9 }]
    expect(limitsOf([], last)).toEqual(last)
    expect(limitsOf([{ kind: 'seven_day', percentUsed: 10 }, { kind: 'five_hour', percentUsed: 74 }], last)).toEqual([
      { kind: 'five_hour', percent: 74 },
      { kind: 'seven_day', percent: 10 },
    ])
    expect(limitsOf([{ kind: 'spend_limit', percentUsed: 3 }], [])).toEqual([])
  })
  test('bar', () => {
    expect(bar(0)).toBe('░░░░░░░░░░')
    expect(bar(31)).toBe('███░░░░░░░')
    expect(bar(150)).toBe('██████████')
  })
})

const HINT = {
  plugin: 'oh-my-herdr',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '⏵⏵ auto mode on (shift+tab to cycle)' },
} as const

const INFO = {
  cwd: '~/codes/github/oh-my-herdr',
  branch: 'main',
  model: 'Opus 5.5',
  contextPercent: 31,
  limits: [
    { kind: 'five_hour', percent: 12 },
    { kind: 'seven_day', percent: 93 },
  ],
}

test('the line on terminal and desktop', async ($, on) => {
  on('state.get', ($, e) => (e.key === 'statusbar' ? { value: { value: { shape: 'statusbar-1', value: INFO }, version: 1 } } : undefined) as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HINT, surface } as never)
    const line = await ui.find({ type: 'Text', text: /Opus 5\.5/ })
    expect(line?.text).toBe('⏵ Opus 5.5 · ~/codes/github/oh-my-herdr  main · ███░░░░░░░ 31% · 12%/93%')
    // The line replaces the engine's on purpose; its mode pill and hints are folded in.
    expect(await ui.keepsBeneath()).toBe(false)
    await ui.unmount()
  }
})

test('before anything is known the engine draws its own line', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' } as never)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})
