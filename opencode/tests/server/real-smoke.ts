// Manual T5 real-run driver (not a bun:test file): starts a session against a private opencode
// 2.4.2 server, invokes /ulw, and waits for .omh/runs to appear. Used by the T5 acceptance smoke.

import { OpenCode } from '@opencode/client'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const baseUrl = process.env.OMH_SMOKE_URL ?? 'http://127.0.0.1:4614'
const password = process.env.OMH_SMOKE_PASSWORD ?? 'spike'
const dir = process.env.OMH_SMOKE_DIR ?? '/tmp/omh-oc-real'
const model = (process.env.OMH_SMOKE_MODEL ?? 'openai/gpt-6.1-sol').split('/')

const client = OpenCode.make({
  baseUrl,
  headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
})

const session = await client.session.create({
  location: { directory: dir },
  agent: 'omh',
  model: { providerID: model[0]!, id: model.slice(1).join('/') },
})
console.log(JSON.stringify({ event: 'session', sessionID: session.id, dir, model: model.join('/') }))

await client.session.command({
  sessionID: session.id,
  name: 'ulw',
  text: 'hello from the T5 smoke test',
})

const deadline = Date.now() + 300_000
let runs: string[] = []
while (Date.now() < deadline) {
  const root = join(dir, '.omh/runs')
  if (existsSync(root)) {
    const fs = await import('node:fs/promises')
    const all = await fs.readdir(root).catch(() => [])
    runs = all.filter(name => name !== '_scout')
    if (runs.length > 0) break
  }
  await new Promise(resolve => setTimeout(resolve, 500))
}

const context = await client.session.context({ sessionID: session.id }).catch(() => [])
console.log(JSON.stringify({ event: 'result', sessionID: session.id, runs, context: context.map((m: any) => ({ type: m.type, text: String(m.text ?? '').slice(0, 500), content: m.content?.length ?? 0 })) }, null, 2))
if (runs.length === 0) process.exitCode = 1
