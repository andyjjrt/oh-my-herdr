// Compact transcript rows for the omh_* tools. Left alone, the engine draws a call's whole input
// (a dispatch's markdown brief, a plan.md, a plan's JSON) and its whole result. Unless the
// `verbose` option is on, a call draws as one line and its result as its first line:
//   ● omh dispatch T3 · implement · deep
//     ⎿  dispatched T3 to w2 [go-deepseek, deepseek] (+4 lines, ctrl+o)
// ctrl+o (or --verbose) still shows everything.

type Elements = { Box: any; Text: any }

export const OMH_TOOL = /^mcp__oh-my-herdr__omh_(dispatch|status|collect|spawn|teardown)$/

type Args = Record<string, unknown>
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The few input fields worth a glance; never the brief, plan.md or the plan's body. */
export function callSummary(tool: string, input: unknown): string {
  const name = tool.replace(/^mcp__oh-my-herdr__omh_/, '')
  const a: Args = input !== null && typeof input === 'object' ? (input as Args) : {}
  const bits: string[] = []
  const push = (...xs: unknown[]) => bits.push(...xs.map(str).filter((x): x is string => x !== null))
  switch (name) {
    case 'dispatch':
      push(a.task, a.intent, a.category, a.worker)
      break
    case 'status': {
      const action = str(a.action) ?? 'show'
      bits.push(action)
      if (action === 'draft') {
        const md = str(a.markdown) ?? ''
        const name = str(a.name)
        if (name) bits.push(`new run ${name}`)
        const title = md.split('\n').find(l => l.trim() !== '')?.replace(/^#+\s*/, '')
        if (title) bits.push(title.length > 60 ? `${title.slice(0, 59)}…` : title)
        bits.push(plural(md === '' ? 0 : md.split('\n').length, 'line'))
      } else if (action === 'plan') {
        const plan = (a.plan ?? {}) as Args
        const waves = Array.isArray(plan.waves) ? (plan.waves as Args[]) : []
        const tasks = waves.reduce((n, w) => n + (Array.isArray(w?.tasks) ? (w.tasks as unknown[]).length : 0), 0)
        bits.push(`${plural(waves.length, 'wave')}, ${plural(tasks, 'task')}`)
      } else if (action === 'gate' && typeof a.wave === 'number') bits.push(`W${a.wave}`)
      else push(a.task)
      break
    }
    case 'collect':
      push(a.task)
      break
    case 'spawn':
      push(a.name, a.category, a.profile)
      break
    case 'teardown':
      bits.push(Array.isArray(a.workers) && a.workers.length > 0 ? a.workers.filter(x => typeof x === 'string').join(', ') : 'all')
      break
  }
  return bits.join(' · ')
}

/** The text of a tool result, however the surface hands it over. */
export function resultText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return output.map(resultText).filter(s => s !== '').join('\n')
  if (output !== null && typeof output === 'object') {
    const o = output as Args
    if (typeof o.text === 'string') return o.text
    if ('content' in o) return resultText(o.content)
    if ('result' in o) return resultText(o.result)
  }
  return ''
}

/** First non-empty line, and how many lines follow it. */
export function firstLine(text: string, max = 80): { line: string; more: number } {
  const lines = text.split('\n').filter(l => l.trim() !== '')
  const first = (lines[0] ?? '').trim()
  return { line: first.length > max ? `${first.slice(0, max - 1)}…` : first, more: Math.max(0, lines.length - 1) }
}

export type CallProps = { tool: string; input: unknown; isRunning: boolean; isErrored: boolean; isInterrupted: boolean }

export function compactCall(el: Elements, p: CallProps): unknown {
  const { Box, Text } = el
  const name = p.tool.replace(/^mcp__oh-my-herdr__omh_/, '')
  const summary = callSummary(p.tool, p.input)
  const dot = p.isErrored || p.isInterrupted ? 'error' : p.isRunning ? undefined : 'success'
  return (
    // A blank row above, as the engine's own rows have.
    <Box flexDirection="column" marginTop={1}>
      <Text wrap="truncate-end">
        <Text color={dot} dimColor={p.isRunning}>
          ●{' '}
        </Text>
        <Text bold>omh {name}</Text>
        {summary ? <Text dimColor> {summary}</Text> : ''}
      </Text>
      {p.isInterrupted ? <Text color="error">  ⎿  Interrupted</Text> : ''}
    </Box>
  )
}

export function compactResult(el: Elements, p: { output: unknown; isErrored: boolean }): unknown {
  const { Text } = el
  const { line, more } = firstLine(resultText(p.output))
  if (line === '') return <Text dimColor>  ⎿  done</Text>
  const isError = p.isErrored || line.startsWith('ERROR')
  return (
    <Text wrap="truncate-end">
      <Text dimColor>  ⎿  </Text>
      <Text color={isError ? 'error' : undefined} dimColor={!isError}>
        {line}
      </Text>
      {more > 0 ? <Text dimColor> (+{more} line{more === 1 ? '' : 's'}, ctrl+o)</Text> : ''}
    </Text>
  )
}
