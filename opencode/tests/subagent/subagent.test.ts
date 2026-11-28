import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { dispatch } from '../../../core/actions'
import { isSubagentProfile, routedSubagents } from '../../../core/config'
import { config, paths, workers } from '../../../core/runtime'
import { createSubagentCapability, type SubagentHost } from '../../src/server/subagent'
import { resetForTest, setup } from '../server/fake'

afterEach(() => {
  resetForTest()
})

type Event = { type: string; data: Record<string, unknown> }

function eventStream() {
  const queue: Event[] = []
  const waiters: Array<() => void> = []
  let closed = false
  return {
    emit(event: Event) {
      queue.push(event)
      waiters.shift()?.()
    },
    close() {
      closed = true
      for (const wake of waiters.splice(0)) wake()
    },
    async *subscribe(options: { signal?: AbortSignal } = {}) {
      while (!closed && !options.signal?.aborted) {
        if (queue.length > 0) {
          yield queue.shift()!
          continue
        }
        await new Promise<void>(resolve => waiters.push(resolve))
      }
    },
  }
}

async function waitForPhase(name: string, phase: string, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const w = (await workers())[name]
    if (w?.phase === phase) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`worker ${name} never reached ${phase}`)
}

async function writeConfig(root: string, value: unknown): Promise<void> {
  await mkdir(join(root, '.omh'), { recursive: true })
  await writeFile(join(root, '.omh', 'config.json'), `${JSON.stringify(value, null, 2)}\n`)
}

async function harness(options: {
  prompt?: (input: any) => Promise<unknown>
  get?: (input: any) => Promise<any>
  subscribe?: (options?: any) => AsyncIterable<any>
  recoverMs?: number
} = {}) {
  const { fake, engine } = await setup({ tools: false, commands: false })
  const events = eventStream()
  const created: any[] = []
  const prompts: any[] = []
  const removed: any[] = []
  const childMessages = [{ type: 'assistant', content: [{ type: 'text', text: 'CHILD_OK' }] }]
  const ctx = fake.context as any

  ctx.session.create = async (input: any) => {
    created.push(input)
    return { id: 'ses_child' }
  }
  ctx.session.prompt = options.prompt ?? (async (input: any) => {
    prompts.push(input)
    return input
  })
  ctx.session.context = async (input: any) => (input.sessionID === 'ses_child' ? childMessages : [])
  ctx.session.get = options.get ?? (async () => ({}))
  ctx.session.remove = async (input: any) => {
    removed.push(input)
  }
  ctx.event.subscribe = options.subscribe ?? events.subscribe
  engine.subagent = createSubagentCapability(ctx as SubagentHost, { recoverMs: options.recoverMs ?? 300 })

  return { fake, engine, events, created, prompts, removed }
}

describe('opencode child-session subagents', () => {
  test('a forced oc-subagent profile creates a child and settles on its answer', async () => {
    const { fake, events, created, prompts } = await harness()
    try {
      await writeConfig(fake.root, {
        profiles: { 'oc-deep': { agent: 'oc-subagent', family: 'deepseek' } },
        categories: { explore: ['oc-deep'] },
      })

      const answer = await dispatch({
        task: 'scout-child',
        intent: 'explore',
        category: 'explore',
        rationale: 'test the opt-in child backend',
        brief: 'Reply with exactly CHILD_OK.',
        profile: 'oc-deep',
      })
      expect(answer.ok).toBe(true)
      expect(created).toHaveLength(1)
      expect(created[0]).toMatchObject({
        agent: 'general',
        model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' },
        location: { directory: fake.root },
      })
      expect(created[0]).not.toHaveProperty('parentID')
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toMatchObject({ sessionID: 'ses_child', delivery: 'queue' })
      expect(prompts[0].text).toContain('result.md')

      events.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_child' } })
      await waitForPhase('scout-child', 'finished')
      expect(await readFile(paths().result('_scout', 'scout-child'), 'utf8')).toContain('CHILD_OK')
    } finally {
      events.close()
      await fake.close()
    }
  })

  test('a failed child settles as gone with no result', async () => {
    const { fake, events } = await harness()
    try {
      await writeConfig(fake.root, {
        profiles: { 'oc-deep': { agent: 'oc-subagent', family: 'deepseek' } },
        categories: { explore: ['oc-deep'] },
      })
      const answer = await dispatch({
        task: 'scout-fail',
        intent: 'explore',
        category: 'explore',
        rationale: 'test failure settlement',
        brief: 'This child will fail.',
        profile: 'oc-deep',
      })
      expect(answer.ok).toBe(true)

      events.emit({
        type: 'session.execution.failed',
        data: { sessionID: 'ses_child', error: { type: 'provider.auth', message: '401' } },
      })
      await waitForPhase('scout-fail', 'gone')
      expect(await readFile(paths().result('_scout', 'scout-fail'), 'utf8').catch(() => '')).toBe('')
    } finally {
      events.close()
      await fake.close()
    }
  })

  test('an interrupted child settles as gone', async () => {
    const { fake, events } = await harness()
    try {
      await writeConfig(fake.root, {
        profiles: { 'oc-deep': { agent: 'oc-subagent', family: 'deepseek' } },
        categories: { explore: ['oc-deep'] },
      })
      expect((await dispatch({ task: 'scout-interrupted', intent: 'explore', category: 'explore', rationale: 'interruption', brief: 'x', profile: 'oc-deep' })).ok).toBe(true)
      events.emit({ type: 'session.execution.interrupted', data: { sessionID: 'ses_child' } })
      await waitForPhase('scout-interrupted', 'gone')
    } finally {
      events.close()
      await fake.close()
    }
  })

  test('a stream that ends with the child session gone settles as failed and is removed', async () => {
    const { fake, events, removed } = await harness({
      get: async () => {
        throw new Error('session not found')
      },
    })
    try {
      await writeConfig(fake.root, {
        profiles: { 'oc-deep': { agent: 'oc-subagent', family: 'deepseek' } },
        categories: { explore: ['oc-deep'] },
      })
      expect((await dispatch({ task: 'scout-stream-end', intent: 'explore', category: 'explore', rationale: 'stream end', brief: 'x', profile: 'oc-deep' })).ok).toBe(true)
      events.close()
      await waitForPhase('scout-stream-end', 'gone')
      expect(removed).toEqual([{ sessionID: 'ses_child' }])
    } finally {
      events.close()
      await fake.close()
    }
  })

  test('a stream end keeps polling a live child past recoverMs and finishes when it succeeds', async () => {
    let first: number | null = null
    const { fake, events, removed } = await harness({
      recoverMs: 100,
      get: async () => {
        first ??= Date.now()
        return Date.now() - first < 600 ? {} : { outcome: 'succeeded' }
      },
    })
    try {
      await writeConfig(fake.root, {
        profiles: { 'oc-deep': { agent: 'oc-subagent', family: 'deepseek' } },
        categories: { explore: ['oc-deep'] },
      })
      expect((await dispatch({ task: 'scout-live', intent: 'explore', category: 'explore', rationale: 'live child', brief: 'x', profile: 'oc-deep' })).ok).toBe(true)
      events.close()
      await waitForPhase('scout-live', 'finished')
      expect(removed).toEqual([])
      expect(await readFile(paths().result('_scout', 'scout-live'), 'utf8')).toContain('CHILD_OK')
    } finally {
      events.close()
      await fake.close()
    }
  })

  test('a stream drop with no outcome yet keeps polling until session.get turns terminal', async () => {
    let calls = 0
    const subscribe = () => ({
      [Symbol.asyncIterator]() {
        return { next: async () => { throw new Error('stream lost') } }
      },
    })
    const { fake } = await harness({
      subscribe,
      recoverMs: 1000,
      get: async () => (++calls === 1 ? {} : { outcome: 'succeeded' }),
    })
    try {
      await writeConfig(fake.root, {
        profiles: { 'oc-deep': { agent: 'oc-subagent', family: 'deepseek' } },
        categories: { explore: ['oc-deep'] },
      })
      expect((await dispatch({ task: 'scout-retry', intent: 'explore', category: 'explore', rationale: 'retry', brief: 'x', profile: 'oc-deep' })).ok).toBe(true)
      await waitForPhase('scout-retry', 'finished')
      expect(calls).toBeGreaterThan(1)
    } finally {
      await fake.close()
    }
  })

  test('a stream error recovers a succeeded child from session.get', async () => {
    const subscribe = () => ({
      [Symbol.asyncIterator]() {
        return { next: async () => { throw new Error('stream lost') } }
      },
    })
    const { fake } = await harness({ subscribe, get: async () => ({ outcome: 'succeeded' }) })
    try {
      await writeConfig(fake.root, {
        profiles: { 'oc-deep': { agent: 'oc-subagent', family: 'deepseek' } },
        categories: { explore: ['oc-deep'] },
      })
      expect((await dispatch({ task: 'scout-recover', intent: 'explore', category: 'explore', rationale: 'recover', brief: 'x', profile: 'oc-deep' })).ok).toBe(true)
      await waitForPhase('scout-recover', 'finished')
      expect(await readFile(paths().result('_scout', 'scout-recover'), 'utf8')).toContain('CHILD_OK')
    } finally {
      await fake.close()
    }
  })

  test('a rejected prompt aborts the stream, removes the child and drops its status', async () => {
    const { fake, engine, removed } = await harness({ prompt: async () => { throw new Error('bad model') } })
    try {
      await writeConfig(fake.root, {
        profiles: { 'oc-deep': { agent: 'oc-subagent', family: 'deepseek' } },
        categories: { explore: ['oc-deep'] },
      })
      const answer = await dispatch({ task: 'scout-rejected', intent: 'explore', category: 'explore', rationale: 'prompt failure', brief: 'x', profile: 'oc-deep' })
      expect(answer.ok).toBe(false)
      expect(removed).toEqual([{ sessionID: 'ses_child' }])
      expect((await engine.subagent!.list()).some(item => item.id === 'ses_child')).toBe(false)
    } finally {
      await fake.close()
    }
  })

  test('a subscribe failure removes the child and drops its status', async () => {
    const subscribe = () => {
      throw new Error('subscribe failed')
    }
    const { fake, engine, removed } = await harness({ subscribe: subscribe as any })
    try {
      await writeConfig(fake.root, {
        profiles: { 'oc-deep': { agent: 'oc-subagent', family: 'deepseek' } },
        categories: { explore: ['oc-deep'] },
      })
      const answer = await dispatch({ task: 'scout-subscribe', intent: 'explore', category: 'explore', rationale: 'subscribe failure', brief: 'x', profile: 'oc-deep' })
      expect(answer.ok).toBe(false)
      expect(removed).toEqual([{ sessionID: 'ses_child' }])
      expect((await engine.subagent!.list()).some(item => item.id === 'ses_child')).toBe(false)
    } finally {
      await fake.close()
    }
  })

  test('the default config routes no category to a child session', async () => {
    const { fake, engine, created } = await harness()
    try {
      const cfg = await config()
      expect(routedSubagents(cfg)).toEqual([])
      expect(isSubagentProfile(cfg, 'sub-explore')).toBe(false)
      expect(isSubagentProfile(cfg, 'oc-subagent')).toBe(false)
      expect('subagent' in engine).toBe(true)
      expect(created).toHaveLength(0)
    } finally {
      await fake.close()
    }
  })

  test('a CC subagent profile is filtered out of an opencode category', async () => {
    const { fake, created } = await harness()
    try {
      await writeConfig(fake.root, {
        profiles: {
          'sub-cc': { agent: 'subagent', family: 'claude', subagent_type: 'Explore', model: 'haiku' },
          'oc-deep': { agent: 'oc-subagent', family: 'deepseek' },
        },
        categories: { explore: ['sub-cc', 'oc-deep'] },
      })
      const cfg = await config()
      expect(cfg.categories.explore!.profiles).toEqual(['oc-deep'])
      expect(isSubagentProfile(cfg, 'sub-cc')).toBe(false)

      const answer = await dispatch({
        task: 'scout-default',
        intent: 'explore',
        category: 'explore',
        rationale: 'only the opencode profile should run',
        brief: 'Reply with exactly CHILD_OK.',
      })
      expect(answer.ok).toBe(true)
      expect(created).toHaveLength(1)
      expect(created[0].agent).toBe('general')
    } finally {
      await fake.close()
    }
  })
})
