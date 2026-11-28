// Manual T12 two-project storage check. Create a session, claim the lead with omh_status, print it.
// Not a bun:test file.

import { OpenCode } from '@opencode/client'

const baseUrl = process.env.OMH_SMOKE_URL ?? 'http://127.0.0.1:4615'
const password = process.env.OMH_SMOKE_PASSWORD ?? 'spike'
const dir = process.env.OMH_SMOKE_DIR ?? '/tmp/omh-two-A'
const model = (process.env.OMH_SMOKE_MODEL ?? 'opencode-go/deepseek-v4.1-flash').split('/')

const client = OpenCode.make({
  baseUrl,
  headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
})

const session = await client.session.create({
  location: { directory: dir },
  agent: 'omh',
  model: { providerID: model[0]!, id: model.slice(1).join('/') },
})
await client.session.command({
  sessionID: session.id,
  name: 'omh',
  text: 'status',
})
await new Promise(resolve => setTimeout(resolve, 1000))
const context = await client.session.context({ sessionID: session.id })
console.log(JSON.stringify({ sessionID: session.id, text: context.map((m: any) => String(m.text ?? '')).filter(Boolean).slice(0, 3) }, null, 2))
