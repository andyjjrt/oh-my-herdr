// Several runs in one checkout, driven through the core with the shared fake host: approving one
// run leaves another a draft, and listRuns reports every run's state, goal and owner.
// The Claude Code mod's own plan/approve flow stays in claudecode/tests/plan.test.ts.

import { describe, expect, test } from 'bun:test'

import { approvePlan, listRuns } from '../actions'
import { Paths } from '../files'
import { rt } from '../runtime'
import { fakeHost } from '../testing/fake-host'

type Mem = Map<string, string>

const A = '20261121-alpha'
const B = '20261121-beta'
const ROOT = '/main/.omh'

async function session(mem: Mem, bound: string | null = null) {
  const saved = { $: rt.$, paths: rt.paths, cfg: rt.cfg }
  rt.$ = fakeHost({ files: mem }) as never
  rt.cfg = null
  rt.paths = new Paths(bound === null ? '/main' : '/wt/b', ROOT, bound)
  return () => Object.assign(rt, saved)
}

const seed = (mem: Mem) => {
  mem.set(ROOT + '/current-run', A + '\n')
  mem.set(ROOT + '/runs/' + A + '/draft.md', '# Alpha work\n\nT1\n')
  mem.set(ROOT + '/runs/' + B + '/draft.md', '# Beta work\n\nT1\n')
}

describe('several runs', () => {
  test('two drafts coexist; approving b by id leaves a a draft', async () => {
    const mem: Mem = new Map()
    seed(mem)
    const restore = await session(mem)
    try {
      const r = await approvePlan('beta')
      expect(r).toMatchObject({ ok: true, run: B, file: `${ROOT}/runs/${B}/plan.md` })
      expect(mem.get(`${ROOT}/runs/${B}/plan.md`)).toContain('# Beta work')
      expect(mem.has(`${ROOT}/runs/${B}/draft.md`)).toBe(false)
      expect(mem.has(`${ROOT}/runs/${B}/plan.approved`)).toBe(true)
      // a is untouched, still a draft, still current
      expect(mem.get(`${ROOT}/runs/${A}/draft.md`)).toContain('# Alpha work')
      expect(mem.has(`${ROOT}/runs/${A}/plan.md`)).toBe(false)
      expect(mem.get(`${ROOT}/current-run`)).toBe(`${A}\n`)
    } finally {
      restore()
    }
  })

  test('approve with no id approves this session\'s run; an unknown id lists the drafts', async () => {
    const mem: Mem = new Map()
    seed(mem)
    const restore = await session(mem)
    try {
      const bad = await approvePlan('gamma')
      expect(bad.ok).toBe(false)
      expect(bad.text).toContain(A)
      expect(bad.text).toContain(B)
      const r = await approvePlan()
      expect(r).toMatchObject({ ok: true, run: A })
      expect(mem.get(`${ROOT}/runs/${A}/plan.md`)).toContain('# Alpha work')
      expect(mem.get(`${ROOT}/runs/${B}/draft.md`)).toContain('# Beta work')
    } finally {
      restore()
    }
  })

  test('listRuns shows both runs, their states, goals and whose they are', async () => {
    const mem: Mem = new Map()
    seed(mem)
    const plan = { goal: 'g', waves: [{ id: 1, gate: 'g', tasks: [{ id: 'T1', title: 't', intent: 'implement', category: 'deep', owns: [], deps: [] }] }] }
    const C = '20261120-gamma'
    mem.set(`${ROOT}/runs/${C}/plan.md`, '# Gamma work\n')
    mem.set(`${ROOT}/runs/${C}/plan.json`, JSON.stringify(plan))
    mem.set(`${ROOT}/runs/${C}/gates.json`, JSON.stringify({ passed: [1] }))
    const D = '20261119-delta'
    mem.set(`${ROOT}/runs/${D}/plan.md`, '# Delta work\n')
    mem.set(`${ROOT}/runs/${D}/plan.json`, JSON.stringify(plan))
    mem.set(`${ROOT}/runs/${D}/closed.json`, '{}')
    mem.set(`${ROOT}/runs/_scout/x/brief.md`, 'scout')
    const restore = await session(mem)
    try {
      await approvePlan(B)
      const t = (await listRuns()).text
      const row = (id: string) => t.split('\n').find(l => l.includes(id))!
      expect(row(A)).toContain('draft')
      expect(row(A)).toContain('Alpha work')
      expect(row(A)).toContain('this session')
      expect(row(B)).toContain('approved')
      expect(row(C)).toContain('finished')
      expect(row(C)).toContain('1/1')
      expect(row(D)).toContain('closed')
      expect(t).not.toContain('_scout')
    } finally {
      restore()
    }
  })

})