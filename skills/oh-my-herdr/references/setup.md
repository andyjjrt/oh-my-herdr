# Setup (for the user)

Most of this needs the user's own logins, so hand these steps over rather than trying to do them.
Default stack: **Claude Code** (lead + Claude-family workers) and **senpi** (open-model workers on
OpenCode Go, DeepSeek by default).

## 1. herdr
```bash
brew install herdr                  # or: mise use -g herdr
herdr integration install claude    # Claude Code reports its state to herdr
herdr integration status
```
senpi needs no herdr integration: it ships a builtin reporter that tells herdr its state
(working / blocked / idle) whenever it runs inside a herdr pane. It reports itself as agent `pi`.
python3 must be on PATH (the mod's watcher bridges herdr's event socket with it).

## 2. Claude Code and the plugin
```bash
claude                                                   # log in once with your Pro/Max account
/plugin marketplace add <owner>/oh-my-herdr              # inside Claude Code
/plugin install oh-my-herdr@oh-my-herdr
```
While developing the plugin itself: `claude --plugin-dir <repo>`, or put the repo path in
`CLAUDE_CODE_PLUGIN_DIRS` (the `env` block of `~/.claude/settings.json`).

Claude Code workers ask "Is this a project you created or one you trust?" the first time they open
a folder. Accept it once for each project you orchestrate in, or the worker stays blocked.

## 3. senpi
```bash
bun add -g @code-yeongyu/senpi      # or: npm install -g --ignore-scripts @code-yeongyu/senpi
senpi                               # then in senpi:
  /login                            #   → OpenCode Go (API key)      → stored as opencode-go
                                    #   (or export OPENCODE_API_KEY=... in your shell rc)
senpi --list-models opencode-go
```
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
  "quota": { "threshold": 95, "cache_seconds": 120, "on_unknown": "allow" },
  "agents": {},                       // optional overrides/additions to assets/agents.json
  "profiles": {
    "claude-sonnet": { "agent": "claude", "family": "claude",
                       "args": ["--model", "sonnet", "--permission-mode", "acceptEdits"] },
    "go-deepseek":   { "agent": "senpi",  "family": "deepseek",
                       "args": ["--provider", "opencode-go", "--model", "deepseek-v4.1-flash", "--thinking", "max"] }
  },
  "categories": {
    "deep":     ["go-deepseek", "claude-sonnet"],                // ordered fallback
    "quick":    "go-deepseek",                                   // single profile
    "security": { "profiles": ["claude-sonnet"], "preamble": "preambles/security.md" }   // custom role
  }
}
```
- `agent`: a launch definition name. Built in (`assets/agents.json`): `claude`, `senpi`.
- `args`: passed unchanged to that agent's CLI — model, reasoning level, approval flags.
- `family`: any label; reviewers are routed outside the reviewed task's family.
- `quota` (per profile, optional): force the provider it bills against (`claude`, `opencode-go`), or `null` to skip checks. Normally inferred: agent `claude` → claude, `--provider opencode-go` → opencode-go.

### Agents (launch definitions)
```jsonc
"agents": {
  "claude": { "launch": "herdr-kind", "kind": "claude" },
  "senpi":  { "launch": "command", "command": ["senpi"], "detect_as": "pi", "stall_seconds": 45,
              "diagnose": { "config-error": ["Model is unavailable"] } }
}
```
- `herdr-kind` → `herdr agent start <name> --kind <kind> --pane <pane> -- <args>`.
- `command` → runs `env HERDR_AGENT=<detect_as> OMH_ROLE=worker [env…] <command> <args>` in the pane, waits until herdr detects the agent, then names it. For forks and wrappers herdr doesn't know.
- `stall_seconds` (default 30): how long after a dispatch the worker may take to start working before it counts as stalled.
- `diagnose`: extra screen patterns (regular expressions) per verdict — `quota-exhausted`, `permission-prompt`, `config-error`, `crashed`, `interrupted` — added to the built-in ones. When the lead is told a worker stopped with `unknown`, the screen excerpt is what to turn into a new pattern here.

### Quota
```jsonc
"quota": {
  "enabled": true,
  "threshold": 95,          // a usage window at/above this % counts as exhausted
  "cache_seconds": 120,     // how long a reading is reused
  "on_unknown": "allow",    // or "block": a failed check counts as exhausted
  "providers": { "opencode-go": { "enabled": false } }   // turn one provider's check off
}
```
The mod reads usage straight from each provider's API: Claude from the Claude Code login
(`~/.claude/.credentials.json`, or `CLAUDE_CODE_OAUTH_TOKEN`), OpenCode Go from
`OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY` or senpi's `auth.json`.

Run `/omh check` after editing; it flags undefined profiles and missing executables and shows which
provider every profile maps to. `/omh quota` shows current usage.

## 5. Start working
Run Claude Code in a herdr pane inside the project, then `/ulw <goal>`. Add `.omh/` to `.gitignore`.
Every finished task is logged to `~/.local/state/oh-my-herdr/history.jsonl` (intent, category,
profile, outcome, duration and the lead's one-line quality note).
