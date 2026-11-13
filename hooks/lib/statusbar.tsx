// The status line: the hint line under the prompt becomes one compact line —
//   ⏵⏵ auto mode on · Opus 5.5 (high) · ~/codes/github/oh-my-herdr <branch icon> main · ███░░░░░░░ 31% · 12%/9%
// The engine draws its mode pill ("⏵⏵ auto mode on") itself, outside the hint; everything after it
// is this line, with what else the engine says there (esc to interrupt, …) kept at the end.
//
// Unlike the rest of the mod it works in every session, herdr or not.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { OmhStatusbar } from '../../types'

// Nerd Font's git-branch glyph (U+E0A0); written as an escape so editors can't drop it.
const BRANCH_ICON = '\ue0a0'

const STATUSBAR = atom({ plugin: 'oh-my-herdr', key: 'statusbar' } as const, null, { shape: 'statusbar-1' })

// ------------------------------------------------------------------ pure pieces

export type Mode = { name: string; icon: string; color: string }

const MODES: ReadonlyArray<{ re: RegExp } & Mode> = [
  { re: /auto mode/i, name: 'auto', icon: '⏵', color: 'warning' },
  { re: /accept edits/i, name: 'acceptEdits', icon: '✎', color: 'autoAccept' },
  { re: /plan mode/i, name: 'plan', icon: '⏸', color: 'planMode' },
  { re: /bypass permissions/i, name: 'bypass', icon: '⚠', color: 'error' },
  { re: /don'?t ask/i, name: 'dontAsk', icon: '⊘', color: 'warning' },
]

// A mode pill inside the hint (other surfaces may hand one over; the terminal draws its own outside).
const PILL = /[⏵⏸▶►⚠]*\s*(auto mode|accept edits|plan mode|bypass permissions|don'?t ask(?: mode)?)\s+on(?:\s*\(shift\+tab to cycle\))?/i
// Key-help the engine shows beside its mode pill.
const NOISE = /^\s*(\?\s*for shortcuts|\(shift\+tab to cycle\)|←\s*for agents)\s*$/i

/** The permission mode the hint shows, if any, and what is left of the line without it and its key-help. */
export function splitHint(hint: string): { mode: Mode | null; rest: string } {
  const m = PILL.exec(hint)
  let mode: Mode | null = null
  let rest = hint
  if (m) {
    const found = MODES.find(x => x.re.test(m[1]!))
    if (found) mode = { name: found.name, icon: found.icon, color: found.color }
    rest = hint.slice(0, m.index) + hint.slice(m.index + m[0].length)
  }
  rest = rest
    .split(/\s*·\s*/)
    .map(s => s.trim())
    .filter(s => s !== '' && !NOISE.test(s))
    .join(' · ')
  return { mode, rest }
}

/** claude-opus-5-5 → Opus 5.5; claude-sonnet-4-5-20250929 → Sonnet 4.5; aliases pass through capitalised. */
export function prettyModel(id: string): string {
  const base = id.replace(/\[.*\]$/, '')
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(base)
  if (m) return `${cap(m[1]!)} ${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}`
  return cap(base)
}

function cap(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s
}

/** The home directory as ~, and long paths cut to their last parts. */
export function shortPath(path: string, home: string | undefined, max = 32): string {
  let p = home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
  if (p.length <= max) return p
  const parts = p.split('/')
  while (parts.length > 2 && `…/${parts.slice(1).join('/')}`.length > max) parts.splice(1, 1)
  p = parts.length > 1 ? `${parts[0]}/…/${parts.slice(1).join('/')}` : p
  return p.length <= max ? p : `…${p.slice(-(max - 1))}`
}

export function contextBar(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** Green while there is room, yellow from 70%, red from 90%. */
export function levelColor(percent: number): string {
  if (percent >= 90) return 'error'
  if (percent >= 70) return 'warning'
  return 'success'
}

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** The level named in /effort's arguments or in its answer ("Set effort level to high …"); null when none is. */
export function effortFrom(text: string): string | null {
  const t = text.trim().toLowerCase()
  if ((LEVELS as readonly string[]).includes(t)) return t
  const m = /effort level to (low|medium|high|xhigh|max)\b/i.exec(text)
  return m ? m[1]!.toLowerCase() : null
}

// ------------------------------------------------------------------ the session's figures

// The effort the last request went out with (or /effort set); the settings' level until one has.
let effort: string | null = null

export function noteEffort(level: string | number | undefined | null): void {
  if (typeof level === 'string') effort = level
  else if (typeof level === 'number') effort = String(level)
}

async function refresh($: EngineInterface): Promise<void> {
  const [cwd, model, usage, home] = await Promise.all([$.session.cwd(), $.session.model(), $.session.usage(), $.env.get('HOME')])
  // A reload clears the module's variables; the line drawn before it still knows.
  const before = await read($, STATUSBAR)
  if (effort === null) effort = before?.effort ?? null
  if (effort === null) {
    const fromEnv = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')
    const fromSettings = await $.settings.read({ key: 'effortLevel' }).catch(() => undefined)
    const level = fromEnv && fromEnv !== 'auto' && fromEnv !== 'unset' ? fromEnv : typeof fromSettings === 'string' ? fromSettings : null
    if (level !== null) effort = level
  }
  const info: OmhStatusbar = {
    cwd: shortPath(cwd, home),
    branch: await branchOf($, cwd),
    model: prettyModel(model),
    effort,
    contextPercent: usage.context.percent ?? null,
    limits: limitsOf(usage.rateLimits, before?.limits ?? []),
  }
  await update($, STATUSBAR, () => info)
}

/**
 * The 5-hour and weekly figures, from the last API response's rate-limit headers. A response without
 * them (or none yet since a reload) keeps the figures last seen rather than blanking the line.
 */
export function limitsOf(rateLimits: readonly { kind: string; percentUsed: number }[], last: OmhStatusbar['limits']): OmhStatusbar['limits'] {
  const now = ['five_hour', 'seven_day'].flatMap(kind => rateLimits.filter(l => l.kind === kind)).map(l => ({ kind: l.kind, percent: l.percentUsed }))
  return now.length > 0 ? now : last
}

async function branchOf($: EngineInterface, cwd: string): Promise<string | null> {
  const git = async (...args: string[]) => {
    const r = await $.process.run(['git', ...args], { cwd }).catch(() => null)
    return r && r.exitCode === 0 ? r.stdout.trim() : null
  }
  const name = await git('rev-parse', '--abbrev-ref', 'HEAD')
  if (name === null || name === '') return null
  return name === 'HEAD' ? await git('rev-parse', '--short', 'HEAD') : name
}

/** Re-read the figures outside the hook that asked (git and the session take a moment). */
export function refreshStatusbar($: EngineInterface): void {
  $.clock.after(0, () => {
    void refresh($).catch(err => $.ui.log(`oh-my-herdr statusbar: ${(err as Error).message}`, { to: 'debug' }))
  })
}

// ------------------------------------------------------------------ the line

/** The line, or null before anything is known (the engine's own line then stands). */
export async function statusbarLine($: EngineInterface, e: { props: { hint: string } }, el: { Box: any; Text: any }): Promise<unknown> {
  const info = await read($, STATUSBAR)
  if (info === null) return null
  const { Box, Text } = el
  const { mode, rest } = splitHint(e.props.hint)
  const parts: any[] = []
  const add = (node: any) => {
    if (parts.length > 0) parts.push(<Text dimColor> · </Text>)
    parts.push(node)
  }
  add(
    <Text color="claude">
      {info.model}
      {info.effort !== null ? <Text dimColor> ({info.effort})</Text> : ''}
    </Text>,
  )
  add(
    <Text>
      <Text color="suggestion">{info.cwd}</Text>
      {info.branch ? <Text color="merged"> {BRANCH_ICON} {info.branch}</Text> : ''}
    </Text>,
  )
  if (info.contextPercent !== null) {
    const pct = info.contextPercent
    const cells = contextBar(pct)
    add(
      <Text>
        <Text color={levelColor(pct)}>{cells.replace(/░/g, '')}</Text>
        <Text dimColor>{cells.replace(/█/g, '')}</Text>
        <Text dimColor> {Math.round(pct)}%</Text>
      </Text>,
    )
  }
  // 5-hour and weekly usage as one figure: 68%/9%.
  if (info.limits.length > 0) {
    const figures: any[] = []
    info.limits.forEach((l, i) => {
      if (i > 0) figures.push(<Text dimColor>/</Text>)
      figures.push(<Text color={levelColor(l.percent)}>{Math.round(l.percent)}%</Text>)
    })
    add(<Text>{figures}</Text>)
  }
  if (rest !== '') add(<Text dimColor>{rest}</Text>)
  return (
    <Box>
      <Text wrap="truncate-end">
        {mode ? (
          <Text color={mode.color} bold>
            {mode.icon}{' '}
          </Text>
        ) : (
          ''
        )}
        {parts}
      </Text>
    </Box>
  )
}
