// Several sessions sharing one .omh, driven through the core with the shared fake host: each has
// its own state, pane and current-run; dispatch, status, teardown, approvals and closing stay
// within the session that owns them. The mod-driven lifecycle stays in claudecode/tests/lifecycle.test.ts.

import { describe, expect, test } from 'bun:test'

import { approveRun, closeRun, dispatch, draftPlan, finishRun, pollApprovals, spawn, status, teardown, writePlan } from '../actions'
import { Paths, runTag } from '../files'
import { draftDigest } from '../plan'
import { currentRun, openRun, paths, reconcile, rt } from '../runtime'
import { fakeHost } from '../testing/fake-host'

const AGENTS = { claude: { launch: 'herdr-kind', kind: 'claude', bin: 'claude' } }
const CONFIG = {
  profiles: { 'claude-sonnet': { agent: 'claude', family: 'claude', args: [] } },
  categories: { deep: ['claude-sonnet'], explore: ['claude-sonnet'] },
}

type Mem = Map<string, string>
type Run = { exitCode: number; stdout: string }

const WT = '/work.worktrees/feat'

const wf = (name: string, o: Record<string, unknown> = {}) =>
  JSON.stringify({ name, category: 'deep', profile: 'claude-sonnet', family: 'claude', agent: 'claude', pane: `w9:${name}`, cwd: '/work', run: null, task: null, task_dir: null, lead: 'w1:p1', ...o })

function herdrAnswers(gone: string[] = []) {
  return (argv: string[]): Run | undefined => {
    if (argv[0] !== 'herdr') return undefined
    if (argv[1] === 'pane' && argv[2] === 'get') return gone.includes(argv[3]!) ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: '{}' }
    if (argv[1] === 'agent' && argv[2] === 'get') return { exitCode: 0, stdout: JSON.stringify({ result: { agent: { agent_status: 'idle' } } }) }
    if (argv[1] === 'tab' && argv[2] === 'create') return { exitCode: 0, stdout: JSON.stringify({ result: { tab: { tab_id: 'T9' }, root_pane: { pane_id: 'P9' } } }) }
    return { exitCode: 0, stdout: '{}' }
  }
}

describe('several sessions, one .omh', () => {
  const A = '20261121-a'
  const B = '20261121-b'
  const OMH = '/work/.omh'
  const PLAN2 = {
    goal: 'Two',
    waves: [
      {
        id: 1,
        gate: 'tests pass',
        tasks: [
          { id: 'T1', title: 'one', intent: 'implement', category: 'deep', owns: ['a.ts'], deps: [] },
          { id: 'T2', title: 'two', intent: 'implement', category: 'deep', owns: ['b.ts'], deps: [] },
        ],
      },
    ],
  }
  const dispatchT = (task: string) => ({ task, intent: 'implement' as const, rationale: 'x', brief: 'do it' })

  type Sess = { host: any; pane: string; root: string; paths: Paths }

  function newSession(mem: Mem, pane: string, root: string): Sess {
    const host = fakeHost({
      files: mem,
      assets: { agents: AGENTS, config: CONFIG },
      env: { HERDR_ENV: '1', HERDR_PANE_ID: pane, HOME: '/home/u' },
      lead: { pane, session: null },
      subagent: { list: async () => [], spawn: async () => ({ deny: 'no subagents' }) },
      process: argv => {
        const r = herdrAnswers()(argv as string[])
        return r ? { exitCode: r.exitCode, stdout: r.stdout, stderr: '' } : undefined
      },
    })
    return { host, pane, root, paths: new Paths(root, OMH) }
  }

  const KEYS = ['$', 'paths', 'cfg', 'selfPane', 'selfTerminal', 'paneSeen', 'wakeGuards', 'watchers', 'options', 'wakeTimer'] as const
  function useSessions() {
    const saved = Object.fromEntries(KEYS.map(k => [k, rt[k]])) as Record<string, any>
    // Make this session the live one; whatever it bound in the meantime stays in its own record.
    const enter = (s: Sess) => {
      rt.$ = s.host
      rt.paths = s.paths
      rt.selfPane = s.pane
      rt.selfTerminal = null
      rt.cfg = null
      rt.paneSeen = new Map()
      rt.wakeGuards = new Map()
      rt.watchers = new Map()
    }
    const leave = (s: Sess) => {
      s.paths = rt.paths!
    }
    return { enter, leave, restore: () => Object.assign(rt, saved) }
  }

  const files = (mem: Mem): Array<{ file: string } & Record<string, any>> =>
    [...mem.entries()].filter(([k]) => k.startsWith(`${OMH}/agents/`)).map(([k, v]) => ({ file: k, ...(JSON.parse(v) as Record<string, any>) }))
  const ownedBy = (mem: Mem, pane: string) => files(mem).filter(f => f.lead === pane)

  /** Run `fn` as session `s`. */
  async function as<T>(sx: ReturnType<typeof useSessions>, s: Sess, fn: () => Promise<T>): Promise<T> {
    sx.enter(s)
    try {
      return await fn()
    } finally {
      sx.leave(s)
    }
  }

  /** A and B, each unbound at first: draft, approve (which binds), plan. */
  async function setup(mem: Mem, rootB: string) {
    const sx = useSessions()
    const a = newSession(mem, 'w1:p1', '/work')
    const b = newSession(mem, 'w2:p2', rootB)
    await as(sx, a, async () => {
      expect((await draftPlan('# A', 'a')).ok).toBe(true)
      const r = await approveRun()
      expect(r.ok).toBe(true)
      expect((await writePlan(PLAN2)).ok).toBe(true)
    })
    await as(sx, b, async () => {
      expect((await draftPlan('# B', 'b')).ok).toBe(true) // B is unbound: it moves the shared current-run
      const r = await approveRun(B)
      expect(r.ok).toBe(true)
      expect((await writePlan(PLAN2)).ok).toBe(true)
    })
    expect(mem.get(`${OMH}/current-run`)).toBe(`${B}\n`)
    return { sx, a, b }
  }

  test('two roots: each binds its own run in its own root; dispatch, status and teardown are independent', async () => {
    const mem: Mem = new Map()
    const { sx, a, b } = await setup(mem, WT)
    try {
      expect(JSON.parse(mem.get(`${OMH}/runs/${A}/lead.json`)!)).toEqual({ pane: 'w1:p1', root: '/work' })
      expect(JSON.parse(mem.get(`${OMH}/runs/${B}/lead.json`)!)).toEqual({ pane: 'w2:p2', root: WT })
      await as(sx, b, async () => expect((await dispatch(dispatchT('T1'))).text).toContain('dispatched T1'))
      await as(sx, a, async () => expect((await dispatch(dispatchT('T1'))).text).toContain('dispatched T1'))
      const bw = ownedBy(mem, 'w2:p2')
      const aw = ownedBy(mem, 'w1:p1')
      expect(bw).toHaveLength(1)
      expect(aw).toHaveLength(1)
      expect(bw[0]).toMatchObject({ cwd: WT, run: B, task: 'T1' })
      expect(aw[0]).toMatchObject({ cwd: '/work', run: A, task: 'T1' })
      expect(bw[0]!.name.startsWith(`${runTag(B)}-`)).toBe(true)
      expect(aw[0]!.name.startsWith(`${runTag(A)}-`)).toBe(true)
      // Status: each shows its own run only.
      const sa = await as(sx, a, async () => (await status()).text)
      const sb = await as(sx, b, async () => (await status()).text)
      expect(sa).toContain(A)
      expect(sa).not.toContain(B)
      expect(sb).toContain(B)
      expect(sb).not.toContain(A)
      // B's teardown closes only B's worker.
      const t = await as(sx, b, async () => (await teardown(undefined)).text)
      expect(t).toContain(bw[0]!.name)
      expect(t).not.toContain(aw[0]!.name)
      expect(ownedBy(mem, 'w2:p2')).toHaveLength(0)
      expect(ownedBy(mem, 'w1:p1')).toHaveLength(1)
      // Closing B (forced) unbinds B only: A stays bound to its run and its worker lives.
      await as(sx, b, async () => {
        expect((await closeRun(B, true)).text).toContain('closed')
        expect(paths().boundRun).toBe(null)
      })
      expect(mem.has(`${OMH}/runs/${B}/closed.json`)).toBe(true)
      expect(mem.has(`${OMH}/runs/${A}/closed.json`)).toBe(false)
      expect(ownedBy(mem, 'w1:p1')).toHaveLength(1)
      await as(sx, a, async () => expect(paths().boundRun).toBe(A))
    } finally {
      sx.restore()
    }
  })

  test('the same root: each dispatches into its own run, and reuse stays within its own lead', async () => {
    const mem: Mem = new Map()
    const { sx, a, b } = await setup(mem, '/work')
    try {
      expect(JSON.parse(mem.get(`${OMH}/runs/${A}/lead.json`)!).root).toBe('/work')
      expect(JSON.parse(mem.get(`${OMH}/runs/${B}/lead.json`)!).root).toBe('/work')
      const idle = (name: string, lead: string) => mem.set(`${OMH}/agents/${name}.json`, wf(name, { lead, pane: `w9:${name}` }))
      // B's idle worker is in the same checkout: A does not take it, it starts its own.
      idle('bidle', 'w2:p2')
      await as(sx, b, async () => reconcile())
      const first = await as(sx, a, async () => (await dispatch(dispatchT('T1'))).text)
      expect(first).toContain('dispatched T1')
      expect(first).not.toContain('→ bidle')
      const aw = ownedBy(mem, 'w1:p1')
      expect(aw).toHaveLength(1)
      expect(aw[0]).toMatchObject({ run: A, task: 'T1', cwd: '/work' })
      expect(JSON.parse(mem.get(`${OMH}/agents/bidle.json`)!)).toMatchObject({ run: null, task: null, lead: 'w2:p2' })
      // Both have an idle worker of their own now: each takes its own, whatever the order.
      idle('aidle', 'w1:p1')
      await as(sx, a, async () => reconcile())
      const second = await as(sx, a, async () => (await dispatch(dispatchT('T2'))).text)
      expect(second).toContain('→ aidle')
      const third = await as(sx, b, async () => (await dispatch(dispatchT('T1'))).text)
      expect(third).toContain('→ bidle')
      expect(JSON.parse(mem.get(`${OMH}/agents/aidle.json`)!)).toMatchObject({ run: A, task: 'T2', lead: 'w1:p1' })
      expect(JSON.parse(mem.get(`${OMH}/agents/bidle.json`)!)).toMatchObject({ run: B, task: 'T1', lead: 'w2:p2' })
      expect(mem.has(`${OMH}/runs/${A}/T2/dispatch.json`)).toBe(true)
      expect(mem.has(`${OMH}/runs/${B}/T1/dispatch.json`)).toBe(true)
      expect(mem.has(`${OMH}/runs/${B}/T2/dispatch.json`)).toBe(false)
      // Teardown with no names: only its own.
      const t = await as(sx, a, async () => (await teardown(undefined)).text)
      expect(t).toContain('aidle')
      expect(t).not.toContain('bidle')
      expect(mem.has(`${OMH}/agents/bidle.json`)).toBe(true)
      expect(mem.has(`${OMH}/agents/aidle.json`)).toBe(false)
    } finally {
      sx.restore()
    }
  })

  test('the same root: a name the other session holds live is refused to spawn', async () => {
    const mem: Mem = new Map()
    const { sx, a, b } = await setup(mem, '/work')
    try {
      await as(sx, b, async () => expect((await spawn({ name: 'shared', category: 'deep', avoidFamilies: [] }) as any).worker?.name).toBe('shared'))
      const r = await as(sx, a, async () => spawn({ name: 'shared', category: 'deep', avoidFamilies: [] }))
      expect((r as any).text).toContain("taken by another lead's live worker")
    } finally {
      sx.restore()
    }
  })

  test('a bound session approving another run is refused; the other session approves it and binds it', async () => {
    const mem: Mem = new Map()
    const { sx, a, b } = await setup(mem, WT)
    try {
      mem.set(`${OMH}/runs/20261121-c/draft.md`, '# C\n')
      const r = await as(sx, a, async () => approveRun('c'))
      expect(r.ok).toBe(false)
      expect(r.text).toContain('another session')
      // B finishes and closes its run, then takes c.
      mem.set(`${OMH}/runs/${B}/gates.json`, JSON.stringify({ passed: [1] }))
      await as(sx, b, async () => {
        expect((await finishRun()).ok).toBe(true)
        expect((await closeRun()).ok).toBe(true)
        const ok = await approveRun('c')
        expect(ok.text).toContain('this session now leads 20261121-c')
        expect(paths().boundRun).toBe('20261121-c')
        expect(paths().root).toBe(WT)
      })
      expect(JSON.parse(mem.get(`${OMH}/runs/20261121-c/lead.json`)!)).toEqual({ pane: 'w2:p2', root: WT })
      await as(sx, a, async () => expect(paths().boundRun).toBe(A))
    } finally {
      sx.restore()
    }
  })

  test('drop file: a run another live session is bound to is left for it; its own poller re-approves it and wakes itself', async () => {
    const mem: Mem = new Map()
    const { sx, a, b } = await setup(mem, WT)
    try {
      mem.set(`${OMH}/runs/${B}/draft.md`, '# B v2\n')
      mem.set(`${OMH}/approvals/${B}`, `${draftDigest('# B v2')}\n`)
      expect(await as(sx, a, async () => pollApprovals())).toEqual([])
      expect(mem.has(`${OMH}/approvals/${B}`)).toBe(true)
      expect(mem.has(`${OMH}/runs/${B}/draft.md`)).toBe(true)
      const done = await as(sx, b, async () => pollApprovals())
      expect(done).toHaveLength(1)
      expect(done[0]).toMatchObject({ run: B })
      expect(done[0]!.wake).toContain('approved again')
      expect(mem.get(`${OMH}/runs/${B}/plan.md`)).toContain('# B v2')
      expect(mem.has(`${OMH}/approvals/${B}`)).toBe(false)
      // A run nobody is bound to: whichever session polls first approves it, binding nobody.
      mem.set(`${OMH}/runs/20261121-c/draft.md`, '# C\n')
      mem.set(`${OMH}/approvals/20261121-c`, `${draftDigest('# C')}\n`)
      const c = await as(sx, a, async () => pollApprovals())
      expect(c).toHaveLength(1)
      expect(c[0]!.wake).toBeUndefined()
      expect(c[0]!.text).toContain('No session leads')
      expect(mem.get(`${OMH}/runs/20261121-c/plan.md`)).toContain('# C')
      expect(mem.has(`${OMH}/runs/20261121-c/lead.json`)).toBe(false)
      await as(sx, a, async () => expect(paths().boundRun).toBe(A))
    } finally {
      sx.restore()
    }
  })

  // ---- S3 fixes: B1, M1, M3, M4 and the minors that reach the sessions

  /** A drafts and approves run `a` (bound, lead.json w1:p1) and derives its plan; C is a second session in the same checkout, unbound. */
  async function aLeadsC(mem: Mem) {
    const sx = useSessions()
    const a = newSession(mem, 'w1:p1', '/work')
    const c = newSession(mem, 'w3:p3', '/work')
    await as(sx, a, async () => {
      expect((await draftPlan('# A', 'a')).ok).toBe(true)
      expect((await approveRun()).ok).toBe(true)
      expect((await writePlan(PLAN2)).ok).toBe(true)
    })
    return { sx, a, c }
  }

  test('B1: a second unbound session neither follows nor steals a run a live lead is bound to; approve X force takes it over', async () => {
    const mem: Mem = new Map()
    const { sx, a, c } = await aLeadsC(mem)
    try {
      expect(mem.get(`${OMH}/current-run`)).toBe(`${A}\n`)
      await as(sx, c, async () => {
        // It does not follow current-run into A's run: no status, no plan view, no dispatch, no approve.
        expect(await openRun()).toBe(null)
        expect(await currentRun()).toBe(null)
        expect((await status()).text).not.toContain(A)
        const d = await dispatch(dispatchT('T1'))
        expect(d.ok).toBe(false)
        expect(d.text).not.toContain('dispatched T1')
        expect((await approveRun()).ok).toBe(false)
        const named = await approveRun(A)
        expect(named.ok).toBe(false)
        expect(named.text).toContain('w1:p1')
        expect(named.text).toContain(`approve ${A} force`)
        expect((await dispatch(dispatchT('T1'))).ok).toBe(false)
      })
      expect(JSON.parse(mem.get(`${OMH}/runs/${A}/lead.json`)!)).toEqual({ pane: 'w1:p1', root: '/work' })
      await as(sx, a, async () => expect(paths().boundRun).toBe(A))
      // force takes it over: lead.json now names C, and A, still bound in memory, loses the run at its next refresh.
      await as(sx, c, async () => {
        const r = await approveRun(A, true)
        expect(r.ok).toBe(true)
        expect(r.text).toContain('this session now leads')
        expect(paths().boundRun).toBe(A)
      })
      expect(JSON.parse(mem.get(`${OMH}/runs/${A}/lead.json`)!).pane).toBe('w3:p3')
      await as(sx, a, async () => {
        await status()
        expect(paths().boundRun).toBe(null)
        expect(JSON.stringify(await rt.$!.state.wake.get())).toContain('taken over by the session in w3:p3')
        // and A's own close no longer reaches into C's run
        expect((await closeRun(A)).ok).toBe(false)
      })
      expect(mem.has(`${OMH}/runs/${A}/closed.json`)).toBe(false)
    } finally {
      sx.restore()
    }
  })

  test('B1: after /omh close unbinds a session, it does not fall back into another live lead\'s current-run', async () => {
    const mem: Mem = new Map()
    const { sx, c } = await aLeadsC(mem)
    try {
      await as(sx, c, async () => {
        expect((await draftPlan('# C', 'c')).ok).toBe(true)
        expect((await approveRun()).ok).toBe(true)
        expect(paths().boundRun).toBe('20261121-c')
        // A's draft moves the shared current-run back to A's run while C is bound to its own
        await rt.$!.fs.write(`${OMH}/current-run`, `${A}\n`)
        expect((await closeRun(undefined, true)).ok).toBe(true)
        expect(paths().boundRun).toBe(null)
        expect(await openRun()).toBe(null)
        expect(await currentRun()).toBe(null)
      })
    } finally {
      sx.restore()
    }
  })

  test('M1: a closed run leaves .omh/status.json and its own status.json goes', async () => {
    const mem: Mem = new Map()
    const { sx, a, b } = await setup(mem, WT)
    try {
      const rows = () => (JSON.parse(mem.get(`${OMH}/status.json`) ?? '{"runs":[]}').runs as { id: string }[]).map(r => r.id)
      await as(sx, a, async () => void (await status()))
      expect(rows()).toContain(B)
      expect(mem.has(`${OMH}/runs/${B}/status.json`)).toBe(true)
      await as(sx, b, async () => expect((await closeRun(B, true)).ok).toBe(true)) // unfinished: forced
      expect(mem.has(`${OMH}/runs/${B}/status.json`)).toBe(false)
      expect(rows()).not.toContain(B)
      await as(sx, a, async () => void (await status()))
      expect(rows()).toEqual([A])
    } finally {
      sx.restore()
    }
  })

  test('M3: a run closed from another session unbinds the lead bound to it, with one wake-up', async () => {
    const mem: Mem = new Map()
    const { sx, a, c } = await aLeadsC(mem)
    try {
      await as(sx, c, async () => expect((await closeRun(A, true)).ok).toBe(true))
      expect(mem.has(`${OMH}/runs/${A}/closed.json`)).toBe(true)
      await as(sx, a, async () => {
        expect(paths().boundRun).toBe(A) // not told yet
        await status()
        expect(paths().boundRun).toBe(null)
        const wake = JSON.stringify(await rt.$!.state.wake.get())
        expect(wake).toContain(`Run ${A} was closed from another session`)
        await status()
        expect(JSON.stringify(await rt.$!.state.wake.get()).split('was closed from another session').length).toBe(2) // once
        expect(await currentRun()).toBe(null)
      })
    } finally {
      sx.restore()
    }
  })

  test('M4: a dropped approval for the drafting lead\'s own run binds and wakes it; a bound session leaves that draft alone', async () => {
    const mem: Mem = new Map()
    const sx = useSessions()
    const a = newSession(mem, 'w1:p1', '/work')
    const b = newSession(mem, 'w2:p2', '/work')
    try {
      // B is bound to its own run b.
      await as(sx, b, async () => {
        expect((await draftPlan('# B', 'b')).ok).toBe(true)
        expect((await approveRun()).ok).toBe(true)
      })
      // A (unbound) drafts x: current-run is x, nobody leads it.
      await as(sx, a, async () => expect((await draftPlan('# X', 'x')).ok).toBe(true))
      expect(mem.get(`${OMH}/current-run`)).toBe('20261121-x\n')
      mem.set(`${OMH}/approvals/20261121-x`, `${draftDigest('# X')}\n`)
      // B is bound elsewhere: it must not approve the drafting lead's run behind its back.
      expect(await as(sx, b, async () => pollApprovals())).toEqual([])
      expect(mem.has(`${OMH}/approvals/20261121-x`)).toBe(true)
      const done = await as(sx, a, async () => {
        const d = await pollApprovals()
        expect(paths().boundRun).toBe('20261121-x')
        return d
      })
      expect(done).toHaveLength(1)
      expect(done[0]!.wake).toContain('You now lead run 20261121-x')
      expect(JSON.parse(mem.get(`${OMH}/runs/20261121-x/lead.json`)!).pane).toBe('w1:p1')
      expect(mem.get(`${OMH}/runs/20261121-x/plan.md`)).toContain('# X')
    } finally {
      sx.restore()
    }
  })

  test('m4: a drop file for a closed run is rejected, not re-approved', async () => {
    const mem: Mem = new Map()
    const { sx, a, c } = await aLeadsC(mem)
    try {
      await as(sx, c, async () => expect((await closeRun(A, true)).ok).toBe(true))
      mem.set(`${OMH}/runs/${A}/draft.md`, '# A again\n')
      mem.set(`${OMH}/approvals/${A}`, `${draftDigest('# A again')}\n`)
      const done = await as(sx, c, async () => pollApprovals())
      expect(done[0]!.text).toContain('closed')
      expect(mem.has(`${OMH}/approvals/${A}.rejected`)).toBe(true)
      expect(mem.has(`${OMH}/approvals/${A}`)).toBe(false)
      expect(mem.get(`${OMH}/runs/${A}/plan.md`)).not.toContain('again')
    } finally {
      sx.restore()
    }
  })

  test('m6: re-approving a run that has a plan.json wakes with "continue the current wave"', async () => {
    const mem: Mem = new Map()
    const { sx, a } = await aLeadsC(mem)
    try {
      await as(sx, a, async () => {
        const r = await approveRun()
        expect(r.wake).toContain('continue the current wave')
        expect(r.wake).not.toContain('Derive the waves')
      })
    } finally {
      sx.restore()
    }
  })

  test('m8: a bound session resets the stale top-level status it wrote while unbound', async () => {
    const mem: Mem = new Map()
    const { sx, a } = await aLeadsC(mem)
    try {
      const top = JSON.parse(mem.get(`${OMH}/status.json`)!)
      expect(top.run).toBe('') // not "a": the summary's own fields belong to no bound session
      expect(top.runs.map((r: { id: string }) => r.id)).toEqual([A])
      await as(sx, a, async () => void (await status()))
    } finally {
      sx.restore()
    }
  })

  test('N7: one .omh run resumes across hosts with the same pane', async () => {
    const mem: Mem = new Map()
    const cc = newSession(mem, 'w1:p1', '/work')
    const oc = newSession(mem, 'w1:p1', '/work')
    const cc2 = newSession(mem, 'w1:p1', '/work')
    const sx = useSessions()
    try {
      const run = await as(sx, cc, async () => {
        expect((await draftPlan('# A\n\nGoal: one run\n', 'a')).ok).toBe(true)
        expect((await approveRun()).ok).toBe(true)
        expect((await writePlan(PLAN2)).ok).toBe(true)
        return (await currentRun())!
      })
      mem.set(`${OMH}/agents/w1.json`, wf('w1', { pane: 'w1:p2', run, task: 'T1', task_dir: `${OMH}/runs/${run}/T1` }))
      await as(sx, cc, async () => {
        await reconcile()
        expect((await status()).text).toContain('T1')
      })

      await as(sx, oc, async () => {
        await reconcile()
        expect((await status()).text).toContain('T1')
        const again = await approveRun(run)
        expect(again.ok).toBe(true)
        expect(paths().boundRun).toBe(run)
        expect((await status()).text).toContain('T1')
      })

      await as(sx, cc2, async () => {
        await reconcile()
        expect((await approveRun(run)).ok).toBe(true)
        expect(paths().boundRun).toBe(run)
        expect((await status()).text).toContain('T1')
      })
    } finally {
      sx.restore()
    }
  })
})

