// A task routed to a subagent profile, end to end through the mod: dispatch starts a subagent,
// its turn's end saves the answer as result.md, its own notification is held back, and the lead
// is woken once the scouts are back. The disk is in memory; the plugin's own files come from disk.

import { describe, expect, mock, test } from 'claude-code/testing'

// The harness loads code files only, so the plugin's JSON assets are given here in brief.
const AGENTS = { claude: { launch: 'herdr-kind', kind: 'claude' }, subagent: { launch: 'subagent' } }
const DEFAULT_CONFIG = {
  profiles: {
    'claude-sonnet': { agent: 'claude', family: 'claude', args: ['--model', 'sonnet'] },
    'sub-explore': { agent: 'subagent', family: 'claude', subagent_type: 'Explore', model: 'haiku' },
    'sub-haiku': { agent: 'subagent', family: 'claude', subagent_type: 'general-purpose', model: 'haiku' },
  },
  categories: { explore: ['sub-explore', 'claude-sonnet'], librarian: ['sub-haiku'], quick: ['sub-haiku'] },
}

type Mem = Map<string, string>

/** The project and $HOME in memory, with the plugin's two assets the mod reads (agents.json, the default config). */
function disk(on: any, mem: Mem) {
  const ASSET = /\/skills\/oh-my-herdr\/assets\/(agents|config\.default)\.json$/
  const asset = (p: string) => {
    const m = ASSET.exec(p)?.[1]
    return m === undefined ? undefined : JSON.stringify(m === 'agents' ? AGENTS : DEFAULT_CONFIG)
  }
  const dirOf = (p: string) => [...mem.keys()].some(k => k.startsWith(`${p.replace(/\/$/, '')}/`))
  on('fs.read', (_$: any, e: any) => {
    const text = asset(e.path) ?? mem.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$: any, e: any) => {
    mem.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$: any, e: any) => ({ value: asset(e.path) !== undefined || mem.has(e.path) || dirOf(e.path) }))
  on('fs.stat', (_$: any, e: any) => {
    if (mem.has(e.path)) return { value: { kind: 'file', size: mem.get(e.path)!.length } }
    if (dirOf(e.path)) return { value: { kind: 'dir', size: 0 } }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.list', (_$: any, e: any) => {
    const dir = `${e.path.replace(/\/$/, '')}/`
    const names = new Set([...mem.keys()].filter(k => k.startsWith(dir)).map(k => k.slice(dir.length).split('/')[0]!))
    return { value: [...names].map(name => ({ name, kind: mem.has(dir + name) ? 'file' : 'dir', size: 0 })) }
  })
  // rm -f is the only command that matters here; herdr, quota probes and the rest fail quietly.
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] === 'rm') mem.delete(e.argv[e.argv.length - 1])
    return { value: { exitCode: e.argv[0] === 'rm' ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', () => {
    throw new Error('offline')
  })
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
}

async function lead($: any, on: any) {
  mock.env(on, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HOME: '/home/u' })
  const clock = mock.clock(on)
  on('tool.register', (_$: any, e: any) => ({ value: { tool: `mcp__oh-my-herdr__${e.name}` } }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()
  return clock
}

const TASK_DIR = '/work/.omh/runs/_scout/scout-auth'
const RESULT = `${TASK_DIR}/result.md`

/** A scout out with subagent ag1, as the files stand after a dispatch (and as a reload finds them). */
function seedRunningScout(mem: Mem, agentId: string) {
  mem.set(
    '/work/.omh/agents/scout-auth.json',
    JSON.stringify({ name: 'scout-auth', category: 'explore', profile: 'sub-explore', family: 'claude', agent: 'subagent', pane: `agent:${agentId}`, cwd: '/work', run: '_scout', task: 'scout-auth', task_dir: TASK_DIR }),
  )
  mem.set(
    `${TASK_DIR}/dispatch.json`,
    JSON.stringify({ task: 'scout-auth', worker: 'scout-auth', profile: 'sub-explore', family: 'claude', model: 'Explore haiku', intent: 'explore', category: 'explore', rationale: 'r', override: false, warnings: [], dispatchedAt: 0, retries: 0, outcome: null, diagnose: null }),
  )
  mem.set(`${TASK_DIR}/brief.md`, 'brief')
}

/** Records what the lead is sent (wake-ups) and lets every prompt through. */
function prompts(on: any): string[] {
  const sent: string[] = []
  on('prompt.submit', (_$: any, e: any) => {
    sent.push(e.text)
    return { text: e.text }
  })
  return sent
}

describe('dispatching to a subagent profile', () => {
  test('starts a subagent of the routed type and model with the brief; nothing is left behind when none starts', async ($, on) => {
    const mem: Mem = new Map()
    disk(on, mem)
    const spawned: any[] = []
    // Under test no Agent tool runs, so no agentId comes back: the dispatch must undo itself.
    on('agent.spawn', (_$: any, e: any) => {
      spawned.push(e)
      return { model: 'haiku' }
    })
    await lead($, on)
    const r = await $.tool.call({ tool: 'mcp__oh-my-herdr__omh_dispatch', task: 'scout-auth', intent: 'explore', rationale: 'read-only look-up', brief: 'Find where sessions are checked.' } as never)
    expect(spawned.length).toBe(1)
    expect(spawned[0].subagent_type).toBe('Explore')
    expect(spawned[0].run_in_background).toBe(true)
    expect(spawned[0].model).toBe('haiku')
    expect(spawned[0].description).toBe('omh scout-auth')
    expect(spawned[0].prompt).toContain(`${TASK_DIR}/brief.md`)
    const brief = mem.get(`${TASK_DIR}/brief.md`)!
    expect(brief).toContain('Find where sessions are checked.')
    expect(brief).toContain('Your final reply is your report')
    expect(brief).not.toContain('DONE ')
    expect(String((r as any).result)).toContain('ERROR: the subagent for scout-auth did not start')
    expect(mem.has(`${TASK_DIR}/dispatch.json`)).toBe(false)
    expect(mem.has('/work/.omh/agents/scout-auth.json')).toBe(false)
  })

  test('omh_spawn never starts a subagent profile ahead of time', async ($, on) => {
    disk(on, new Map())
    await lead($, on)
    const r = await $.tool.call({ tool: 'mcp__oh-my-herdr__omh_spawn', name: 'early', profile: 'sub-haiku' } as never)
    expect(String((r as any).result)).toContain('runs as a subagent, which starts with its task')
  })
})

describe('a running subagent worker', () => {
  test('its answer becomes result.md, its own notification is held back, and the lead is woken once', async ($, on) => {
    const mem: Mem = new Map()
    disk(on, mem)
    seedRunningScout(mem, 'ag1')
    on('agent.list', () => ({ value: [{ id: 'ag1', description: 'omh scout-auth', type: 'Explore', status: 'running' }] }))
    const sent = prompts(on)
    const clock = await lead($, on)

    const held = await $.prompt.submit({ text: '<task-notification><task-id>ag1</task-id></task-notification>', origin: { kind: 'task-notification' } } as never)
    expect((held as any).drop).toContain('ag1')
    const other = await $.prompt.submit({ text: '<task-notification><task-id>zz9</task-id></task-notification>', origin: { kind: 'task-notification' } } as never)
    expect((other as any).drop).toBe(undefined)

    sent.length = 0
    await $.turn.complete({ agentId: 'ag1', reason: 'answer', answer: '## Found\n- src/auth.ts:12 checks the session', durationMs: 5, isAborted: false, turnId: 't1' } as never)
    await clock.advance(3000)
    expect(mem.get(RESULT)).toBe('## Found\n- src/auth.ts:12 checks the session\n')
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('Scouts are back')
    expect(sent[0]).toContain('| scout-auth | scout-auth (sub-explore) | reported |')
  })

  test('a BLOCKED answer writes no result and wakes the lead with the reason', async ($, on) => {
    const mem: Mem = new Map()
    disk(on, mem)
    seedRunningScout(mem, 'ag2')
    on('agent.list', () => ({ value: [{ id: 'ag2', description: 'omh scout-auth', type: 'Explore', status: 'running' }] }))
    const sent = prompts(on)
    const clock = await lead($, on)
    sent.length = 0
    await $.turn.complete({ agentId: 'ag2', reason: 'answer', answer: 'BLOCKED: the repo is not readable', durationMs: 5, isAborted: false, turnId: 't2' } as never)
    await clock.advance(3000)
    expect(mem.has(RESULT)).toBe(false)
    const text = sent.join('\n')
    expect(text).toContain('worker `scout-auth` (task scout-auth) is **gone**')
    expect(text).toContain('BLOCKED: the repo is not readable')
  })

  test('another subagent ending changes nothing', async ($, on) => {
    const mem: Mem = new Map()
    disk(on, mem)
    seedRunningScout(mem, 'ag3')
    on('agent.list', () => ({ value: [{ id: 'ag3', description: 'omh scout-auth', type: 'Explore', status: 'running' }] }))
    const sent = prompts(on)
    const clock = await lead($, on)
    sent.length = 0
    await $.turn.complete({ agentId: 'other', reason: 'answer', answer: 'hi', durationMs: 5, isAborted: false, turnId: 't3' } as never)
    await clock.advance(3000)
    expect(mem.has(RESULT)).toBe(false)
    expect(sent).toEqual([])
  })
})

describe('file ownership with a subagent worker', () => {
  test('the subagent that owns a file may edit it; the lead and other subagents may not', async ($, on) => {
    const mem: Mem = new Map()
    disk(on, mem)
    const dir = '/work/.omh/runs/r1/T1'
    mem.set('/work/.omh/current-run', 'r1')
    mem.set(
      '/work/.omh/runs/r1/plan.json',
      JSON.stringify({ goal: 'g', waves: [{ id: 1, gate: 'tests pass', tasks: [{ id: 'T1', title: 'auth', intent: 'implement', category: 'quick', owns: ['src/auth.ts'], deps: [] }] }] }),
    )
    mem.set('/work/.omh/agents/w1-t1.json', JSON.stringify({ name: 'w1-t1', category: 'quick', profile: 'sub-haiku', family: 'claude', agent: 'subagent', pane: 'agent:ag7', cwd: '/work', run: 'r1', task: 'T1', task_dir: dir }))
    mem.set(`${dir}/dispatch.json`, JSON.stringify({ task: 'T1', worker: 'w1-t1', profile: 'sub-haiku', family: 'claude', model: 'general-purpose haiku', intent: 'implement', category: 'quick', rationale: 'r', override: false, warnings: [], dispatchedAt: 0, retries: 0, outcome: null, diagnose: null }))
    on('agent.list', () => ({ value: [{ id: 'ag7', description: 'omh T1', type: 'general-purpose', status: 'running' }] }))
    on('tool.call', (_$: any, e: any) => ({ result: `edited by ${e.agentId ?? 'lead'}` }))
    await lead($, on)

    const edit = (agentId?: string) =>
      $.tool.call({ tool: 'Edit', file_path: '/work/src/auth.ts', old_string: 'a', new_string: 'b', ...(agentId !== undefined && { agentId }) } as never)
    expect(String((await edit('ag7')).result)).toBe('edited by ag7')
    expect(String(((await edit()) as any).deny)).toContain('belongs to task T1')
    expect(String(((await edit('ag9')) as any).deny)).toContain('belongs to task T1')
  })
})

describe("the lead's own Agent calls", () => {
  /** The lead, and every Agent call that got past the mod (its model), or the refusal. */
  async function calls($: any, on: any, config: unknown, inputs: Record<string, unknown>[]) {
    const mem: Mem = new Map(config === undefined ? [] : [['/home/u/.config/oh-my-herdr/config.json', JSON.stringify(config)]])
    disk(on, mem)
    on('tool.call', (_$: any, e: any) => ({ result: `model=${e.model ?? '-'}` }))
    await lead($, on)
    const out: string[] = []
    for (const i of inputs) {
      const r: any = await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', ...i } as never)
      out.push(r.deny !== undefined ? `deny: ${r.deny}` : String(r.result ?? r.text))
    }
    return out
  }

  test('held to the subagent types and models the categories route to', async ($, on) => {
    // The default config here routes explore to Explore · haiku, quick and librarian to general-purpose · haiku.
    const out = await calls($, on, undefined, [
      { subagent_type: 'Explore' },
      { subagent_type: 'Explore', model: 'opus' },
      { subagent_type: 'Explore', model: 'haiku' },
      {},
      { subagent_type: 'Plan' },
    ])
    expect(out.slice(0, 4)).toEqual(['model=haiku', 'model=haiku', 'model=haiku', 'model=haiku'])
    expect(out[4]).toContain("subagent_type 'Plan' is not one the config")
    expect(out[4]).toContain('Explore · haiku')
  })

  test('a config with external agents only refuses every subagent and points at scouts', async ($, on) => {
    const out = await calls($, on, { profiles: DEFAULT_CONFIG.profiles, categories: { explore: ['claude-sonnet'], quick: ['claude-sonnet'] } }, [{ subagent_type: 'Explore', model: 'haiku' }])
    expect(out[0]).toContain('routes no category to a subagent')
    expect(out[0]).toContain('scout-<name>')
  })
})
