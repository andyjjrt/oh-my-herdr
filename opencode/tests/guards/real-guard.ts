// Manual T6 real guard driver: bind the scratch project to an approved run, ask the lead to dispatch
// t1 (which owns owned.ts), then ask it to edit that file and print the denial the model received.
// Not a bun:test file.

import { OpenCode } from '@opencode/client'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const baseUrl = process.env.OMH_SMOKE_URL ?? 'http://127.0.0.1:4614'
const password = process.env.OMH_SMOKE_PASSWORD ?? 'spike'
const dir = process.env.OMH_SMOKE_DIR ?? '/tmp/omh-oc-real'
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
console.log(JSON.stringify({ event: 'session', sessionID: session.id }))

await client.session.prompt({
  sessionID: session.id,
  delivery: 'queue',
  text: 'Call omh_status with action "show" once, then end your turn.',
})

const runDir = join(dir, '.omh/runs/20261128-guard')
for (let i = 0; i < 120; i++) {
  const lead = existsSync(join(runDir, 'lead.json')) ? JSON.parse(await readFile(join(runDir, 'lead.json'), 'utf8')) : null
  if (lead?.session === session.id) break
  await new Promise(resolve => setTimeout(resolve, 500))
}

await client.session.prompt({
  sessionID: session.id,
  delivery: 'queue',
  text: [
    'Call omh_dispatch exactly once with:',
    'task: t1',
    'intent: implement',
    'category: deep',
    'rationale: the guard smoke needs a live owner',
    'brief: Create owned.ts with the text "owned by t1". Do not edit any other file.',
    'Then end your turn. Do not wait or poll.',
  ].join('\n'),
})

let agents: string[] = []
for (let i = 0; i < 240; i++) {
  const agentsDir = join(dir, '.omh/agents')
  agents = existsSync(agentsDir) ? await readdir(agentsDir) : []
  if (agents.length > 0) break
  await new Promise(resolve => setTimeout(resolve, 500))
}
console.log(JSON.stringify({ event: 'agents', agents }))

await client.session.prompt({
  sessionID: session.id,
  delivery: 'queue',
  text: [
    'Call the edit tool exactly once on /tmp/omh-oc-real/owned.ts.',
    'Replace the exact text "owned by t1" with "lead edit".',
    'Do not use any other tool. After the tool returns, reply with the tool result or error verbatim and stop.',
  ].join('\n'),
})

let denial = ''
let raw: any[] = []
for (let i = 0; i < 120; i++) {
  raw = await client.session.context({ sessionID: session.id }).catch(() => [])
  for (const message of raw) {
    if (message?.type !== 'assistant' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      const text = JSON.stringify(part)
      if (text.includes('belongs to task t1')) denial = text
    }
    const text = String(message.text ?? '')
    if (text.includes('belongs to task t1')) denial = text
  }
  if (denial !== '') break
  await new Promise(resolve => setTimeout(resolve, 500))
}

console.log(JSON.stringify({ event: 'denial', denial: denial.slice(0, 2000), messageCount: raw.length }, null, 2))
if (!denial.includes('belongs to task t1')) process.exitCode = 1
