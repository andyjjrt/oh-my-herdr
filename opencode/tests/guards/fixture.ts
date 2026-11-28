// Capture the hooks installGuards/installContinue/installCompaction register, and a fixture that
// seeds a bound run with a working worker owning one file.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { approveRun, draftPlan, writePlan } from '../../../core/actions'
import { writeJson } from '../../../core/files'
import { refreshRun, rt } from '../../../core/runtime'
import { newWorker } from '../../../core/settle'
import type { Engine } from '../../../core/host'
import type { ServerContext } from '../../src/server/index'
import { setup, waitFor, type Fake } from '../server/fake'

type Hooks = Record<'tool' | 'permission' | 'session', Map<string, Array<(event: any) => Promise<void>>>>
export type Captured = Hooks

export function capture(ctx: ServerContext): Captured {
  const hooks: Hooks = { tool: new Map(), permission: new Map(), session: new Map() }
  for (const domain of ['tool', 'permission', 'session'] as const) {
    const target = (ctx as any)[domain]
    target.hook = async (name: string, fn: (event: any) => Promise<void>) => {
      const list = hooks[domain].get(name) ?? []
      list.push(fn)
      hooks[domain].set(name, list)
    }
  }
  return hooks
}

export async function fire(hooks: Captured, domain: keyof Captured, name: string, event: any): Promise<void> {
  for (const fn of hooks[domain].get(name) ?? []) await fn(event)
}

export const PANE_CONFIG = {
  profiles: { go: { agent: 'senpi', family: 'deepseek', args: [] } },
  categories: { deep: ['go'], explore: ['go'] },
}

export const SUBAGENT_CONFIG = {
  profiles: {
    go: { agent: 'senpi', family: 'deepseek', args: [] },
    sub: { agent: 'oc-subagent', family: 'opencode', subagent_type: 'Explore', model: 'haiku' },
  },
  categories: { deep: ['go'], explore: ['sub'] },
}

export async function writeConfig(root: string, config: unknown): Promise<void> {
  await mkdir(join(root, '.omh'), { recursive: true })
  await writeFile(join(root, '.omh/config.json'), `${JSON.stringify(config, null, 2)}\n`)
}

export async function startGuards(config: unknown | null = PANE_CONFIG) {
  const { fake, engine, opts } = await setup({ tools: false, commands: false })
  if (config !== null) await writeConfig(fake.root, config)
  const hooks = capture(fake.context)
  return { fake, engine, opts, hooks }
}

/**
 * Bind a run with task t1 owning owned.ts. With `worker`, task t1 is working and owned by w1;
 * without, it is pending and free.
 */
export async function seedRun(engine: Engine, opts: { worker?: boolean } = {}): Promise<{ run: string; root: string }> {
  if (!rt.paths) throw new Error('not booted')
  const root = rt.paths.root
  const draft = await draftPlan('# Guard run\n\nGoal: guard the worker-owned file.\n', 'guard')
  if (!draft.ok) throw new Error(draft.text)
  const approved = await approveRun()
  if (!approved.ok) throw new Error(approved.text)
  const plan = await writePlan({
    goal: 'Guard run',
    waves: [
      {
        id: 1,
        gate: 'tests pass',
        tasks: [{ id: 't1', title: 'Task one', intent: 'implement', category: 'deep', owns: ['owned.ts'], deps: [] }],
      },
    ],
  })
  if (!plan.ok) throw new Error(plan.text)
  const run = rt.paths.boundRun
  if (run === null) throw new Error('approve did not bind')
  if (opts.worker === true) {
    await writeJson(engine, rt.paths.dispatch(run, 't1'), {
      task: 't1',
      worker: 'w1',
      profile: 'go',
      family: 'deepseek',
      model: 'deepseek-v4.1-flash',
      intent: 'implement',
      category: 'deep',
      rationale: 'test fixture',
      override: false,
      warnings: [],
      dispatchedAt: 1,
      retries: 0,
      outcome: null,
      diagnose: null,
    })
    await engine.state.workers.set(all => ({
      ...all,
      w1: {
        ...newWorker({ name: 'w1', pane: 'w1:p2', profile: 'go', family: 'deepseek', agent: 'senpi' }),
        phase: 'running',
        task: 't1',
        run,
      },
    }))
  }
  await refreshRun()
  engine.lead.session = 'ses_lead'
  return { run, root }
}

/** Let the compaction hook's clock.after(0) run. */
export async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 10))
}

export { waitFor }
export type { Fake }
