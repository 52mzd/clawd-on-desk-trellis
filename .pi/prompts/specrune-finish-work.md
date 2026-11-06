# Finish Work

Wrap up the current session: verify the tree, record the session, and archive
the finished task(s). Code commits are NOT done here — they belong to the
workflow's commit step and must already be in history before you start.

That step is named rather than numbered on purpose: step numbers differ per
workflow template (native and tdd disagree), and a number written here would
point at the wrong step under one of them — silently, since `--step` returns
empty with exit code 0 for a number that does not exist.

## Step 1: Survey current state

```bash
specrune context --mode record
git status --porcelain
```

Record mode prints:

- **Active tasks** — check whether any besides the current one are actually
  done and should be archived this round.
- **Git status** — what's dirty.
- **Recent commits** — the hashes Step 3 needs for `--commit`.

If record mode surfaces other completed tasks, surface them with a one-shot
confirmation: "These N tasks look done — archive them too this round? [y/N]"
Default is no; the session's bound task is archived in Step 4 regardless.

## Step 2: Sanity check — classify dirty paths

Filter out paths under `.specrune/workspace/`, `.specrune/tasks/`, and
`.specrune/sessions/` — archive and session-record writes made by this very flow
land in `tasks/` and `sessions/`; legacy `workspace/` is read-only history. For
each remaining path, decide whether it belongs to **this task** or to **other
parallel work** (another terminal window, an unrelated edit):

- Paths referenced in this task's `prd.md` / `implement.jsonl` /
  `check.jsonl` → this task
- Paths in code areas matching the task's stated scope, or that you remember
  editing this session → this task
- Paths in unrelated areas you have no recollection of touching → other work

Then route:

- **Looks like this task's work** — bail out with:
  > "Working tree has uncommitted code changes from this task: `<list>`.
  > Commit them (the workflow's commit step) before running finish-work."

  Do NOT run `git commit` here. Do NOT prompt the user to commit. Go back to
  the commit step and drive the batched commit there.
- **All remaining paths look unrelated** — report them once and continue:
  > "FYI, dirty files outside this task's scope — leaving them alone: `<list>`."
- **Genuinely unsure** — ask once: "Are `<list>` this task's work I forgot to
  commit, or another window's? (commit / ignore)" — then route per the answer.

## Step 3: Record the session

Verify every acceptance criterion in `prd.md` first — the summary claims what
happened, so verify before writing it down.

```bash
specrune session record --title "Session title" \
  --commit "hash1,hash2" \
  --summary "Brief summary of what happened" \
  --next-step "What the next session should pick up first"
```

**Record before archiving.** The record carries the `task:` field naming the task
this session belonged to, and it resolves that from the active-task pointer.
`task archive` clears the session pointers aimed at the task it moves, so
archiving first leaves the field empty — and the command still exits 0, so
nothing reports the loss. The session is the one thing that says which task the
work belonged to; archive it last.

Use the work-commit hashes from Step 1 (`git log --oneline` also shows them),
not the archive commits from Step 4. This writes the session record
(`.specrune/sessions/<id>.md`) and commits.

**`--next-step` is for the next session, not this one.** It is the only field
that answers "where did I leave off" — the summary says what happened, the
Next Steps say what to do about it first. Write it for a session with no
memory of this one: name the concrete next action, not a topic. Repeat the
flag for several items; the first one is what gets surfaced.

Session entries written before this existed have no Next Steps. Their absence
in `specrune session log` is normal — do not go back and backfill them.

## Step 4: Finish and archive

```bash
specrune task finish
specrune task archive <task>
```

At minimum: the session's bound task (if any), plus any extras the user
confirmed in Step 1. Archive moves the directory to
`.specrune/tasks/archive/<YYYY-MM>/`, clears session pointers aimed at it, and
commits. It also flips the status to `completed` — **except for a `canceled`
task, which keeps its status and its empty completion date**, so archiving an
abandoned task never rewrites it as finished. Skip this step when there is no
task to archive.

Final git log order: `<the work commit>` → the session-record commit
→ `chore(task): archive ...`.
