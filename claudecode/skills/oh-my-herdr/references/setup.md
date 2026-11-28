# Setup (for the user)

Most of this needs the user's own logins, so hand these steps over rather than trying to do them.
Default stack: **Claude Code or opencode** as the lead, and **senpi** (open-model workers on
OpenCode Go, DeepSeek by default). The lead and the workers can be different hosts.

## 1. herdr
```bash
brew install herdr                  # or: mise use -g herdr
herdr integration install claude    # Claude Code reports its state to herdr
herdr integration install opencode  # opencode reports its state to herdr
herdr integration status
```
senpi needs no herdr integration: it ships a builtin reporter that tells herdr its state
(working / blocked / idle) whenever it runs inside a herdr pane. It reports itself as agent `pi`.
python3 must be on PATH (the mod's watcher bridges herdr's event socket with it).

## 2. Hosts and plugins

### Claude Code
```bash
claude                                                   # log in once with your Pro/Max account
/plugin marketplace add <owner>/oh-my-herdr              # inside Claude Code
/plugin install oh-my-herdr@oh-my-herdr
```
While developing the plugin itself: `claude --plugin-dir <repo>/claudecode`, or put that path in
`CLAUDE_CODE_PLUGIN_DIRS` (the `env` block of `~/.claude/settings.json`). Run
`bun scripts/sync.ts --check` first so `claudecode/core` and `claudecode/skills` match their
sources.

Claude Code workers ask "Is this a project you created or one you trust?" the first time they open
a folder. Accept it once for each project you orchestrate in, or the worker stays blocked.

### opencode
Requires **opencode ≥ 2.4.2** (the V2 plugin API). Install the plugin in the project's
`opencode.json` (or in the global opencode config):
```json
{
  "plugins": [
    { "package": "/path/to/oh-my-herdr/opencode", "options": { "display": "statusline" } }
  ]
}
```
Run opencode as the **lead** in a herdr pane:
```bash
opencode                         # in the project; /ulw <goal> and /omh <sub> are server commands
```
The opencode server must not have `OMH_ROLE=worker` in its environment (a worker pane does). The
plugin is dormant in worker panes by design. `opencode` renders `/omh` answers as a synthetic
message; the immediate TUI picker belongs to the optional TUI part.

For repo development, point `package` at `<repo>/opencode`; the published npm package comes later.
The same `.omh/` files, tools and commands are used as in Claude Code; only the names differ
(`omh_*` instead of `mcp__oh-my-herdr__omh_*`, `subagent` instead of `Agent`, `shell` instead of
`Bash`).

## 3. senpi
```bash
bun add -g @code-yeongyu/senpi      # or: npm install -g --ignore-scripts @code-yeongyu/senpi
senpi                               # then in senpi:
  /login                            #   → OpenCode Go (API key)      → stored as opencode-go
                                    #   (or export OPENCODE_API_KEY=... in your shell rc)
senpi --list-models opencode-go
```
On the herdr-core (hc) backend you need **senpi ≥ 2026.11.21**: older versions never report their
status (OSC 7501), so hc cannot tell when they are ready and workers time out at startup (diagnosis
`no-status-report`). `/omh check` shows the installed version and warns when it is too old; routing
then falls through to the next profile of the category.

Credentials live in `~/.senpi/agent/auth.json` (`SENPI_CODING_AGENT_DIR` overrides the directory).

**Unattended workers and permissions.** senpi has a permission system that prompts before tool
calls; a worker waiting on a prompt shows as `blocked` and the lead is told. For workers to run
on their own, allow tools in senpi settings — globally or only for the project:
```bash
mkdir -p ~/.senpi/agent && cat > ~/.senpi/agent/settings.json <<'EOF'
{ "permission": { "*": "allow" } }
EOF
# or just this repo: put the same JSON in <project>/.senpi/settings.json
```
This lets senpi edit files and run commands without asking. Only do it in workspaces you trust.

## 4. Config
The first file found wins:
1. `$OMH_CONFIG`
2. `<project>/.omh/config.json`
3. `~/.config/oh-my-herdr/config.json`
4. the plugin's `skills/oh-my-herdr/assets/config.default.json`

```bash
mkdir -p ~/.config/oh-my-herdr
cp <plugin>/skills/oh-my-herdr/assets/config.default.json ~/.config/oh-my-herdr/config.json
```

Shape:
```jsonc
{
  "max_concurrent": 5,
  "max_panes_per_tab": 4,             // worker panes per omh-workers tab; then omh-workers-2, …
  "quota": { "threshold": 95, "cache_seconds": 120, "on_unknown": "allow" },
  "agents": {},                       // optional overrides/additions to assets/agents.json
  "profiles": {
    "claude-sonnet": { "agent": "claude", "family": "claude",
                       "args": ["--model", "sonnet", "--permission-mode", "auto"] },
    "go-deepseek":   { "agent": "senpi",  "family": "deepseek",
                       "args": ["--provider", "opencode-go", "--model", "deepseek-v4.1-flash", "--thinking", "max"] },
    "opencode":      { "agent": "opencode", "family": "opencode", "args": [] },
    "sub-explore":   { "agent": "subagent", "family": "claude", "subagent_type": "Explore", "model": "haiku" }
  },
  "categories": {
    "deep":     ["go-deepseek", "claude-sonnet"],                // ordered fallback
    "quick":    "go-deepseek",                                   // single profile
    "security": { "profiles": ["claude-sonnet"], "preamble": "preambles/security.md" }   // custom role
  }
}
```
- `opencode` is a pane worker profile, not a category member by default: add `"opencode"` to a category only when the user wants opencode workers. `oc-subagent` is the opt-in child-session profile, also not routed by default.
- Pane workers open in `omh-workers` tabs of the lead's own workspace, so a new tab lands after the lead's tabs (herdr appends; it has no call to place a tab elsewhere). A tab takes `max_panes_per_tab` panes (default 4: the root, then splits right and down in turn); the next worker opens `omh-workers-2`, and so on. A pane freed by `omh_teardown` is used again. Subagent workers take no pane.
- `agent`: a launch definition name. Built in (`assets/agents.json`): `claude`, `senpi`, `opencode`, `subagent` (Claude Code subagent) and `oc-subagent` (opencode child session).
- `model`, `subagent_type` (subagent profiles only): the model alias or id (left out: the agent's own, else the lead's) and the agent type (`general-purpose` by default; `Explore` and `Plan` are read-only, which is fine: a subagent's final reply is saved as its result.md).
- `args`: passed unchanged to that agent's CLI — model, reasoning level, approval flags.
- `family`: any label; reviewers are routed outside the reviewed task's family.
- `quota` (per profile, optional): force the provider it bills against (`claude`, `opencode-go`), or `null` to skip checks. Normally inferred: agent `claude` or a subagent → claude, `--provider opencode-go` → opencode-go.

### Agents (launch definitions)
```jsonc
"agents": {
  "claude": { "launch": "herdr-kind", "kind": "claude" },
  "opencode": { "launch": "command", "command": ["opencode"], "detect_as": "opencode" },
  "senpi":  { "launch": "command", "command": ["senpi"], "detect_as": "pi", "stall_seconds": 45,
              "diagnose": { "config-error": ["Model is unavailable"] } }
}
```
- `herdr-kind` → `herdr agent start <name> --kind <kind> --pane <pane> -- <args>`.
- `command` → runs `env HERDR_AGENT=<detect_as> OMH_ROLE=worker [env…] <command> <args>` in the pane, waits until herdr detects the agent, then names it. For forks and wrappers herdr doesn't know. The built-in `opencode` agent uses this to start an opencode **worker** with `OMH_ROLE=worker`; it reports on herdr only, not hc.
- `subagent` → no pane: the lead starts a host subagent. `subagent` is a Claude Code subagent; `oc-subagent` is an opencode child session. It starts at once and costs no pane, but runs only that host's models on the lead's own quota and permissions, can't be looked at or typed into like a pane, isn't reused for a second task, and ends with the lead's session. `omh_spawn` can't start one ahead of time; it starts with its dispatch. Good for `explore`, `quick` and read-only reviews; keep long implementation and other providers in panes.
- `stall_seconds` (default 30): how long after a dispatch the worker may take to start working before it counts as stalled.
- `diagnose`: extra screen patterns (regular expressions) per verdict — `quota-exhausted`, `permission-prompt`, `config-error`, `crashed`, `interrupted` — added to the built-in ones. When the lead is told a worker stopped with `unknown`, the screen excerpt is what to turn into a new pattern here.

### Quota
```jsonc
"quota": {
  "enabled": true,
  "threshold": 95,          // a usage window at/above this % counts as exhausted
  "cache_seconds": 120,     // how long a reading is reused
  "on_unknown": "allow",    // or "block": a failed check counts as exhausted
  "providers": {
    "opencode-go": { "enabled": false },                    // turn one provider's check off
    "openrouter": "~/.config/oh-my-herdr/quota/openrouter.sh" // a provider of your own: a command
  }
}
```
The mod reads usage straight from each provider's API: Claude from the Claude Code login
(`~/.claude/.credentials.json`, or `CLAUDE_CODE_OAUTH_TOKEN`), OpenCode Go from
`OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY` or senpi's `auth.json`.

**Any other provider** is a shell command (run with `sh -c`, 15 s at most) that prints the percent
used, either one number or one per window:

```sh
#!/bin/sh
# ~/.config/oh-my-herdr/quota/openrouter.sh: credits used, as a percent (the key stays in this script's world)
curl -fsS -H "Authorization: Bearer $OPENROUTER_API_KEY" https://openrouter.ai/api/v1/credits |
  jq '.data | {credits: (100 * .total_usage / .total_credits)}'
```

`42` and `{"daily": 42, "weekly": 9}` both work. A window at the threshold or above counts as
exhausted; a non-zero exit or output that is not usage counts as unknown (`on_unknown` decides),
with the first stderr line as the reason. A profile bills such a provider only when it names it:
`"quota": "openrouter"`. `/omh check` flags a profile naming a provider that has no command.

Run `/omh check` after editing; it flags undefined profiles and missing executables and shows which
provider every profile maps to. `/omh quota` shows current usage.

## 5. Start working
Run Claude Code or opencode in a herdr pane inside the project, then `/ulw <goal>`. Add `.omh/` to
`.gitignore`.
Every finished task is logged to `~/.local/state/oh-my-herdr/history.jsonl` (intent, category,
profile, outcome, duration and the lead's one-line quality note).

## Worktrees (optional)

oh-my-herdr does not manage worktrees. To work a run in its own checkout, make one yourself, start
Claude there and approve: `git worktree add ../repo.worktrees/x -b feat/x`, then
`cd ../repo.worktrees/x && claude`, then `/omh approve <id>`. `/omh approve [<id>]` binds that session
to the run wherever it runs. See docs/configuration.md.

