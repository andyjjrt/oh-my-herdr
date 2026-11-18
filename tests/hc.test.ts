// The herdr-core (`hc`) backend: its pure parts, and a worker started through the mod with hc
// mocked at the process boundary. The disk is in memory; the plugin's own files come from disk.

import { describe, expect, mock, test } from 'claude-code/testing'

import { resolveBackend, watchArgv } from '../hooks/lib/backend'
import { backendSettingOf } from '../hooks/lib/actions'
import { normalizeConfig } from '../hooks/lib/config'
import { optionsOf, rt } from '../hooks/lib/runtime'
import { hcAddress, hcPane, isHcPane, pathKey, runArgs, statusOfTerminal, tabId } from '../hooks/lib/hc'

describe('hc: pure parts', () => {
  test('a terminal reads as the state machine expects', () => {
    expect(statusOfTerminal({ state: 'live', status: { app: 'claude-code', state: 'working' } })).toBe('working')
    expect(statusOfTerminal({ state: 'live', status: { state: 'done' } })).toBe('done')
    expect(statusOfTerminal({ state: 'live', status: { state: 'blocked', kind: 'permission' } })).toBe('blocked')
    expect(statusOfTerminal({ state: 'live', status: { state: 'error' } })).toBe('blocked')
    expect(statusOfTerminal({ state: 'live', status: { state: 'thinking' } })).toBe('unknown')
    expect(statusOfTerminal({ state: 'live', status: null })).toBe('none')
    expect(statusOfTerminal({ state: 'finished', status: { state: 'idle' } })).toBe('gone')
  })

  test('pane ids carry the backend', () => {
    expect(hcPane('t7')).toBe('hc:t7')
    expect(isHcPane('hc:box/t7')).toBe(true)
    expect(isHcPane('w1:p3')).toBe(false)
    expect(hcAddress('hc:box/t7')).toBe('box/t7')
    expect(watchArgv('/w.py', 'hc:t7', 'a')).toEqual(['python3', '-I', '/w.py', '--backend', 'hc', '--pane', 't7', '--name', 'a'])
    expect(watchArgv('/w.py', 'w1:p3', 'a')).toEqual(['python3', '-I', '/w.py', '--pane', 'w1:p3', '--name', 'a'])
  })

  test('the backend: auto picks herdr inside herdr, hc elsewhere; herdr outside herdr is an error', () => {
    expect(resolveBackend('auto', { inHerdr: true, inHc: false })).toEqual({ kind: 'herdr' })
    expect(resolveBackend('auto', { inHerdr: false, inHc: true })).toEqual({ kind: 'hc' })
    expect(resolveBackend('hc', { inHerdr: true, inHc: false })).toEqual({ kind: 'hc' })
    expect('error' in resolveBackend('herdr', { inHerdr: false, inHc: true })).toBe(true)
  })

  test('hc run: in the background, outliving the lead, quiet, with env and labels before the program', () => {
    const a = runArgs({ name: 'fix', cwd: '/work', argv: ['claude', '--model', 'opus'], env: { PATH: '/bin', OMH_ROLE: 'worker' }, labels: { 'omh.worker': 'fix' }, notify: false }, true)
    expect(a).toEqual(['--bg', '--outlive-parent', '--no-notify', '--cwd', '/work', '--name', 'omh-fix', '--label', 'omh.worker=fix', '--', 'env', 'PATH=/bin', 'OMH_ROLE=worker', 'claude', '--model', 'opus'])
    const b = runArgs({ name: 'x'.repeat(40), cwd: '/w', argv: ['pi'], env: {}, labels: {}, notify: true }, true)
    expect(b).not.toContain('--no-notify')
    expect(b[b.indexOf('--name') + 1]!.length).toBe(32)
    expect(runArgs({ name: 'fix', cwd: '/w', argv: ['pi'], env: {}, labels: {}, notify: true }, false)).not.toContain('--name')
  })

  test('omh tabs are per project and numbered', () => {
    expect(pathKey('/a')).toBe(pathKey('/a'))
    expect(pathKey('/a')).not.toBe(pathKey('/b'))
    expect(tabId('/a', 2)).toBe(`tbomh${pathKey('/a')}w2`)
  })

  test('config: backend defaults to auto, hc to quiet tabs', () => {
    const d = normalizeConfig('/c.json', {}, {})
    expect(d.backend).toBe('auto')
    expect(d.hc).toEqual({ notify: false, panes: 'tab' })
    const c = normalizeConfig('/c.json', { backend: 'hc', hc: { notify: true, panes: 'none' } }, {})
    expect(c.backend).toBe('hc')
    expect(c.hc).toEqual({ notify: true, panes: 'none' })
    expect(normalizeConfig('/c.json', { backend: 'tmux' }, {}).backend).toBe('auto')
  })

  test('backend: the plugin option applies unless config.json names one', () => {
    const saved = rt.options
    try {
      expect(optionsOf({}).backend).toBe('auto')
      expect(optionsOf({ backend: 'tmux' }).backend).toBe('auto')
      rt.options = optionsOf({ backend: 'hc' })
      expect(backendSettingOf(normalizeConfig('/c.json', {}, {}))).toBe('hc')
      expect(backendSettingOf(normalizeConfig('/c.json', { backend: 'auto' }, {}))).toBe('hc')
      expect(backendSettingOf(normalizeConfig('/c.json', { backend: 'herdr' }, {}))).toBe('herdr')
    } finally {
      rt.options = saved
    }
  })
})

// ------------------------------------------------------------------ through the mod

const AGENTS = { claude: { launch: 'herdr-kind', kind: 'claude', bin: 'claude' } }
const CONFIG = {
  max_panes_per_tab: 2,
  profiles: { 'claude-sonnet': { agent: 'claude', family: 'claude', args: ['--model', 'sonnet'] } },
  categories: { quick: ['claude-sonnet'], explore: ['claude-sonnet'] },
}

type Mem = Map<string, string>
type Run = { exitCode: number; stdout: string }

function disk(on: any, mem: Mem) {
  const ASSET = /\/skills\/oh-my-herdr\/assets\/(agents|config\.default)\.json$/
  const asset = (p: string) => {
    const m = ASSET.exec(p)?.[1]
    return m === undefined ? undefined : JSON.stringify(m === 'agents' ? AGENTS : CONFIG)
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
  on('http.fetch', () => {
    throw new Error('offline')
  })
}

/** hc at the process boundary: `answer` decides each command's reply; every argv is recorded. */
function hcMock(on: any, answer: (argv: string[]) => Run | undefined) {
  const runs: string[][] = []
  const watched: string[][] = []
  on('process.run', (_$: any, e: any) => {
    const argv = [...e.argv] as string[]
    runs.push(argv)
    if (argv[0] === 'rm') return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const r = answer(argv) ?? { exitCode: 1, stdout: '' }
    return { value: { ...r, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_$: any, e: any) {
    watched.push([...e.argv])
    yield { stream: 'stdout', text: `${JSON.stringify({ name: 'w', status: 'idle', ts: 1 })}\n` }
    await new Promise(() => undefined) // the watcher stays open
    return { code: 0, signal: null }
  })
  return { runs, watched }
}

async function lead($: any, on: any, env: Record<string, string>) {
  mock.env(on, { HOME: '/home/u', PATH: '/usr/local/bin:/usr/bin', ...env })
  const clock = mock.clock(on)
  const tools: string[] = []
  on('tool.register', (_$: any, e: any) => {
    tools.push(e.name)
    return { value: { tool: `mcp__oh-my-herdr__${e.name}` } }
  })
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()
  return { clock, tools }
}

const json = (v: unknown): Run => ({ exitCode: 0, stdout: JSON.stringify(v) })
const isHc = (argv: string[], cmd: string) => argv[0] === 'hc' && argv[1] === cmd

describe('hc: through the mod', () => {
  test('in an hc terminal (a Herdr app pane) the mod wakes; in an hc worker it stays dormant', async ($, on) => {
    disk(on, new Map())
    hcMock(on, () => undefined)
    const { tools } = await lead($, on, { HC_TERMINAL_ID: 't1' })
    expect(tools.sort()).toEqual(['omh_collect', 'omh_dispatch', 'omh_spawn', 'omh_status', 'omh_teardown'])
  })

  test('an hc worker (OMH_ROLE=worker) registers nothing', async ($, on) => {
    disk(on, new Map())
    hcMock(on, () => undefined)
    const { tools } = await lead($, on, { HC_TERMINAL_ID: 't9', OMH_ROLE: 'worker' })
    expect(tools).toEqual([])
  })

  test('omh_spawn starts an hc terminal in an omh tab of the lead space, waits for ready, watches it', async ($, on) => {
    const mem: Mem = new Map()
    disk(on, mem)
    const hc = hcMock(on, argv => {
      if (isHc(argv, 'get') && argv.includes('t1')) return json({ address: 't1', state: 'live', labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tb1' } })
      if (isHc(argv, 'ls')) return json({ terminals: [] })
      if (isHc(argv, 'run')) return json({ address: 't9', state: 'live' })
      if (argv[0] === 'sh' && argv.at(-1) === 't9') return { exitCode: 0, stdout: 'idle\n' }
      return undefined
    })
    await lead($, on, { HC_TERMINAL_ID: 't1' })
    const r = await $.tool.call({ tool: 'mcp__oh-my-herdr__omh_spawn', name: 'fix', profile: 'claude-sonnet' } as never)
    expect(String((r as any).result)).not.toContain('ERROR')

    const run = hc.runs.find(a => isHc(a, 'run'))!
    expect(run).toContain('--outlive-parent')
    expect(run).toContain('--no-notify')
    expect(run).toContain('herdr.space=sp1')
    expect(run.some(a => a.startsWith('herdr.tab=tbomh'))).toBe(true)
    const program = run.slice(run.indexOf('--') + 1)
    expect(program[0]).toBe('env')
    expect(program).toContain('PATH=/usr/local/bin:/usr/bin')
    expect(program).toContain('OMH_ROLE=worker')
    expect(program.slice(-3)).toEqual(['claude', '--model', 'sonnet'])
    // herdr is never asked for a pane.
    expect(hc.runs.some(a => a[0] === 'herdr')).toBe(false)

    expect(JSON.parse(mem.get('/work/.omh/agents/fix.json')!).pane).toBe('hc:t9')
    expect(hc.watched[0]).toContain('--backend')
    expect(hc.watched[0]).toContain('t9')
  })

  test('outside the Herdr app (no herdr.space label) the worker gets no tab labels', async ($, on) => {
    disk(on, new Map())
    const hc = hcMock(on, argv => {
      if (isHc(argv, 'get') && argv.includes('t1')) return json({ address: 't1', state: 'live', labels: {} })
      if (isHc(argv, 'run')) return json({ address: 't9' })
      if (argv[0] === 'sh') return { exitCode: 0, stdout: 'idle\n' }
      return undefined
    })
    await lead($, on, { HC_TERMINAL_ID: 't1' })
    await $.tool.call({ tool: 'mcp__oh-my-herdr__omh_spawn', name: 'fix', profile: 'claude-sonnet' } as never)
    const run = hc.runs.find(a => isHc(a, 'run'))!
    expect(run.some(a => a.startsWith('herdr.'))).toBe(false)
  })

  test('a worker stuck at a dialog during startup is reported with its screen', async ($, on) => {
    disk(on, new Map())
    hcMock(on, argv => {
      if (isHc(argv, 'run')) return json({ address: 't9' })
      if (argv[0] === 'sh') return { exitCode: 3, stdout: 'blocked\n' }
      if (isHc(argv, 'read')) return { exitCode: 0, stdout: 'Is this a project you trust?\n' }
      return undefined
    })
    await lead($, on, { HC_TERMINAL_ID: 't1' })
    const r = String((await $.tool.call({ tool: 'mcp__oh-my-herdr__omh_spawn', name: 'fix', profile: 'claude-sonnet' } as never) as any).result)
    expect(r).toContain('did not become ready in hc:t9')
    expect(r).toContain('trust')
  })

  test('a free hc worker that last reported done is reused: the brief goes by hc send, no new terminal', async ($, on) => {
    const mem: Mem = new Map([
      ['/work/.omh/agents/old.json', JSON.stringify({ name: 'old', category: 'explore', profile: 'claude-sonnet', family: 'claude', agent: 'claude', pane: 'hc:t5', cwd: '/work', run: null, task: null, task_dir: null })],
    ])
    disk(on, mem)
    const hc = hcMock(on, argv => {
      if (isHc(argv, 'get') && argv.includes('t5')) return json({ address: 't5', state: 'live', status: { app: 'claude-code', state: 'done' } })
      if (isHc(argv, 'send')) return json({ started: true })
      return undefined
    })
    await lead($, on, { HC_TERMINAL_ID: 't1' })
    const r = String((await $.tool.call({ tool: 'mcp__oh-my-herdr__omh_dispatch', task: 'scout-auth', intent: 'explore', rationale: 'look-up', brief: 'Find the session check.' } as never) as any).result)
    expect(r).not.toContain('ERROR')
    const send = hc.runs.find(a => isHc(a, 'send'))!
    expect(send).toContain('t5')
    expect(send.at(-1)).toContain('/work/.omh/runs/_scout/scout-auth/brief.md')
    expect(hc.runs.some(a => isHc(a, 'run'))).toBe(false)
  })

  test('a `working` the watcher never repeats is not a stall: the pane is asked before alerting', async ($, on) => {
    const mem: Mem = new Map([
      ['/work/.omh/agents/old.json', JSON.stringify({ name: 'old', category: 'explore', profile: 'claude-sonnet', family: 'claude', agent: 'claude', pane: 'hc:t5', cwd: '/work', run: null, task: null, task_dir: null })],
    ])
    disk(on, mem)
    // hc reports `working` once, right as the prompt is sent; the watcher (hcMock) only ever said idle.
    let state = 'done'
    hcMock(on, argv => {
      if (isHc(argv, 'get') && argv.includes('t5')) return json({ address: 't5', state: 'live', status: { app: 'claude-code', state } })
      if (isHc(argv, 'send')) {
        state = 'working'
        return json({ started: true })
      }
      return undefined
    })
    const sent: string[] = []
    on('prompt.submit', (_$: any, e: any) => {
      sent.push(e.text)
      return { text: e.text }
    })
    const { clock } = await lead($, on, { HC_TERMINAL_ID: 't1' })
    await $.tool.call({ tool: 'mcp__oh-my-herdr__omh_dispatch', task: 'scout-auth', intent: 'explore', rationale: 'look-up', brief: 'Find the session check.' } as never)
    await clock.advance(120_000)
    expect(sent.join('\n')).not.toContain('stalled')
    expect(JSON.parse(mem.get('/work/.omh/runs/_scout/scout-auth/dispatch.json')!).outcome).toBeNull()
    const show = String((await $.tool.call({ tool: 'mcp__oh-my-herdr__omh_status', action: 'recheck', task: 'scout-auth' } as never) as any).result)
    expect(show).toContain('live status working; phase stays running')
  })

  test('backend "herdr" outside herdr refuses to spawn and says why', async ($, on) => {
    const mem: Mem = new Map([['/work/.omh/config.json', JSON.stringify({ ...CONFIG, backend: 'herdr' })]])
    disk(on, mem)
    hcMock(on, () => undefined)
    await lead($, on, { HC_TERMINAL_ID: 't1' })
    const r = String((await $.tool.call({ tool: 'mcp__oh-my-herdr__omh_spawn', name: 'fix', profile: 'claude-sonnet' } as never) as any).result)
    expect(r).toContain('needs the lead inside herdr')
  })
})
