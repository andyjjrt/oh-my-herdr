// Manual T5 scout-wake driver: ask the active opencode lead to dispatch one herdr scout, then wait
// for the synthetic settle wake. Kept out of `bun test` (it needs a live opencode server and panes).

import { OpenCode } from '@opencode/client'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const baseUrl = process.env.OMH_SMOKE_URL ?? 'http://127.0.0.1:4614'
const password = process.env.OMH_SMOKE_PASSWORD ?? 'spike'
const dir = process.env.OMH_SMOKE_DIR ?? '/tmp/omh-oc-real'
const sessionID = process.env.OMH_SMOKE_SESSION
const scout = process.env.OMH_SCOUT_NAME ?? 'scout-smoke-wake'
if (!sessionID) throw new Error('OMH_SMOKE_SESSION is required')

const client = OpenCode.make({
  baseUrl,
  headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
})

if (process.env.OMH_SCOUT_NO_PROMPT !== '1') {
  await client.session.prompt({
    sessionID,
    delivery: 'queue',
    text: [
      'Dispatch exactly one scout now with omh_dispatch, then end your turn.',
      `task: ${scout}`,
      'intent: explore',
      'category: explore',
      'rationale: verify the T5 scout wake path',
      'brief: Reply with exactly SCOUT_DONE and nothing else. Do not edit any file. You are a read-only smoke-test scout.',
    ].join('\n'),
  })
}

const deadline = Date.now() + 240_000
let dispatch = false
let wake = ''
while (Date.now() < deadline) {
  dispatch ||= existsSync(join(dir, '.omh/runs/_scout', scout, 'dispatch.json'))
  const context = await client.session.context({ sessionID }).catch(() => [])
  wake =
    context
      .filter((m: any) => m.type === 'synthetic')
      .map((m: any) => String(m.text ?? ''))
      .find((text: string) => text.includes('Scouts are back') && text.includes(scout)) ?? ''
  if (wake !== '') break
  await new Promise(resolve => setTimeout(resolve, 1000))
}

const scoutFiles = existsSync(join(dir, '.omh/runs/_scout', scout))
  ? await readdir(join(dir, '.omh/runs/_scout', scout))
  : []
console.log(JSON.stringify({ dispatch, scoutFiles, wake: wake.slice(0, 2000) }, null, 2))
if (!dispatch || wake === '') process.exitCode = 1
