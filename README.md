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

The lead explores, plans, and dispatches on its own. A progress bar appears above the prompt, and the lead is woken up whenever a wave finishes or a worker gets stuck — you don't have to babysit it.

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
| `/omh status` | State of the current run |
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

- **Visible progress.** A wave bar above the prompt shows how many tasks are done and how many need attention. `/omh board` opens the full board.
- **The lead knows why a worker stopped.** The mod watches every worker through herdr's event stream. When one is stuck, never started, went idle without a result, or its pane vanished, it reads the screen, the result file and quota, classifies it as `quota-exhausted`, `permission-prompt`, `config-error`, `crashed`, `interrupted` or `unknown`, and wakes the lead with a suggestion.
- **Model per task, quota first.** Every dispatch states an intent (explore / research / implement / fix / review / plan / write), a category and a reason; routing picks the first profile in that category whose provider still has quota. Reviews automatically avoid the implementer's model family.
- **The lead never idles in a turn.** It ends its turn after dispatching; the mod wakes it when there's something to do. Pending wake-ups survive a mod reload.
- **A quality log.** Each verified task gets a one-line quality note, stored with its intent, profile and duration in `~/.local/state/oh-my-herdr/history.jsonl`, for judging which profile suits which kind of work.

## Status line

The mod also replaces the hint line under the prompt with a compact status line. **It works in every session**, not only inside herdr:

![](assets/statusline.png)

From left to right: model, folder and git branch, context usage bar, and Claude subscription usage (5-hour / weekly). Usage is green, turns yellow at 70% and red at 90%.

- The branch icon is a Nerd Font glyph; without a Nerd Font it shows as a box.
- The leading "⏵⏵ auto mode on" is drawn by Claude Code itself; the mod can't change it.
- It refreshes at session start, after each reply, after `/model`, and after compaction.
- To turn it off, disable `statusbar` in `/plugin`.

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
| `band` | on | Wave progress bar above the prompt |
| `statusbar` | on | Compact status line under the prompt (every session) |
| `wakeOnSettle` | on | Wake the lead when a wave settles or a worker needs it |
| `notifyHuman` | on | Also send you a herdr notification |
| `autoContinue` | off | When the run isn't finished and no worker is busy, prompt the lead to keep going |
| `autoContinueMax` | 3 | Max auto-continues in a row (any prompt you type resets it) |

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
