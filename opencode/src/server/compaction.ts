// T6: after compaction, put the run's board back into the lead's context, matching the Claude Code
// session.compact hook. The append is queued after the hook returns so it cannot recursively join
// the compaction request that is being built.

import type { Engine } from '../../../core/host'
import { refreshRun, workers } from '../../../core/runtime'
import { statusText } from '../../../core/text'

type CompactionEvent = { sessionID: string; agent?: string }

export type CompactionHost = {
  session: { hook: (name: string, fn: (event: any) => Promise<void>) => Promise<void> }
}

export async function appendBoard(engine: Engine): Promise<void> {
  const run = await refreshRun()
  if (run === null) return
  await engine.session.append({
    message: {
      type: 'user',
      content: [
        {
          type: 'text',
          text: `[oh-my-herdr] Board after compaction — trust this over memory:\n\n${statusText(run, await workers())}`,
        },
      ],
    },
  })
}

export async function installCompaction(ctx: CompactionHost, engine: Engine): Promise<void> {
  await ctx.session.hook('compaction', async (raw: unknown) => {
    const event = raw as CompactionEvent
    if (engine.lead.session === null || event.sessionID !== engine.lead.session) return
    engine.clock.after(0, () => {
      void appendBoard(engine).catch(err => engine.ui.log(`oh-my-herdr: board after compaction failed: ${(err as Error).message}`))
    })
  })
}
