import { describe, expect, test } from 'bun:test'

import { toastsBetween } from '../../src/tui/toasts'
import { sampleRun, snap, worker } from './fixtures'

describe('toasts', () => {
  test('a worker that becomes blocked raises a warning toast once', () => {
    const before = snap({ workers: { w2: worker('w2', 'running', 'T4') } })
    const after = snap({ workers: { w2: worker('w2', 'blocked', 'T4') } })
    const toasts = toastsBetween(before, after)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ title: 'omh: w2 is blocked', variant: 'warning' })
    expect(toasts[0]!.message).toContain('task T4')
    expect(toastsBetween(after, after)).toEqual([])
  })

  test('the first snapshot is a baseline; a dead worker is an error', () => {
    expect(toastsBetween(null, snap({ workers: { w2: worker('w2', 'blocked') } }))).toEqual([])
    const t = toastsBetween(snap(), snap({ workers: { w9: worker('w9', 'gone', 'T3') } }))
    expect(t).toMatchObject([{ title: 'omh: w9 died', variant: 'error' }])
  })

  test('a settled wave', () => {
    const run = sampleRun()
    const settled = { ...run, waves: run.waves.map(w => (w.id === 2 ? { ...w, tasks: w.tasks.map(t => ({ ...t, status: 'reported' as const })) } : w)) }
    const t = toastsBetween(snap({ run }), snap({ run: settled }))
    expect(t).toMatchObject([{ title: 'omh: wave 2 settled', variant: 'success' }])
    expect(toastsBetween(snap({ run: settled }), snap({ run: settled }))).toEqual([])
  })

  test('nothing when the server part goes quiet', () => {
    expect(toastsBetween(snap(), null)).toEqual([])
  })
})
