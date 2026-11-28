// Worker-file ownership: a file with a lead field is ours exactly when it names this session; a
// file without it belongs to a session outside herdr/hc from its own checkout.

import { describe, expect, test } from 'bun:test'

import { ownsWorker, Paths, runWorkerName } from '../files'

describe('ownsWorker', () => {
  const unbound = new Paths('/work', '/work/.omh')
  const bound = new Paths('/work.worktrees/r1', '/work/.omh', 'r1')
  const w = (o: Partial<Parameters<typeof ownsWorker>[0]>) => ({ name: 'w', category: null, profile: 'p', family: 'f', agent: 'a', pane: 'x', cwd: '/work', run: null, task: null, task_dir: null, ...o })
  test('a file with lead is ours exactly when it names this session; cwd, run and name do not matter', () => {
    expect(ownsWorker(w({ lead: 'w1:p1', run: 'r9', cwd: '/elsewhere' }), unbound, 'w1:p1')).toBe(true)
    expect(ownsWorker(w({ lead: 'w1:p1', name: runWorkerName('r1', 'x'), cwd: '/work.worktrees/r1/' }), bound, 'w1:p1')).toBe(true)
    expect(ownsWorker(w({ lead: 'w2:p2' }), unbound, 'w1:p1')).toBe(false)
    expect(ownsWorker(w({ lead: 'w1:p1' }), unbound, null)).toBe(false)
  })
  test('a file without lead is owned only by a session outside herdr and hc, from its own checkout (trailing slash aside)', () => {
    expect(ownsWorker(w({}), unbound, null)).toBe(true)
    expect(ownsWorker(w({ cwd: '/work/' }), unbound, null)).toBe(true)
    expect(ownsWorker(w({ cwd: '/work/packages/api' }), unbound, null)).toBe(false)
    expect(ownsWorker(w({ run: 'r9' }), unbound, null)).toBe(true)
    expect(ownsWorker(w({}), unbound, 'w1:p1')).toBe(false)
    // No "run-less worker in a bound checkout" rule any more.
    expect(ownsWorker(w({ cwd: '/work.worktrees/r1' }), bound, 'w1:p1')).toBe(false)
  })
})

