/** @jsxImportSource @opentui/solid */
// The opencode TUI part of oh-my-herdr: the run's progress in the prompt footer (or above the
// composer), the board and plan.md in the session panel, an immediate /omh, and toasts for workers
// in trouble and settled waves. Everything comes from the server part over OmhRpc; with no server
// part, no run or a dormant server, every slot stays empty and nothing errors.

import { Plugin } from '@opencode/plugin/tui'
import { For, Show, createSignal, onMount } from 'solid-js'

import { rpcApi, type RpcCapable } from '../rpc/client'
import type { OmhApi, PlanOutput, Snapshot } from '../rpc/protocol'
import { PANEL, runOmh } from './commands'
import { toastsBetween } from './toasts'
import { boardLines, statusSegments, type Segment, type Tone } from './view'

const POLL_MS = 2_000

type Ctx = Parameters<Parameters<typeof Plugin.define>[0]['setup']>[0]

/** Theme colours by tone; a key the host's theme lacks falls back to a fixed colour. */
function palette(context: Ctx): (tone: Tone) => string {
  const t = (context.theme ?? {}) as any
  const pick = (v: unknown, fallback: string) => (typeof v === 'string' || (v !== null && typeof v === 'object') ? (v as string) : fallback)
  const map: Record<Tone, string> = {
    base: pick(t.text?.base, '#d0d0d0'),
    muted: pick(t.text?.muted, '#808080'),
    accent: pick(t.text?.feedback?.info?.base ?? t.text?.base, '#d78700'),
    info: pick(t.text?.feedback?.info?.base, '#5f87ff'),
    warning: pick(t.text?.feedback?.warning?.base, '#d7af00'),
    error: pick(t.text?.feedback?.error?.base, '#d70000'),
    success: pick(t.text?.feedback?.success?.base, '#5faf00'),
  }
  return tone => map[tone]
}

export default Plugin.define({
  id: 'oh-my-herdr.tui',
  setup(context) {
    const api: OmhApi = rpcApi(context as unknown as RpcCapable)
    const color = palette(context)
    const [snap, setSnap] = createSignal<Snapshot | null>(null)
    let last: Snapshot | null = null
    let stopped = false

    const poll = async () => {
      // No server part (or an older one without OmhRpc): stay quiet and keep the last good state empty.
      const next = await api.snapshot().catch(() => null)
      if (stopped) return
      for (const toast of toastsBetween(last, next)) context.ui.toast.show(toast)
      if (next !== null) last = next
      setSnap(next)
    }
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)

    const Segments = (props: { segs: Segment[] }) => (
      <text wrapMode="none" truncate>
        <For each={props.segs}>{s => (s.bold ? <b style={{ fg: color(s.tone) }}>{s.text}</b> : <span style={{ fg: color(s.tone) }}>{s.text}</span>)}</For>
      </text>
    )

    const display = () => snap()?.display ?? 'statusline'
    const segs = () => statusSegments(snap())

    const offStatus = context.ui.slot({
      append: 'prompt.footer.status',
      render: () => (
        <Show when={display() === 'statusline' && segs()}>
          {s => <Segments segs={s()} />}
        </Show>
      ),
    })

    const offRow = context.ui.slot({
      append: 'session.composer.top',
      render: () => (
        <Show when={display() === 'panel' && segs()}>
          {s => <Segments segs={s()} />}
        </Show>
      ),
    })

    // A panel holds the input focus once opened; say how to get back to the prompt, as opencode's own diff panel does.
    function PanelHint(props: { what: string }) {
      const key = () => context.keymap.shortcuts('pane.focus.left')[0]
      return (
        <text fg={color('muted')} wrapMode="none" truncate>
          {key() ? `${key()} focus prompt · ` : ''}/omh {props.what} closes
        </text>
      )
    }

    function Board() {
      return (
        <scrollbox flexGrow={1}>
          <box flexDirection="column">
            <PanelHint what="board" />
            <For each={boardLines(snap())}>
              {line => (
                <text fg={color(line.tone)} wrapMode={line.wrap === false ? 'none' : 'word'} truncate={line.wrap === false}>
                  {line.bold ? <b>{line.text}</b> : line.text}
                </text>
              )}
            </For>
          </box>
        </scrollbox>
      )
    }

    function PlanPane() {
      const [plan, setPlan] = createSignal<PlanOutput | null>(null)
      const [error, setError] = createSignal<string | null>(null)
      onMount(() => {
        void api
          .plan()
          .then(setPlan)
          .catch(err => setError(String(err)))
      })
      return (
        <scrollbox flexGrow={1}>
          <box flexDirection="column">
            <PanelHint what="plan" />
            <Show
              when={plan()?.markdown}
              fallback={<text fg={color('muted')}>{error() ?? (plan() === null ? 'loading plan.md…' : 'No plan.md yet. The lead writes it with omh_status action "draft".')}</text>}
            >
              <text fg={color('muted')} wrapMode="none" truncate>
                {plan()!.file ?? ''}
              </text>
              <text fg={color('base')} wrapMode="word">
                {plan()!.markdown ?? ''}
              </text>
            </Show>
          </box>
        </scrollbox>
      )
    }

    const offPanel = context.ui.slot({
      append: 'session.panel',
      render: panel => (
        <>
          <Show when={panel.name === PANEL.board}>
            <Board />
          </Show>
          <Show when={panel.name === PANEL.plan}>
            <PlanPane />
          </Show>
        </>
      ),
    })

    const sessionOf = () => {
      const route = context.ui.router.current()
      return route.type === 'session' ? route.sessionID : undefined
    }

    context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: 'oh-my-herdr.omh',
          title: 'oh-my-herdr: status | plan | approve | runs | close | quota | check | board | teardown',
          group: 'oh-my-herdr',
          slash: { name: 'omh', arguments: true },
          palette: true,
          async run(input) {
            const reply = await runOmh(api, input, sessionOf())
            if (reply.kind === 'panel') {
              if (context.ui.panel.current()?.name === reply.name) {
                context.ui.panel.close()
                return
              }
              if (!context.ui.panel.open(reply.name)) context.ui.toast.show({ title: 'omh', message: 'open a session to show the panel', variant: 'warning' })
              return
            }
            void poll()
            await context.ui.dialog.alert({ title: reply.title, message: reply.text }).catch(() =>
              context.ui.toast.show({ title: reply.title, message: reply.text, variant: reply.ok ? 'info' : 'warning', duration: 15_000 }),
            )
          },
        },
      ],
    }))

    return () => {
      stopped = true
      clearInterval(timer)
      offStatus()
      offRow()
      offPanel()
    }
  },
})
