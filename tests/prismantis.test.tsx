// Drawing through prismantis when it is installed, and the plain drawing when it is not.

import { describe, expect, mock, test } from 'claude-code/testing'

type Drawn = { type: string; props: Record<string, unknown>; children: unknown[] }
const textOf = (d: unknown): string =>
  typeof d === 'string' || typeof d === 'number' ? String(d) : d && typeof d === 'object' && 'children' in d ? (d as Drawn).children.map(textOf).join('\n') : ''

const REPORT = '===== T1 (/work/.omh/runs/r1/T1/result.md) =====\n## Done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n=====\nThis report is the worker\'s claim.'

const RESULT = (output: string, isExpanded: boolean) =>
  ({
    plugin: 'oh-my-herdr',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool: 'mcp__oh-my-herdr__omh_collect', input: { task: 'T1' }, output, isErrored: false, isExpanded },
  }) as never

/** The engine's own drawing, beneath the mod. */
function engine(on: any) {
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

/** A stand-in for prismantis: its noun on $, drawing `md:<text>`. */
function prismantis(on: any, seen: string[]) {
  on('engine.create', async (_$: any, e: any, next: any) => ({ ...(await next(e)), prismantis: { markdown: async () => undefined } }))
  on('prismantis.markdown', ($: any, e: any) => {
    seen.push(e.text)
    const { Text } = $.ui.resolve({ surface: e.surface, component: 'AssistantMessage' })
    return { value: <Text>md:{e.text}</Text> }
  })
}

async function lead($: any, on: any) {
  mock.env(on, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HOME: '/home/u' })
  mock.clock(on)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

describe('expanded omh_collect with prismantis', () => {
  test('the report body is drawn as markdown between the header and the note', async ($, on) => {
    const seen: string[] = []
    prismantis(on, seen)
    engine(on)
    await lead($, on)
    const ui = await $.ui.mount(RESULT(REPORT, true))
    const text = textOf(await ui.drawn())
    expect(seen).toEqual(['## Done\n\n| a | b |\n|---|---|\n| 1 | 2 |'])
    expect(text).toContain('T1 (/work/.omh/runs/r1/T1/result.md)')
    expect(text).toContain('md:\n## Done')
    expect(text).toContain("This report is the worker's claim.")
    expect(text).not.toContain('=====')
    await ui.unmount()
  })

  test('collapsed, it stays one line', async ($, on) => {
    const seen: string[] = []
    prismantis(on, seen)
    engine(on)
    await lead($, on)
    const ui = await $.ui.mount(RESULT(REPORT, false))
    expect(textOf(await ui.drawn())).toContain('===== T1')
    expect(seen).toEqual([])
    await ui.unmount()
  })
})

describe('without prismantis', () => {
  test('an expanded result is the engine\'s own drawing', async ($, on) => {
    engine(on)
    await lead($, on)
    const ui = await $.ui.mount(RESULT(REPORT, true))
    expect(textOf(await ui.drawn())).toBe('engine')
    await ui.unmount()
  })
})

describe('/omh plan pane', () => {
  const PLAN = '# Ship it\n\n| Task | Owns |\n|---|---|\n| T1 | a.ts |\n'
  /** A disk holding only a pre-0.4 draft, .omh/plan.md (the preview falls back to it). */
  function disk(on: any) {
    on('fs.stat', (_$: any, e: any) => {
      if (e.path === '/work/.omh/plan.md') return { value: { kind: 'file', size: PLAN.length } }
      throw new Error('ENOENT')
    })
    on('fs.read', (_$: any, e: any) => {
      if (e.path === '/work/.omh/plan.md') return { value: PLAN }
      throw new Error('ENOENT')
    })
  }
  const PANE = { plugin: 'oh-my-herdr', surface: 'terminal', component: 'Pane', requestId: 'omh-plan', props: { title: 'plan.md', isFocused: false, bodyColumns: 60, placement: 'dock' } } as never

  test('draws an old .omh/plan.md through prismantis under its path', async ($, on) => {
    const seen: string[] = []
    prismantis(on, seen)
    disk(on)
    engine(on)
    await lead($, on)
    const ui = await $.ui.mount(PANE)
    const text = textOf(await ui.drawn())
    expect(text).toContain('/work/.omh/plan.md')
    expect(seen).toEqual([PLAN])
    await ui.unmount()
  })

  test('without prismantis, plan.md shows as plain text in the same pane', async ($, on) => {
    disk(on)
    engine(on)
    await lead($, on)
    const ui = await $.ui.mount(PANE)
    const text = textOf(await ui.drawn())
    expect(text).toContain('/work/.omh/plan.md')
    expect(text).toContain('# Ship it')
    await ui.unmount()
  })
})
