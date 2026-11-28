# Changelog

## 0.5.0-beta2 — 2026-11-28

### Added

- **opencode host.** `opencode/` is an opencode V2 plugin package (`oh-my-herdr-opencode`, opencode
  2.4.2 or newer) that runs the same loop with an opencode session as the lead: the five `omh_*`
  tools and `/ulw`/`/omh`, wake-ups through a queued `session.synthetic`, the file-ownership guards
  on `edit`/`write`/`patch`, the built-in `subagent` guard, idle auto-continue, the board after
  compaction, and a TUI part for the status line, the board/plan panel and immediate `/omh`.
  See [docs/opencode.md](docs/opencode.md). Install it from the repository checkout for now; the
  npm package is not published yet.
- **Opt-in `oc-subagent` child sessions.** An opencode profile can run a task in a child session
  instead of a herdr pane. It is never routed by default: force `profile` on a dispatch, or add the
  profile to a category. See
  [docs/opencode.md](docs/opencode.md#opt-in-opencode-child-sessions).
- **Host-aware subagent profiles.** An agent definition's `host` field (`claudecode` or
  `opencode`) keeps a subagent profile on the host that can run it; `oc-subagent` is the opencode
  child-session agent. A config filters the other host's subagent profiles out of the categories.
- **Portable core tests.** The host-neutral suites live in `core/tests/` and run with plain
  `bun test core/`, without `claude-code/testing`. `core/testing/fake-host.ts` is a complete
  `Engine` used by the core and Claude Code suites.

### Changed

- **One repo, three parts.** Host-neutral code is in `core/`, the shared skill and assets in
  `skills/`, the Claude Code plugin in `claudecode/` (the marketplace source) and the opencode
  plugin in `opencode/`. `bun scripts/sync.ts` copies `core/` and `skills/` into `claudecode/` and
  generates its type contract; `bun scripts/sync.ts --check` fails when they drift. Edit `/core`
  and `/skills`, then run the sync.
- **The Claude Code marketplace install is unchanged**, now sourced from `./claudecode`; the
  plugin copies remain committed so Claude Code installs a self-contained directory.

### Fixed

- **opencode state is per lead.** Every storage cell is keyed by
  `sha256(omh + "\0" + root + "\0" + pane)` (or `sha256(omh + "\0" + root)` without a pane), so
  two panes in one checkout, a main checkout and its worktrees, and separate projects served from
  one opencode data directory never share bound runs, workers, wake sections, continue counters or
  quota caches. Booting one lead no longer clears another's binding.
- **Several opencode leads and one `.omh` across hosts.** A Claude Code lead and an opencode lead can
  run side by side on one `.omh`; approving a run held by another live pane is refused without
  `force`. In one pane the run can move Claude Code → opencode → Claude Code: `lead.json`'s pane
  lets the new host bind without force, `reconcile` adopts the live worker, and the next settle wakes
  the new lead. See [docs/opencode.md](docs/opencode.md#switching-hosts).
- **Wake-ups get fresh ids.** Two settlements with identical text both reach
  `session.synthetic`; a failed submit puts its sections back for the next flush. The lead session is
  restored from `runs/<run>/lead.json` at boot, so a server restart does not strand a waiting wave.
- **The `subagent` guard is live before a run is bound.** It matches CC's timing, maps opencode's
  `general` agent to `general-purpose`, and strips a model the config does not route. `/ulw` lists
  the `oc-subagent` kinds the config actually allows.
- **Read-only synthetic messages do not start a model turn.** The compaction board and `/omh` answers
  other than `approve` use `resume: false`.
- **Lost child-session streams settle correctly.** An `oc-subagent` keeps polling `session.get`
  while a dropped stream has no terminal outcome, recovers the real outcome when it appears, and only
  aborts/removes the child if it gives up. A rejected prompt or failed subscribe removes the child
  and drops its `running` status entry; the plugin dispose aborts the subscriptions.
- **The opencode TUI is type-checked.** `solid-js`, `@opentui/solid` and `@opentui/core` are dev
  dependencies at the versions opencode 2.4.2 ships, and the tsconfig includes `src/**/*.tsx`.

- **`/omh` replies in the opencode TUI keep their tables.** Replies open in a wide, scrollable
  dialog that renders markdown, instead of a plain-text alert that wrapped `/omh check`'s tables.

### Known limits

- **One opencode lead per server process.** The runtime is process-wide, so two opencode sessions
  in one server share the lead; the latest `omh_*` call claims it. Run one `opencode` process per
  pane/worktree lead for separate per-lead state.
- **A restart keeps the old lead until the new session acts.** The lead session is restored from
  `lead.json`; after the TUI opens a new session, run `/ulw`, `/omh approve` or an `omh_*` tool in
  it (or continue the previous session) to move the lead.
- **Run a lead with its own `opencode`, not a shared service.** `opencode serve --service` inherits
  the environment of the pane that first started it; a service started from a worker stays dormant
  for every project, and one started from a lead records the wrong pane.
- **No pane outside herdr.** An opencode server that did not inherit `HERDR_PANE_ID` records
  `lead.json` without a pane; wake-ups still work through the session.
- **The file guard starts at the claim.** Edits are checked only after the session has run `/ulw`,
  `/omh` or an `omh_*` tool and is bound to a run. The `subagent` guard is live from the claim, even
  before a run is bound.
- **opencode has no compact tool rows**, so `omh_*` results are capped at 12,000 characters.
- **Plugin options do not fall back to `.omh/config.json`.** Apart from `backend`, they come only
  from the plugin entry in `opencode.json`.

## 0.5.0-beta1 — 2026-11-22

### Added

- **Several runs at once.** Each draft with a new `name` is its own run and earlier drafts stay;
  `/omh runs` lists them with their state, lead and root, and `/omh approve [<id>]` approves one by
  id or suffix.
- **`/omh approve [<id>]` binds this session to the run**, in whatever checkout it runs (the main
  checkout or a worktree you made yourself). The session's dispatch, status and plan then follow
  that run, not the shared `current-run`. oh-my-herdr does not create, remove or track git
  worktrees; to work a run in its own checkout:

  ```sh
  git worktree add ../repo.worktrees/x -b feat/x
  cd ../repo.worktrees/x && claude
  /omh approve <id>
  ```

  `/omh approve <id>` on a run another live session leads is refused unless `force` (a takeover);
  an unbound session never follows `current-run` into such a run. A run closed from another
  session unbinds its lead with a wake-up. Two leads in one checkout are allowed; that is up to you. A bound session re-approves its own
  run; `/omh approve <other>` is refused until its run is finished or closed. A bound session may
  still draft a new `name`: the draft is written, the binding and `current-run` stay. Approving
  writes `runs/<run>/lead.json` (`{ pane, root }`).
- **`omh_status finish` and `/omh close [run] [force]` only record state** (`finished.json`,
  `closed.json`); `close` tears down the run's workers and unbinds the session bound to it.
  `close` without `force` refuses a run whose lead is live in another pane.
- **`.omh/` is central**: found through `git rev-parse --git-common-dir`, so every worktree shares
  the main checkout's (`OMH_DIR` still overrides). `OMH_RUN` binds a freshly started lead to a run.
- **Plugin hook points.** `.omh/events.jsonl` logs the lifecycle (`draft`, `approved`, `bound`,
  `unbound`, `wave_settled`, `alert`, `finished`, `closed`, `approval_rejected`). An approvals drop
  file `.omh/approvals/<run>` with the draft digest approves a run from outside: the session bound
  to that run claims it; a run nobody leads is approved without binding (a future inbox/Discord
  plugin may then start its own worktree and lead and send `/omh approve <id>`). `.omh/status.json`
  also lists every active run.
- **Status capability routing.** Agents can declare `reports`, `min_version` and `version_cmd`;
  routing skips profiles whose agent cannot report status on the backend, and `/omh check` says why.

### Changed

- **`statusline/omh-wave` finds its run by `lead.json`**: the newest not-closed run whose `root`
  is the current git toplevel; otherwise it falls back to the summary. A finished run's status is
  removed, so it then falls back too.
- **Default profile permission modes.** `claude-sonnet` and `claude-review` in the default config
  now start with `--permission-mode auto`. A project can set its
  own `--permission-mode` per profile in its config.
- **The approvals poll returns early** when no drop file can be claimed.
- **Dispatch reuses only workers whose cwd is this checkout's root**, so a worker left in another
  checkout is not given tasks. Teardown and reconcile still own it.

### Fixed

- **Worker ownership is recorded.** Worker files carry a `lead` field (the session's pane address,
  `leadId()`); `ownsWorker` then matches on it alone, so a worker started in a subfolder (`cwd`) or
  left over from an earlier run is still its lead's.
  A lead restarted in a new pane has a new identity and no longer owns its old workers (it treats
  them as foreign; `/omh teardown <name>` still reaches them).
- **`omh_spawn` no longer overwrites another lead's live worker** of the same name; it refuses
  while that pane exists. Dispatch's name picker skips names that have an agent file.
- **Freed workers keep their file truthful.** Verifying, abandoning or collecting a task now also
  rewrites the agent file (`run`, `task`, `task_dir`), so a lead that finished one run still owns,
  reuses and tears down its idle workers in the next.
- **`/omh close` tears down a bound lead's spawned workers** (spawn records the run), as well as
  those it dispatched.
- **Several leads no longer touch each other's workers.** Teardown (with no names), reconcile
  after a reload and worker reuse in dispatch act only on this session's workers (`ownsWorker`).
- **`OMH_RUN` seeds a session only once**: not after `/omh close` or an unbind, and not for a run
  that has a `closed.json`. An unbound session skips a closed `current-run`.
- **Scouts of a bound lead are tagged** (`runs/_scout/<tag>-<id>`), so two leads' scouts of the
  same name no longer share a directory.
- **A bound session writes its own `runs/<run>/status.json`**; only an unbound one writes the top
  of `.omh/status.json`. Stale agent files (pane gone) no longer count against `max_concurrent`.
- **`recheck` uses the task's current worker**, not an older one that once held it.
- **Stale wake-ups are dropped**: an alert for a worker that was re-dispatched or torn down is not
  sent, and a wave table is rebuilt from the live state.
- **A new `no-status-report` diagnosis** for an agent that never reports status on hc, with a hint
  to upgrade it (senpi needs ≥ 2026.11.21 on hc).

- **The worker prompt spells out the handoff**: the brief path, the `result.md` to write and the
  one-line `DONE <path>` / `BLOCKED <reason>` reply (a subagent's final reply is its report). Closed
  runs leave `.omh/status.json`; `omh-wave --runs` reads the summary in a bound checkout and honours
  `OMH_DIR`. Compatibility code for older versions is removed (the legacy `.omh/plan.md` draft,
  workers without `lead`, the `worktree` config warning).

### Known limits

- Two leads in one checkout share its files and its status line (it shows the most recent binding
  in that root). Nothing guards against it.
- Without a lead identity (outside herdr/hc) no `lead` is recorded and `current-run` is shared.
- Two unbound sessions still share `current-run` for drafts until one approves.
- A bound session writes only `runs` into the top-level `.omh/status.json`, so that summary can be
  stale; `omh-wave` reads the run's own file.

## 0.4.3 — 2026-11-21

### Added

- **The lead's own subagents follow the config.** The lead's Agent tool calls are held to the
  subagent profiles the categories route to: their types only, on their models (an `Explore` call
  with no model no longer inherits the lead's opus). When the config routes only to external
  agents, the lead's Agent calls are refused and it explores with scouts. `/ulw` names what the
  lead may start.
- **The `herdr-core` skill is bundled**, copied unmodified from herdrdev/herdr-core
  (Apache-2.0; `skills/herdr-core/NOTICE.md`), beside the `herdr` skill.

### Changed

- **librarian starts on a haiku subagent** in the built-in config (`sub-haiku` → `go-fast` →
  `go-deepseek`), like explore (`sub-explore`, Explore on haiku).
- **The lead runs tests and checks in herdr or hc.** The skill and the `/ulw` prompt ask the lead
  to run test suites, builds and servers in a herdr pane or an hc terminal instead of its own Bash
  call, so you can watch them; the cheatsheet gains the `hc` commands.
- **`/omh plan` always previews in a Claude Code pane beside the lead.** Without prismantis it
  used to open a herdr pane running `leaf`, `glow`, `bat` or `less`, which failed with herdr-core
  and outside herdr. Now the same pane shows plan.md as plain text; with prismantis it is still
  drawn as markdown.

## 0.4.2 — 2026-11-19

### Fixed

- **A worker that started at once is no longer called stalled.** The dispatch was recorded only
  after the prompt call returned, so a `working` reported meanwhile (pi on hc does this within a
  second) was dropped, and the watcher never repeats a status. The dispatch is now recorded first,
  and before a stall alert the mod asks the pane for its live status.
- **Stalled and idle-without-result tasks recover.** A stalled worker that goes idle with its
  `result.md` finishes, and an `idle-no-result` worker that works again, or whose report lands
  late, returns to running or finished instead of keeping the alert.

### Added

- **`omh_status` action `recheck`.** Re-reads the live status of the worker holding a task and
  corrects its phase, for an alert the lead thinks is wrong.

## 0.4.1 — 2026-11-18

### Added

- **Worker backend is a plugin option.** `/plugin` → oh-my-herdr → configure now shows **Worker
  backend** (`auto`, `herdr`, `hc`), so herdr-core can be picked without editing config.json. A
  `backend` other than `auto` in config.json still overrides it. `/omh check` shows the backend in
  force.

### Changed

- **Explore subagents run on haiku by default.** The skill now has the lead pass `model: "haiku"`
  when it calls the Agent tool with `subagent_type: "Explore"`, the same model as the `sub-explore`
  profile; `"sonnet"` only when the question needs judgment or the user asked for another model.

## 0.4.0 — 2026-11-18

### Changed

- **Each piece of work gets its own run directory when its plan is first drafted.** `omh_status`
  action `draft` takes a `name`, which starts the run `.omh/runs/<YYYYMMDD>-<name>/` and makes it
  current. The plan is written there as `draft.md`, and `/omh approve` renames it to the run's
  `plan.md`. A draft without `name` revises the current run's plan. When a revision is approved,
  the previous plan is kept as `plan.v<n>.md`.
  - Before, plans were drafted to a shared `.omh/plan.md`. `omh_status plan` without `new_run`
    wrote into whatever run was current, so a new plan could overwrite an old, finished run's
    `plan.json` and `plan.md`.
  - The first draft must have a `name`.
  - A name already used by another run is refused.
  - Starting a new run is refused while workers are still out on the current one.
- **`new_run` is removed** from `omh_status`. `plan` always saves into the current run.
- **A rejected plan keeps its approval.** The lead can fix it and send it again. The approval now
  holds as long as the run's `plan.md` is unchanged; it is no longer used up by the first save.
  `plan` is still refused while a newer draft is waiting for `/omh approve`.
- **Run progress counts a task as done once its wave's gate has passed.** This applies to the
  status line, the panel, and `status.json`'s `done` and `line`. A run whose last gate is still
  open now shows `4/5`, not `5/5`. `wave_done` still counts the current wave's tasks that are
  reported or closed.
- The wake-up after `/omh approve` names the run's `plan.md`.
- `/omh plan` previews the current run's `draft.md`, else its `plan.md`, else a leftover
  `.omh/plan.md` from an older version.
- A free worker whose last status is `done` is reused like an `idle` one (hc keeps `done` until the
  agent's next report).

### Added

- **herdr-core backend.** Pane workers can run in [herdr-core](https://github.com/herdrdev/herdr-core)
  (`hc`) terminals, and through them in the Herdr desktop app, besides herdr panes. config.json's
  `backend` (`auto`, `herdr`, `hc`) picks where new workers start; `auto` keeps herdr inside herdr.
  The mod also wakes up in an hc terminal (`HC_TERMINAL_ID`). See
  [configuration](docs/configuration.md#where-workers-run-herdr-or-herdr-core).
  - Status comes from the agent's own OSC 7501 reports, followed with `hc events`.
  - In the Herdr app, workers open in omh tabs of the lead's space (`hc.panes`).
  - `/omh check` shows the backend and whether the hc core is running.
- **`pi` is a built-in agent** (`"launch": "herdr-kind", "kind": "pi"`), so profiles can use
  `"agent": "pi"` (or `"kind": "pi"`) without an `agents` entry.
- **`status.json` has a `stage` field** with the value `draft`, `approved` or `running`. The file is
  also written before a run has waves: its `line` is `✎ plan draft`, then `✓ plan approved`.
  `omh-wave --field stage` reads it.
- **An unknown category suggests the closest one** (`'review'` → did you mean `'reviewer'`?). When
  the name is an intent, the message says that a category is a routing name from the config.

### Upgrading

- A `.omh/plan.md` left from 0.3 is not moved. `/omh plan` still shows it; have the lead draft it
  again with a `name`.
- Runs already in progress keep working as they are.

## 0.3.0 — 2026-11-15

- Scouts: read-only `scout-<name>` tasks dispatched before a plan exists.
- `/omh plan` previews `plan.md` beside the lead.
- Subagent workers (`"agent": "subagent"`) run a task as a Claude Code subagent of the lead.
- Worker tabs in the lead's workspace (`max_panes_per_tab`).
- Markdown answers for `/omh status`, `status full`, `quota` and `check`.
- Quota from any provider by command (`quota.providers.<name>` as a shell line).
- `docs/`, and a shorter README.

## 0.2.0 — 2026-11-14

- Plan approval with `/omh approve`.
- Compact tool rows.
- Run progress for the status line.
- herdr's own skill is bundled.
- README in English.

## 0.1.0 — 2026-11-14

- First release.
