# opencode

oh-my-herdr runs as an [opencode](https://opencode.ai) V2 plugin. The lead is an opencode session;
the workers are the same herdr panes as in Claude Code, plus opt-in opencode child sessions. Both
hosts share `core/`, the `skills/oh-my-herdr/` skill, the `.omh/` files and the `omh_*` tools.

## Setup

Requirements:

- **opencode 2.4.2 or newer.** The plugin is built against `@opencode/plugin` 2.4.2, and
  auto-continue uses the `experimental.idle` hook added in 2.4.
- **[herdr](https://herdr.dev)**, with the worker agents you route to installed and integrated
  (`herdr integration install claude`, for example). Workers start as herdr panes.
- The plugin's dependencies: run `bun install` once in the repository's `opencode/` directory.

Add the plugin to the project's `opencode.json`:

```json
{
  "plugins": [
    {
      "package": "/path/to/oh-my-herdr/opencode",
      "options": { "display": "statusline" }
    }
  ]
}
```

`package` is the path to the checkout's `opencode/` directory for now. The package is named
`oh-my-herdr-opencode`; it is not on npm yet.

Start `opencode` in a herdr pane in the project, then:

```text
/ulw paginate the orders API and add tests
```

`/omh check` shows the config in effect, the agents it needs and quota per profile. A pane started
as an opencode worker (`OMH_ROLE=worker`) loads no tools and stays dormant.

Workers are the same pane profiles as in Claude Code. The default config also defines an `opencode`
pane profile (opencode as a worker, `OMH_ROLE=worker`) but routes no category to it; add
`"opencode"` to a category when you want opencode workers. It reports status on herdr only, so it
is not used on the hc backend. To run a task in an opencode child session instead, see
[opt-in opencode child sessions](#opt-in-opencode-child-sessions).

Booting does not require herdr (unlike the Claude Code mod): a headless `opencode` can draft and
approve a run. Dispatching workers still needs a pane backend; without one, dispatch reports the
backend error.

## Options

The options are the Claude Code plugin's options, read from `ctx.options`: the `options` object on
the plugin entry in `opencode.json`, normalized by `optionsOf` in `core/runtime.ts`.

| Option | Default | Description |
| --- | --- | --- |
| `display` | `statusline` | Where the TUI draws the run's progress: `statusline` (its status line), `panel` (a row above the composer), or `off` |
| `backend` | `auto` | Where new pane workers start: `auto` (herdr when the lead runs in herdr, else hc terminals), `herdr`, `hc` |
| `wakeOnSettle` | on | Wake the lead when a wave settles or a worker needs it |
| `notifyHuman` | on | Also send you a herdr notification |
| `autoContinue` | off | When the run is not finished and no worker is busy, prompt the lead to keep going |
| `autoContinueMax` | 3 | Most auto-continues in a row; any prompt you type resets the count |
| `verbose` | off | Claude Code only: show `omh_*` tool calls and results in full. opencode draws its own tool rows, so this option has no effect there |

A non-`auto` `backend` in `.omh/config.json` (or `~/.config/oh-my-herdr/config.json`) overrides the
plugin option for that config (`core/actions.ts`). The other options are read only from
`opencode.json`.

## What differs from Claude Code

| | Claude Code | opencode |
| --- | --- | --- |
| Lead identity | the session in the herdr pane | the session that runs `/ulw` or an `omh_*` tool |
| Tools | `mcp__oh-my-herdr__omh_*` | `omh_*` |
| Wake | a prompt the mod submits | `session.synthetic`, queued |
| `/omh` output | printed immediately | queued into the session; read-only subcommands answer immediately in the TUI |
| Tool rows | compact rows (`verbose` expands) | opencode's own rows; results are capped at 12,000 characters |
| Lead's own subagents | Claude Code subagents (`Agent`) | the `subagent` tool, denied unless a category routes to an `oc-subagent` profile |
| Auto-continue trigger | `turn.complete` | `experimental.idle` |

### The lead and wake-ups

Every `/ulw` and every `omh_*` tool call claims the calling session as the lead; `/omh` claims it
only when no session has claimed it yet. When a run is open, `runs/<run>/lead.json` records the
opencode `session` beside `pane` and `root`.

Wake-ups are synthetic user-role messages queued into the lead's session (`session.synthetic` with
`delivery: "queue"`). Every `prompt.submit` gets a fresh `msg_` id, so two settlements with identical
text (the same worker blocking twice, or two runs printing the same table) both wake the lead. If a
submit fails, its sections go back into the host's wake cell and the next flush retries them; the lead
session is restored from `runs/<run>/lead.json` at boot so a restart does not strand a waiting wave.

### Guards

While the server is live and the calling session is the claimed lead:

- `edit` and `write` are refused for a file that a running task owns when the session is bound to a
  run. The message is the same as Claude Code's, naming the task, the worker and the file.
- `patch` has no single path, so it is denied through opencode's `permission.evaluate` hook, which
  carries the patch's resources.
- `subagent` is held to the config whenever the lead is live, even before a run is bound: its
  `agent` input is matched against the subagent profiles the categories route to (opencode's bare
  `general` maps to `general-purpose`). With the default config no category routes to an opencode
  subagent, so the tool is denied and the message points at `omh_dispatch` scouts. Route a category
  to an `oc-subagent` profile to allow it. A rule that supplies no model strips `input.model`.

The guard is inactive until the session has claimed the lead, and a worker or child session is not
the lead, so it is not blocked.

### Auto-continue

The idle hook (`experimental.idle`) can continue the run when the lead ends a turn with open tasks
or gates. It fires only for the lead session, with `autoContinue` on, below `autoContinueMax`, no
active worker, no background job, and no question tool in the last assistant turn. A prompt you type
resets the count; synthetic prompts (`/ulw`, wake-ups and auto-continue itself) do not. Each send
gets a fresh id, so a repeated "auto-continue 1/2" after a reset is not suppressed as a duplicate
wake.

### Board after compaction

On `compaction`, the lead's run board is appended as a user message after the compaction has been
built, so the lead sees the live wave, task and worker state instead of a stale summary. The append
uses `resume: false`, so it is context rather than a fresh model turn. This is the opencode
counterpart of the Claude Code `session.compact` append.

### Opt-in opencode child sessions

An `oc-subagent` profile runs a task in an opencode child session instead of a herdr pane. It is
never the default. Define a profile that uses the `oc-subagent` agent, then route a category to it:

```jsonc
{
  "profiles": {
    "oc-subagent-deep": { "agent": "oc-subagent", "family": "deepseek" }
  },
  "categories": {
    "quick": ["oc-subagent-deep", "go-fast"]
  }
}
```

You can also force it for one dispatch with `omh_dispatch`'s `profile` argument
(`"profile": "oc-subagent-deep"`).

The agent is defined in `skills/oh-my-herdr/assets/agents.json` as
`{ "launch": "subagent", "host": "opencode", "kind": "general", "model": "opencode-go/deepseek-v4.1-flash" }`.
A profile's `subagent_type` picks another opencode agent; its `model` overrides the default model.

A child is created with the profile's agent and model (the model is fixed at creation), prompted
with the task brief, and watched through `session.execution.*` events. There is no `parentID`, so
opencode does not send its own background result on top of our wake-up. On success its final
assistant message is saved as the task's `result.md` and fed to the normal settle state machine; a
failed or interrupted child settles `gone` with no result. If the event stream ends or errors
without a terminal event, the backend asks `session.get` for the real outcome; if the prompt is
rejected, it aborts the subscription, removes the child session and rethrows.

An agent whose `launch` is `"subagent"` carries a `host` (`claudecode` by default, or `opencode`).
A config filters the subagent profiles of the other host out of the categories, so Claude Code
subagent profiles never run in opencode and `oc-subagent` profiles never run in Claude Code.

### The TUI

The opencode TUI part draws the run beside the conversation: the progress line in the status line
(or a row above the composer with `display: "panel"`), the full board and `plan.md` in a panel, and
toasts when a worker is blocked or a wave settles. `/omh status`, `quota`, `check`, `runs`, `plan`
and `board` answer immediately there over the plugin's RPC, with no model turn. `approve`, `close`
and `teardown` change state and still go through the server command. With no run open, the TUI shows
a quiet empty state. `/omh` server answers that are not `approve` use `resume: false`, so a read-only
status/quota/check/plan/runs/board answer does not start a model turn; `approve` still wakes the lead
so the plan can be split into waves.

## Shared service and project isolation

Run each lead with its own `opencode` process in its herdr pane. Do not attach a lead TUI to a shared
`opencode serve --service`: the service inherits the environment of the pane that first started it.
If that pane was a worker, `OMH_ROLE=worker` makes the server part dormant for every project (boot
logs a loud warning); if it was a lead pane, every later session records the wrong `HERDR_PANE_ID`.
The per-lead storage keeps separate projects' state apart, but the service still has one
process-wide core runtime/lead. Wake-ups and the board are restored from the project's own
`lead.json`/`.omh` at boot.

opencode's `ctx.storage` is shared by every project in the user data directory. Every state cell is
keyed by `sha256(omh + "\0" + root + "\0" + pane)` (or `sha256(omh + "\0" + root)` when
there is no herdr/hc pane), so two panes in one checkout, and the main checkout and its worktrees on
one `.omh`, have separate bound runs, workers, wake sections, continue counters and quota caches.
A second lead cannot approve a run whose `lead.json` names another live pane without `force`.

## Switching hosts

Claude Code and opencode are front ends of the same `.omh` backend. A run can move between them in
one herdr pane:

1. Claude Code is leading a run mid-wave with a live pane worker.
2. Quit `claude`; start `opencode` in the same pane (same `HERDR_PANE_ID`).
3. `/omh approve <id>`:
   `lead.json` names this pane, so it binds without `force`; `reconcile` adopts the live worker by
   its `lead` pane; the worker's next settle wakes the opencode lead; `/omh status` shows the same
   board.
4. Reverse the direction: quit `opencode`, start `claude` in the same pane, and approve the run
   again. Every file the first host wrote (`lead.json` with or without `session`, `dispatch.json`,
   `agents/*`, approvals, `current-run`, scout tags, history) is read by the other; no host-only
   state is required to resume.

Two hosts can also run side by side: a Claude Code lead in one worktree and an opencode lead in
another, on one `.omh`. Each keeps its own run, workers, wakes and scouts; approving a run held by
the other live pane is refused without `force`.

## Known limits

- **One lead per opencode server process.** The core runtime and plugin state are process-wide, so
  two sessions in one server share the lead. Run one `opencode` process per pane/worktree lead, not
  a shared service; distinct panes/roots then have separate per-lead state. Within a server, the
  latest session to call an `omh_*` tool becomes the lead, and `/omh approve` always claims it.
- **A restart keeps the old lead until the new session acts.** The lead session is restored from
  `lead.json` at boot (so queued wakes are not lost). If the TUI opens a new session in the pane,
  the new one becomes lead only after `/ulw`, `/omh approve`, or an `omh_*` tool call. Continue the
  previous session, or run one of those, to move the lead.
- **No pane outside herdr.** If the server did not inherit `HERDR_PANE_ID`, `lead.json` records
  `pane: null`. Wake-ups still work through the recorded session, but the pane-based check that
  detects another live lead cannot see another opencode lead.
- **The file guard starts at the claim.** Until the session has claimed the lead (`/ulw`, `/omh` or an
  `omh_*` tool) and is bound to a run, there is no ownership to enforce, so edits are allowed. The
  `subagent` rule is live as soon as the lead is claimed, even before a run is bound. `/omh approve`
  always claims the lead as part of binding the run.
- **Plugin options are not read from `.omh/config.json`.** Apart from `backend`, the options come
  only from the `options` object on the plugin entry in `opencode.json`; the `.omh` fallback the
  design mentioned is not implemented.
- **No compact tool rows.** opencode renders the whole `omh_*` input and output. Results are capped
  at 12,000 characters with a truncation marker; use `/omh status` and task results for detail.
- **`/omh` is asynchronous outside the TUI.** The server command has no return channel, so it
  answers by queueing a synthetic message into the session. Only the TUI answers the read-only
  subcommands immediately; headless `opencode run` gets the queued answer.
- **Child sessions end with the server.** A child's completion comes from an in-process event
  subscription, so a server restart ends the watch. A `result.md` already written is safe; an
  in-flight answer can be lost.
- **A blocked child may not report as blocked.** Completion uses `session.execution.*` events, not a
  status stream; a child waiting on a permission prompt can fail before it is shown as blocked.

## See also

- [Configuration](configuration.md): profiles, categories, agents and the config search order.
- [Quota](quota.md): how routing skips a provider that is out.
- [Architecture](architecture.md): the shared core and the two host adapters.
- [README](../README.md): install for Claude Code and the development commands.
