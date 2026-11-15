# oh-my-herdr

Let Claude Code act as the **lead** and split a big job across several agents and models running in [herdr](https://herdr.dev) panes. Inspired by [OmO (oh-my-openagent)](https://omo.dev).

In one line: **type `/ulw <goal>`, and the lead plans, dispatches, waits, and verifies — you just watch the progress bar.**

## Quick start

**1. Install.** You need [herdr](https://herdr.dev), python3, and a logged-in Claude Code. In Claude Code:

```
/plugin install oh-my-herdr --marketplace andyjjrt/oh-my-herdr
```

Answer `y` to `Add marketplace?`, then pick an install scope.

**2. Open Claude Code inside herdr.** Start `herdr`, then run `claude` in a pane, in your project directory.

**3. Check the setup once:**

```
/omh check
```

It shows the config in effect, the agents it needs, and each subscription's quota. Fix anything it flags.

**4. Go:**

```
/ulw paginate the orders API and add tests
```

The lead explores, plans, and dispatches on its own. The run's progress shows in the status line (see [Status line](#status-line)), and the lead is woken up whenever a wave finishes or a worker gets stuck — you don't have to babysit it.

> Add `.omh/` to your project's `.gitignore`; each run's plan and results live there.

### Optional: OpenCode Go models as workers

Workers are Claude Code by default. To hand grunt work to cheaper models, install [senpi](https://github.com/code-yeongyu/senpi) and log in:

```sh
bun add -g @code-yeongyu/senpi   # or: npm install -g --ignore-scripts @code-yeongyu/senpi
senpi                            # then /login → OpenCode Go
```

Full setup (herdr integration, senpi permissions, config format, quota): [references/setup.md](skills/oh-my-herdr/references/setup.md).

## Commands

| Command | What it does |
| --- | --- |
| `/ulw <goal>` | Start an ultrawork run: explore → plan waves → dispatch → verify → gate |
| `/omh check` | Check the config, required agents, and quota mapping |
| `/omh status` | State of the current run, short (`/omh status full` for every task, worker and pane) |
| `/omh plan` | Preview `.omh/plan.md` beside the lead; run again to close. With [prismantis](https://github.com/NahumLitvin/prismantis) installed it is a Claude Code pane drawn in color (redrawn on each new draft); otherwise a herdr pane running the first of `leaf --watch`, `glow`, `bat`, `less` installed |
| `/omh approve` | Approve the lead's plan.md so it can split it into waves |
| `/omh board` | Toggle the full board pane (every wave, task, worker, quota) |
| `/omh quota` | Current usage of each subscription |
| `/omh teardown` | Close all workers |

You can also just ask: "ulw", "split this across several agents", or "use herdr to parallelize this" loads the same workflow.

## Bundled skills

| Skill | Purpose |
| --- | --- |
| `oh-my-herdr` | The lead's full workflow: intent gate, wave planning, dispatch, verification, gates. `/ulw` uses it. |
| `herdr` | herdr's official guide to panes, tabs, workspaces, agents, and safety rules. Used when you ask Claude directly to, say, "open a herdr pane and run the tests" or "check what the agent next door is doing". |

The `herdr` skill is copied unmodified from [herdrdev/herdr](https://github.com/herdrdev/herdr/tree/master/skills/herdr) (Apache-2.0); see [skills/herdr/NOTICE.md](skills/herdr/NOTICE.md) for its source and how to update it. If you already installed it separately (`npx skills add herdrdev/herdr`), you can remove that copy so it doesn't load twice.

## What it adds on top of herdr

- **Explore in parallel before planning.** The lead reads the entry points itself and fans the rest out at once: Claude Code `Explore` subagents for quick look-ups, and read-only herdr *scouts* (`omh_dispatch` with a `scout-<name>` task id) on cheaper routed models for long reads and external docs. Scouts need no plan; the lead is woken when they are all back.
- **Pane workers and subagent workers, side by side.** A profile with `"agent": "subagent"` runs its task as a Claude Code subagent of the lead (no pane, no startup wait) instead of in a herdr pane. Routing, the board (◆), diagnosis and wake-ups treat both alike; the subagent's final reply is saved as its result.md. The default config sends `explore` to an `Explore` subagent, `quick` to a haiku subagent, and keeps long implementation and other providers in panes.
- **Plan first, waves second.** The lead first writes the plan in prose (`.omh/plan.md`: goal, findings, approach, tasks with acceptance checks, risks) and stops. Only after you approve it with `/omh approve` can it split the plan into waves and dispatch; every replan needs a new approval.
- **Visible progress.** The hint line under the prompt (or a row above it) shows the run's progress as a small bar and `x/y` tasks done, `⚠n` when a task needs you; `.omh/status.json` and `statusline/omh-wave` hand the same to a custom status line. `/omh board` opens the full board.
- **The lead knows why a worker stopped.** The mod watches every worker through herdr's event stream. When one is stuck, never started, went idle without a result, or its pane vanished, it reads the screen, the result file and quota, classifies it as `quota-exhausted`, `permission-prompt`, `config-error`, `crashed`, `interrupted` or `unknown`, and wakes the lead with a suggestion.
- **Model per task, quota first.** Every dispatch states an intent (explore / research / implement / fix / review / plan / write), a category and a reason; routing picks the first profile in that category whose provider still has quota. Reviews automatically avoid the implementer's model family.
- **The lead never idles in a turn.** It ends its turn after dispatching; the mod wakes it when there's something to do. Pending wake-ups survive a mod reload.
- **A quality log.** Each verified task gets a one-line quality note, stored with its intent, profile and duration in `~/.local/state/oh-my-herdr/history.jsonl`, for judging which profile suits which kind of work.

## Status line

While a run is open, the mod shows its progress (`omh ██░░░░ 2/5`, `⚠1` while a task needs you) where the `display` option (in `/plugin`) says:

- **`statusline`** (default): at the end of Claude Code's own hint line under the prompt, e.g. `⏵⏵ auto mode on · esc to interrupt · omh ██░░░░ 2/5`. Claude Code keeps drawing the rest of that line.
- **`panel`**: one row above the prompt, with the wave: `omh ██░░░░ 2/5 · W2/3 · ⚠1`.
- **`off`**: neither.

The mod shows nothing else there. For the model, context, folder, branch or usage, use Claude Code's own status line, which can show the run's progress too (below).

### Your own status line

Whatever `display` says, the mod writes the current run's progress to `.omh/status.json` for a [custom status line](https://code.claude.com/docs/en/statusline) (`statusLine` in settings) to show. To add it to yours, paste this to Claude Code (then you may set `display` to `off`):

> Add the oh-my-herdr run progress to my status line. Find where the oh-my-herdr plugin is installed and call its `statusline/omh-wave` with the status line input's `workspace.project_dir` as the argument; it prints a short progress line, or nothing when no run is open. Append that output to my current status line after the folder and branch, separated by ` · `. If I have no status line yet, make one: model with context %, folder, git branch, and that progress. Set `"refreshInterval": 5` on `statusLine` in `~/.claude/settings.json`.

**The API:**

- `statusline/omh-wave [dir]` prints the ready line (`██░░░░ 2/5`, then `⚠1` while a task needs you), or nothing when no run is open. It reads the nearest `.omh/status.json` at or above `dir` (pass the status line's `workspace.project_dir`). `--field <name>` prints one field; `--json` prints the whole file. It always exits 0.
- `.omh/status.json` fields: `version` (1), `run`, `goal`, `wave`, `waves`, `done`, `total`, `alerts`, `wave_done`, `wave_total`, `line`, `updated_at`. `done`/`total`/`alerts` count the whole run (done = reported or closed); `wave_done`/`wave_total` the current wave. The mod rewrites it whenever the run changes and removes it once every gate has passed. Fields are only ever added.

`refreshInterval` matters because Claude Code otherwise reruns the status line only after each reply, so workers finishing while the lead is idle wouldn't show.

## Configuration

### Which agent / model each worker uses

The first config file found wins:

1. `$OMH_CONFIG`
2. `<project>/.omh/config.json`
3. `~/.config/oh-my-herdr/config.json`
4. The built-in [config.default.json](skills/oh-my-herdr/assets/config.default.json)

```jsonc
{
  // A profile is one agent + model
  "profiles": {
    "claude-opus": { "agent": "claude", "family": "claude", "args": ["--model", "opus"] },
    "go-deepseek": { "agent": "senpi", "family": "deepseek",
                     "args": ["--provider", "opencode-go", "--model", "deepseek-v4.1-flash", "--thinking", "max"] }
  },
  // A category lists profiles in order; the first with quota left wins
  "categories": {
    "deep":     ["go-deepseek", "claude-opus"],
    "reviewer": ["claude-opus"]
  }
}
```

### Mod options (set in `/plugin`)

| Option | Default | Description |
| --- | --- | --- |
| `display` | `statusline` | Where the run's progress shows: `statusline` (end of the hint line under the prompt), `panel` (a row above the prompt), `off` |
| `wakeOnSettle` | on | Wake the lead when a wave settles or a worker needs it |
| `notifyHuman` | on | Also send you a herdr notification |
| `autoContinue` | off | When the run isn't finished and no worker is busy, prompt the lead to keep going |
| `autoContinueMax` | 3 | Max auto-continues in a row (any prompt you type resets it) |
| `verbose` | off | Show omh_* tool calls and results in full; off shows one line each (ctrl+o expands). Shown in full with prismantis installed, a worker's report (`omh_collect`) and results with tables are drawn as markdown |

## Troubleshooting

**The lead can't find `omh_dispatch` or the other tools.**
The mod only starts in a lead running inside a herdr pane (`HERDR_ENV=1`). Start `herdr` and run `claude` in a pane.

**A Claude worker is stuck at "Is this a project you created or one you trust?"**
Claude Code hasn't trusted that folder yet. Accept it once in that pane.

**The lead reports `config-error`.**
A wrong model id, a missing login or API key. Re-dispatching fails the same way — fix the config and confirm with `/omh check`.

**The lead reports `quota-exhausted` or `no-profile`.**
A subscription ran out. The lead re-dispatches to another profile with quota left; if every one is out, `/omh quota` shows when each resets.

**Two workers edited the same file.**
Tasks in one wave must not own the same files, so the plan's `owns` was wrong. Run `/omh teardown` and ask the lead to re-plan.

## Development

```sh
claude --plugin-dir ~/codes/github/oh-my-herdr   # or add the path to CLAUDE_CODE_PLUGIN_DIRS
claude plugin validate .
claude plugin test .
```

The lead's workflow is in [skills/oh-my-herdr/SKILL.md](skills/oh-my-herdr/SKILL.md); brief templates per role are in [references/roles.md](skills/oh-my-herdr/references/roles.md).

## License

MIT — see [LICENSE](LICENSE). `skills/herdr/` comes from the herdr project and is Apache-2.0 — see [skills/herdr/LICENSE](skills/herdr/LICENSE).
