import { describe, expect, test } from 'bun:test'

import { EMPTY_SNAPSHOT } from '../../src/rpc/protocol'
import { boardLines, quotaHint, statusLine } from '../../src/tui/view'
import { quota, sampleRun, snap, worker } from './fixtures'

describe('status line', () => {
  test('quiet with no server part, a dormant server, or no run', () => {
    expect(statusLine(null)).toBeNull()
    expect(statusLine(EMPTY_SNAPSHOT)).toBeNull()
    expect(statusLine(snap({ run: null }))).toBeNull()
    // A plan with no current wave (all gates passed) draws nothing either, like Claude Code's.
    expect(statusLine(snap({ run: { ...sampleRun(), current: null } }))).toBeNull()
  })

  test('a sample run: run, progress, wave x/y, task states', () => {
    expect(statusLine(snap())).toBe('omh demo ██░░░░ 2/5 · W2/3 · ●1 ◆1 ⚠1')
  })

  test('quota hint only when a provider is near or at its limit', () => {
    expect(statusLine(snap({ quota: { a: quota('anthropic', 40) } }))).toBe('omh demo ██░░░░ 2/5 · W2/3 · ●1 ◆1 ⚠1')
    expect(statusLine(snap({ quota: { a: quota('anthropic', 91.6), o: quota('opencode-go', 10, true) } }))).toBe('omh demo ██░░░░ 2/5 · W2/3 · ●1 ◆1 ⚠1 · quota anthropic 92% opencode-go limit')
    expect(quotaHint({})).toBeNull()
  })
})

describe('board', () => {
  test('no run', () => {
    expect(boardLines(snap({ run: null })).map(l => l.text)).toEqual(['No run in progress. /ulw <goal> starts one.'])
    expect(boardLines(null)[0]!.text).toContain('not active')
  })

  test('a sample run with workers and quota', () => {
    const lines = boardLines(snap({ workers: { w2: worker('w2', 'blocked', 'T4') }, quota: { a: quota('anthropic', 55) } }))
    const text = lines.map(l => l.text)
    expect(text.slice(0, 3)).toEqual(['Port omh to opencode', '20261127-demo', '✓ Wave 1 — gate: tests pass'])
    expect(text).toContain('▶ Wave 2 — gate: tui works')
    expect(text).toContain('   ⚠ T4 tui → w2 (opencode-go) — permission prompt')
    expect(lines.find(l => l.text.includes('w2 blocked'))!.tone).toBe('warning')
    expect(text.at(-1)).toBe('quota: anthropic 55%')
  })
})
