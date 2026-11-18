---
name: oh-my-herdr
description: oh-my-herdr — OmO-style (oh-my-openagent / omo.dev) multi-agent, multi-model orchestration on top of herdr. Claude Code is the lead; it fans work out to worker agents in herdr panes (Claude Code workers, and senpi workers on OpenCode Go models) chosen per task category by a config file, checks each subscription's remaining quota before dispatching, runs tasks in parallel waves, and verifies before calling anything done. Use this whenever the user says "ulw", "ultrawork", "mass ulw", "omh", "oh-my-herdr", "omo", "sisyphus", asks to split a big job across several agents or models, wants cheap models for grunt work and strong ones for planning/review, or mentions herdr panes or worker agents — even if they don't name this skill. 適用於：「ulw」、「ultrawork」、「開多個 agent 平行做」、「用不同模型/訂閱分工」、「herdr 分工」。
---

# oh-my-herdr

You are the **lead**. You plan, route, verify and integrate. Worker agents in other herdr panes do the bulk of reading, searching and implementing. Which agent and model each worker runs is decided by the config and the current quota, not by you — don't assume workers are the same kind as you, and don't hard-code an agent in briefs.

The oh-my-herdr mod does the bookkeeping: it routes each task to a profile, watches every worker through herdr's event stream, shows the run's progress in the status line or a row above the prompt (the user's `display` option), diagnoses workers that stop without a result, and **wakes you** when a wave settles or a worker needs you. You never wait in a turn.

| OmO idea | Here |
| --- | --- |
| Sisyphus lead that doesn't stop early | You, with a plan whose tasks and gates must all close |
| Intent Gate | Every dispatch states the task's intent, category and why |
| Category → model routing | config `categories` → ordered `profiles`, skipping providers out of quota |
| Background agents in parallel | Each worker is a real herdr pane; you are woken when they finish |
| `ultrawork` / `ulw` | The loop in §2 (`/ulw <goal>` starts it) |
| `mass ulw` waves | Waves of tasks with a gate between |
| Independent review | Reviewer routed away from the implementer's model family |

## 0. Preconditions

The tools are `mcp__oh-my-herdr__omh_dispatch`, `omh_status`, `omh_collect`, `omh_spawn` and `omh_teardown`. If you don't have them, you are not running inside herdr or herdr-core (or you are a worker): tell the user to run Claude Code in a herdr pane or a Herdr app pane, with this plugin installed.

Workers run in herdr panes or in herdr-core (`hc`) terminals, as config.json's `backend` says. A worker whose pane reads `hc:t7` is hc terminal `t7`: read its screen with `hc read t7`, not `herdr`.

`/omh check` (the user runs it, or you suggest it) shows the config in effect, the agents it needs, and current quota. If something is missing, point the user at `references/setup.md` — a misconfigured worker fails in its pane and wastes a wave.

## 1. Decide whether to orchestrate

Fan-out costs 10–30 s per worker plus integration. Do it yourself when the task is small, touches one or two files, or every step depends on the previous step's exact output. Orchestrate when there are independent chunks (several modules, research alongside implementation, a migration across many files) or the user said `ulw` / `ultrawork` / `mass ulw`.

## 2. The ultrawork loop

1. **Explore — in parallel, before the plan.** Read the entry points yourself and fan the rest out; don't read a large area alone. A `ulw` / `ultrawork` request *is* the user explicitly asking for helpers, so the usual "don't spawn agents unless asked" restraint does not apply here. Two kinds, mix them freely:

   | | Claude Code subagents | herdr scouts |
   | --- | --- | --- |
   | How | Agent tool, `subagent_type: "Explore"` with `model: "haiku"` (or `"Plan"` for a design question). Launch them **in one message** so they run at once, each owning a different area | `omh_dispatch` with task id `scout-<name>` and intent `explore` (or `research` → `librarian`). No plan needed |
   | Runs on | haiku for Explore: always pass `model: "haiku"` unless the user asked for another model or the question needs judgment, not finding (then `"sonnet"`). Inside your turn | a routed model: in a worker pane, or as a subagent the mod starts and tracks (`sub-*` profiles) |
   | Best for | quick look-ups: where is X, how does Y flow | long reads, a whole subsystem, external docs |
   | Then | results come back in the same turn | **end your turn**; you are woken once every scout is back, then `omh_collect` each (that closes it and frees the worker; `omh_status` `abandon` closes one that brought nothing) |

   Ask every helper for file:line evidence, and spot-check what you build the plan on. Scouts are read-only and own no files; anything that changes files waits for the approved plan. Exploring that needs the plan's own waves (e.g. a big audit whose result *is* the deliverable) can still be wave 1 of the plan.
2. **Intent Gate.** For each task decide its *intent* and *category*:

   | intent | meaning | usual category |
   | --- | --- | --- |
   | explore | find things, read code, answer questions | explore |
   | research | external docs, compare options | librarian |
   | implement | write code | deep / quick / visual-engineering |
   | fix | fix a bug | deep / quick |
   | review | judge someone else's work | reviewer / oracle |
   | plan | architecture, breaking work down | oracle |
   | write | docs and prose | writing |

   An unusual pair is allowed; your `rationale` says why.
3. **Draft the plan, then stop.** `omh_status` with `action: "draft"`, `markdown` and `name`: the plan in prose — goal, what exploring found (file:line), approach, each task with its acceptance check, risks, open questions. `name` is a short slug for the work (`"model-groups"`); it starts the run `.omh/runs/<date>-<name>/` and the plan is saved there as `draft.md`. Give the user a short summary and the path, mention that `/omh plan` previews it in a pane beside you, then **end your turn**. The user reads (or edits) it and approves with `/omh approve`, which renames it to the run's `plan.md` and wakes you with a prompt to derive the waves; if they ask for changes, draft again **without** `name` (that revises the current run). Until then `action: "plan"` is refused.
4. **Derive the waves.** Once plan.md is approved, `omh_status` with `action: "plan"` and the plan.json that splits it into waves:

   ```json
   { "goal": "…",
     "waves": [
       { "id": 1, "gate": "npm test passes; reviewer finds no blockers",
         "tasks": [
           { "id": "T1", "title": "orders endpoint", "intent": "implement", "category": "deep",
             "owns": ["src/api/orders.ts"], "deps": [] } ] } ] }
   ```

   Tasks in one wave must not own the same files (the tool refuses it); `deps` point at earlier waves. Every wave needs a gate you can actually check. `category` is a routing name from the config (`deep`, `reviewer`, …), not the intent. A rejected plan keeps its approval: fix it and send it again. To change the plan mid-run, draft again without `name`, stop, and wait for `/omh approve` (the old plan.md is kept as `plan.v<n>.md`); for new work, draft with a new `name`. For a risky plan, make wave 1 an `oracle` critique.
5. **Dispatch the wave.** `omh_dispatch` per task: `task`, `intent`, `category`, a one-line `rationale`, and a self-contained `brief` (template in `references/roles.md`). The files the task owns and the reporting contract are appended for you. Leave `worker` and `profile` out unless the user asked for a specific one — routing picks a profile with quota and starts or reuses a worker. For a review task, pass `reviews: <task id>` so the reviewer comes from another model family.
6. **Stop.** After dispatching, end your turn (or do unrelated work). Do not sleep, poll, or run `herdr agent wait`. The mod sends you a message:
   - **Wave settled** — a table of every task's state. Continue at step 7.
   - **Worker blocked / stalled / idle without a result / gone** — with a diagnosis (`quota-exhausted`, `permission-prompt`, `config-error`, `crashed`, `interrupted`, or `unknown` with the screen). Act on it: re-dispatch the task without naming a worker when quota ran out; tell the user what to fix for a config error. **Never answer a worker's permission dialog that changes files, runs commands or grants access without asking the user.** Other workers keep running meanwhile.
7. **Verify.** `omh_collect` each reported task. The report is a claim: run the tests/build yourself, read the diff, check the acceptance criteria. Then `omh_status` with `action: "verified"` and a one-line `quality` note on how good the result was (what held up, what you had to fix) — this builds the history used to judge profiles. A result you can't use: fix it with a follow-up dispatch of the same task (it records a retry), or `action: "abandon"` with a quality note.
8. **Gate.** When every task of the wave is verified or abandoned, run the gate's check (typically a `reviewer` task in the next wave, plus the test suite) and `omh_status` with `action: "gate"`. The next wave can't be dispatched until then.
9. **Finish.** All gates passed → final acceptance check, tell the user what changed, the evidence it works, and what's still open. Then `omh_teardown` unless they want the workers kept.

`mass ulw` is the same loop with more waves and workers per wave; stay within the config's `max_concurrent`.

## 3. Progress and the ground truth

The status line (or a row above the prompt) shows the run's progress (`██░░░░ 2/5`, yellow when a task needs the user); `/omh board` opens the full board in a pane; `omh_status` (action `show`) prints it for you. Its source is the run's files under `.omh/`, read fresh — trust it over your memory, especially after a compaction (the mod appends the board to the conversation after one).

## 4. Routing and quota

- **profiles** — a named agent + model: `agent` (`claude`, `senpi`, … from `assets/agents.json` or the config's `agents`), `args` passed to that agent's CLI, and `family` (for review independence).
- **subagent profiles** (`agent: "subagent"`) — the worker is a Claude Code subagent of yours, started by `omh_dispatch` and tracked like a pane worker (board, wake-ups, diagnosis), marked ◆. Its final reply becomes its result.md. You dispatch it the same way and are woken the same way; its own "task finished" notification is held back. It shares your Claude quota and permissions, runs one task (never pass it as `worker`), and `omh_teardown` only forgets one still running.
- **categories** — an ordered list of profiles; the first whose provider has quota wins, preferring one outside any avoided family.
- **quota** — Claude and OpenCode Go usage is read from their APIs before routing. A provider at or over the threshold is skipped; when every candidate is out, dispatch fails with `no-profile` — do the task yourself if it's small, or tell the user which providers are out and when they reset.

If the user wants a specific agent or model, pass `profile`. If no profile fits, tell the user what to add to the config rather than inventing CLI flags. Config format: `references/setup.md`.

## 5. Results come back as files

Every brief tells the worker to write `.omh/runs/<run>/<task>/result.md` and reply `DONE <path>` or `BLOCKED <reason>`. Read the file (`omh_collect`), not the screen; the screen is only for diagnosis, which the mod does for you.

## 6. Things that go wrong

- **A Claude worker stops at "Is this a project you created or one you trust?"** — a folder Claude Code hasn't been trusted in. Ask the user to accept it in that pane once.
- **`config-error`** — wrong model id, missing login or API key. Re-dispatching fails the same way; tell the user.
- **`quota-exhausted`** — re-dispatch without `worker`/`profile`; routing skips the exhausted provider.
- **Two workers edited the same file** — the plan's `owns` was wrong. Tear down, re-plan with proper ownership.
- **A subagent worker is `blocked`** — it is waiting on a permission prompt in *this* session. Ask the user before approving anything that changes files or grants access.
- **The worker went off-script** — check its brief (`.omh/runs/<run>/<task>/brief.md`); the fix is almost always a clearer brief, not a stronger model.

Raw herdr commands, for when you need to look at a herdr pane yourself (for an hc worker: `hc read <address>`, `hc get <address>`; `hc --skill` has the rest): `references/herdr-cheatsheet.md`. For anything beyond it (pane layout, waits, read sources, safety rules), load the bundled `herdr` skill — herdr's own guide, shipped with this plugin.
