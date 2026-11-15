# Roles, briefs and worker counts

Categories are roles. Which agent/model fills a role is the config's business (`categories` → `profiles`); this file is about what each role is for. Each role has a preamble in `assets/preambles/<category>.md` that `omh_dispatch` puts in front of the brief. A config category can point at its own preamble with `{"profiles": [...], "preamble": "path.md"}` (relative to the config file). New categories work automatically — add them to the config and, optionally, write a preamble.

| Category | Use for | Writes code? | Typical profile |
| --- | --- | --- | --- |
| `oracle` | Critiquing a plan, root-causing a hard bug, choosing between designs | No | strongest reasoning model, different family from the lead |
| `deep` | A well-scoped chunk needing many edits and its own test loop | Yes | strong coding model on a high-volume quota |
| `visual-engineering` | UI components, layout, styling, interaction polish | Yes | model with good frontend taste |
| `explore` | "Where is X handled", "every caller of Y" — file:line facts | No | fast, cheap model |
| `librarian` | Library docs, changelogs, API references | No | cheap model with long context |
| `quick` | Renames, boilerplate, mechanical edits | Yes | cheapest model |
| `writing` | READMEs, docs, changelogs, comments | Yes (prose) | cheap model that writes well |
| `reviewer` | Gate: diff vs acceptance criteria | No | strong model, **different family from the implementer** |

## Brief template

The worker has none of your context; make the brief self-contained.

```markdown
# Task <task-id>: <one-line title>

## Goal
<What done looks like, in one or two sentences.>

## Context
<Only what the worker needs: relevant paths, the interface to respect, explore findings.>

## Acceptance criteria
- <Checkable: a command and expected result, a test that must pass, an observable behaviour.>

## Constraints
<Don't touch X; follow the pattern in Y; no new dependencies; don't commit.>
```

`omh_dispatch` appends the files the task owns (from the plan) and the reporting contract (write `result.md`, reply `DONE <path>` / `BLOCKED <reason>`), so the brief doesn't need a "You own" section of its own unless you want to explain it.

For a reviewer brief, include the base ref to diff against (e.g. `git diff main...HEAD -- <paths>`), the acceptance criteria, and the commands to run.

## How many workers

- Explore phase (before plan.md): 2–4 helpers in parallel, each on a different area — `Explore` subagents for quick look-ups, `scout-*` dispatches (`explore`, 0–1 `librarian`) for long reads. A scout brief is the same template; it gets a read-only "Files you own: none" section instead of the plan's files.
- Implementation wave: one worker per independent file-ownership group, within `max_concurrent`.
- Each gate: one `reviewer`.

`omh_dispatch` reuses a free worker on the routed profile, or starts one. To keep a worker's session context for a related follow-up, pass `worker: <name>`; for unrelated work leave it out (stale context hurts). A reused worker keeps its model whatever the category says.

For a review, pass `reviews: <task id>`: the reviewer is routed away from that task's model family.
