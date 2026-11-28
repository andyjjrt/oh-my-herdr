// The herdr-core (hc) backend's pure parts: status parsing, pane ids, argv and layout.
// The same cases through the Claude Code mod stay in claudecode/tests/hc.test.ts.

import { describe, expect, test } from 'bun:test'

import { resolveBackend, watchArgv } from '../backend'
import { backendSettingOf } from '../actions'
import { normalizeConfig } from '../config'
import { optionsOf, rt } from '../runtime'
import { hcAddress, hcPane, isHcPane, pathKey, runArgs, statusOfTerminal, tabId } from '../hc'

describe('hc: pure parts', () => {
  test('a terminal reads as the state machine expects', () => {
    expect(statusOfTerminal({ state: 'live', status: { app: 'some-app', state: 'working' } })).toBe('working')
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

