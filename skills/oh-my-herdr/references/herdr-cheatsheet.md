# herdr commands used by this skill (herdr ≥ 0.9)

Source: https://herdr.dev/docs/agent-automation/ and /docs/socket-api/. Run `herdr --help` / `herdr agent --help` if a flag errors — the CLI evolves quickly.

IDs: panes are `w1:p2`, tabs `w1:t1`. Creation commands print JSON; capture ids with `jq`, never predict them.

## Layout
```bash
herdr tab create --label omh-workers            # .result.tab, .result.root_pane.pane_id
herdr pane split <pane> --direction right --no-focus   # .result.pane.pane_id
herdr pane split <pane> --direction down  --no-focus
herdr pane close <pane>
herdr pane list                                 # all panes (JSON)
herdr pane current                              # the caller's own pane
```

## Agents
```bash
herdr agent start <name> --kind <kind> --pane <pane> [--timeout MS] -- <agent args>
herdr agent prompt <name> "text"                 # submit (non-blocking)
herdr agent prompt <name> "text" --wait --timeout 600000
herdr agent wait <name> --until idle --until done --until blocked --timeout MS
herdr agent read <name> --source recent-unwrapped --lines 120
herdr agent send-keys <name> esc|enter|up|ctrl+c
herdr agent list
herdr agent explain <name>                       # why herdr thinks it's in a state
```
Names match `[a-z][a-z0-9_-]{0,31}` and are released when the agent exits.

States: `working`, `blocked` (approval/question UI on screen), `idle`, `done` (idle, not yet seen), `unknown`.

## Plain processes (tests, dev servers)
```bash
herdr pane run <pane> "npm test"
herdr pane wait-output <pane> --regex "passed|failed" --timeout 120000
herdr pane read <pane> --source recent-unwrapped --lines 80
```

With herdr-core (the lead in an hc terminal), the same with `hc`:
```bash
hc run --name omh-test --cwd /repo -- npm test          # waits like a shell; exit code is the test's
hc run --bg --no-notify --name omh-dev -- npm run dev   # a server: comes back at once
hc wait <t>                                             # until it stops working
hc read <t>                                             # its screen and history
hc kill <t>
```

## Errors you will see
- `agent_not_ready` — startup hit a prompt; read the pane.
- `agent_blocked` — prompt refused because a dialog is open.
- `agent_prompt_stalled` — never saw it start working within 5 s; read before retrying.
- `timeout` — exit 1, JSON on stderr; input may still have been sent.

## Workspaces
```bash
herdr workspace create --cwd ~/project --label api   # .result.root_pane.pane_id
```

## Launching an agent herdr has no --kind for (forks, wrappers)
`agent start` only runs herdr's canonical binary for a kind, so oh-my-herdr launches such agents itself:
```bash
herdr pane run "$pane" "cd /repo && env HERDR_AGENT=pi senpi --provider opencode-go --model kimi-k3"
# poll until herdr sees an agent in that pane (senpi reports its own state; HERDR_AGENT picks screen rules)
herdr agent get "$pane"            # fails until detected, then .result.agent.status = idle
herdr agent rename "$pane" worker1 # from here on, address it by name
```

The built-in `opencode` profile uses the same `command` launch so the pane gets `OMH_ROLE=worker`
(the plugin is dormant there) while an interactive opencode worker starts:
```bash
herdr pane run "$pane" "cd /repo && env HERDR_AGENT=opencode OMH_ROLE=worker opencode"
```
