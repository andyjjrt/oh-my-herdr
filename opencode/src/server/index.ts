// The opencode server part. One plugin setup per server process: bind the process-wide core to an
// Engine, register the five tools and two commands, and run the same reattach/approval/quota timers
// the Claude Code mod starts at session start. T6/T7 fill in the guard, continue, compaction and
// subagent seams; T8 adds the TUI part that talks to this server over RPC.

import { Plugin } from '@opencode/plugin'

import type { Engine, EnvName, Options, Timer } from '../../../core/host'
import { Paths } from '../../../core/files'
import { config, dropLostBinding, flushWake, otherLiveLead, readLead, reconcile, refreshQuota, refreshRun, rt, stopWatcher, writeLeadFile } from '../../../core/runtime'
import { pollApprovals } from '../../../core/actions'
import { optionsOf } from '../../../core/runtime'
import { installCommands, type CommandHost } from './commands'
import { installRpc, type RpcHost } from '../rpc/server'
import { installCompaction, type CompactionHost } from './compaction'
import { installContinue, type ContinueHost } from './continue'
import { createEngine, ENV_NAMES, stateCells } from './engine'
import { installGuards, type GuardHost } from './guards'
import { claimLead } from './lead'
import { createSubagentCapability, type SubagentHost } from './subagent'
import { installTools, type ToolHost } from './tools'
import { resetWakeGuard, wakeLead } from './wake'

type PluginDefinition = Parameters<typeof Plugin.define>[0]
export type ServerContext = Parameters<PluginDefinition['setup']>[0]

let activeCleanup: (() => Promise<void>) | null = null

async function envOf(engine: Engine): Promise<Partial<Record<EnvName, string>>> {
  const out: Partial<Record<EnvName, string>> = {}
  for (const name of ENV_NAMES) {
    const value = await engine.env.get(name)
    if (value !== undefined && value !== '') (out as Record<string, string>)[name] = value
  }
  return out
}

async function git(engine: Engine, args: string[], at: string): Promise<string> {
  const r = await engine.process.run(['git', ...args], { cwd: at }).catch(() => null)
  return r !== null && r.exitCode === 0 ? r.stdout.trim() : ''
}

/** Stop timers and watchers, then forget the binding. Safe to call when nothing is active. */
export function resetRuntime(): void {
  for (const timer of [rt.wakeTimer, rt.pollTimer]) timer?.cancel()
  rt.wakeTimer = null
  rt.pollTimer = null
  for (const name of [...rt.watchers.keys()]) stopWatcher(name)
  rt.watchers.clear()
  for (const timer of rt.timers.values()) timer.cancel()
  rt.timers.clear()
  rt.queues.clear()
  rt.wakeGuards.clear()
  rt.subagentEnds.clear()
  rt.paneSeen.clear()
  rt.stallRechecked.clear()
  rt.versions = null
  rt.$ = null
  rt.paths = null
  rt.cfg = null
  rt.cfgError = null
  rt.selfPane = null
  rt.selfTerminal = null
  rt.scoutKey = ''
  resetWakeGuard()
}

/**
 * Bind this process to the project. Unlike the Claude Code mod it does not require herdr: a
 * headless /ulw can still draft and approve a run, and dispatch explains the backend error if no
 * pane backend exists. A worker pane (OMH_ROLE=worker) stays dormant.
 */
export async function boot(context: ServerContext, engine: Engine, options: Options): Promise<boolean> {
  resetRuntime()
  const env = await envOf(engine)
  if (env.OMH_ROLE === 'worker') {
    const service = process.argv.some(arg => arg === 'serve' || arg === '--service')
    engine.ui.log(
      service
        ? 'oh-my-herdr: DORMANT opencode serve/service inherited OMH_ROLE=worker from the pane that started it. Start the lead with its own `opencode`, not through a shared service; otherwise every lead attached to this service has no tools and no guards.'
        : 'oh-my-herdr: dormant because OMH_ROLE=worker: this process is an opencode worker, not the lead.',
    )
    return false
  }
  const cwd = context.location.directory
  const toplevel = await git(engine, ['rev-parse', '--show-toplevel'], cwd)
  const root = toplevel || cwd
  const common = (await git(engine, ['rev-parse', '--path-format=absolute', '--git-common-dir'], root)).replace(/\/+$/, '')
  const main = common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : root
  const omh = env.OMH_DIR || `${main}/.omh`
  // opencode's kv store is shared by every project in one user data dir, and one .omh can serve a
  // main checkout, its worktrees, and several panes. A CC lead has one state store per process;
  // this key gives an opencode lead the same isolation: .omh + root + pane (root only without a
  // herdr/hc pane).
  const storageScope = engine.lead.pane === null ? `${omh}\u0000${root}` : `${omh}\u0000${root}\u0000${engine.lead.pane}`
  engine.state = stateCells(context, storageScope)
  type Stored = { run: string; root: string } | { run: null } | null
  const stored = (await engine.state.bound.get()) as Stored
  const fromEnv = env.OMH_RUN?.trim() || null
  const seeded = stored == null && fromEnv !== null && !(await engine.fs.exists(`${omh}/runs/${fromEnv}/closed.json`)) ? fromEnv : null
  const keptRun = stored != null && stored.run !== null && !(await engine.fs.exists(`${omh}/runs/${stored.run}/closed.json`)) ? stored.run : null
  const bound = seeded !== null ? { run: seeded, root } : keptRun !== null ? { run: keptRun, root } : null
  rt.$ = engine
  rt.options = options
  rt.paths = new Paths(root, omh, bound?.run ?? null)
  if (seeded !== null) await engine.state.bound.set(() => ({ run: seeded, root }))
  else if (stored != null && stored.run !== null && keptRun === null) await engine.state.bound.set(() => ({ run: null }))
  rt.watchPy = `${engine.plugin.root}/skills/oh-my-herdr/scripts/omh-watch.py`
  rt.selfPane = env.HERDR_PANE_ID ?? null
  rt.selfTerminal = env.HC_TERMINAL_ID ?? null
  // A kept or seeded binding is written again: the pane or root may be new. A run another live
  // session took over meanwhile is dropped instead.
  const own = seeded ?? keptRun
  if (own !== null) {
    if (keptRun !== null && seeded === null && (await otherLiveLead(keptRun)) !== null) {
      rt.paths = new Paths(root, omh)
    } else {
      // Read the session before core rewrites lead.json without it.
      const recorded = await readLead(own).catch(() => null)
      await writeLeadFile(own, root)
      const session = (recorded as { session?: unknown } | null)?.session
      if (typeof session === 'string' && session !== '' && (recorded!.pane === engine.lead.pane || recorded!.pane === null)) {
        engine.lead.session = session
        await claimLead(session)
      }
    }
  }
  await config().catch(() => undefined)
  return true
}

function logFailure(engine: Engine, what: string, err: unknown): void {
  engine.ui.log(`oh-my-herdr: ${what}: ${(err as Error).message}`)
}

async function startTimers(context: ServerContext, engine: Engine): Promise<Timer[]> {
  const timers: Timer[] = []
  timers.push(
    engine.clock.after(0, () => {
      void (async () => {
        await reconcile()
        await refreshRun()
        if (rt.$?.lead.session) await flushWake()
        await refreshQuota()
      })().catch(err => logFailure(engine, 'start failed', err))
    }),
  )
  timers.push(
    engine.clock.every(7_000, () => {
      void (async () => {
        await dropLostBinding()
        for (const drop of await pollApprovals()) {
          engine.ui.log(`oh-my-herdr: ${drop.text}`)
          const session = rt.$?.lead.session ?? null
          if (drop.wake !== undefined && session !== null) await wakeLead(context, session, drop.wake)
        }
      })().catch(() => undefined)
    }),
  )
  timers.push(
    engine.clock.every(120_000, () => {
      void (async () => {
        if ((await engine.state.run.get()) !== null) await refreshQuota()
      })().catch(() => undefined)
    }),
  )
  return timers
}

export default Plugin.define({
  id: 'oh-my-herdr',
  async setup(context) {
    await activeCleanup?.()
    activeCleanup = null
    const options = optionsOf(context.options)
    const engine = createEngine(context, options)
    const subagent = createSubagentCapability(context as unknown as SubagentHost)
    engine.subagent = subagent
    const active = await boot(context, engine, options)
    if (!active) return
    await installTools(context as unknown as ToolHost)
    await installCommands(context as unknown as CommandHost)
    // The TUI part's channel (src/tui): immediate /omh answers and the board/status snapshot.
    const rpc = await installRpc(context as unknown as RpcHost).catch(err => {
      logFailure(engine, 'TUI RPC not registered', err)
      return undefined
    })
    const registered = (await context.tool.list()).map(tool => tool.name).filter(name => name.startsWith('omh_'))
    console.error(`[oh-my-herdr] tools: ${registered.join(', ')}`)
    await installGuards(context as unknown as GuardHost)
    await installContinue(context as unknown as ContinueHost, engine)
    await installCompaction(context as unknown as CompactionHost, engine)
    const timers = await startTimers(context, engine)
    const cleanup = async () => {
      subagent.dispose()
      for (const timer of timers) timer.cancel()
      await rpc?.dispose().catch(() => undefined)
      if (rt.$ === engine) resetRuntime()
    }
    activeCleanup = cleanup
    return cleanup
  },
})
