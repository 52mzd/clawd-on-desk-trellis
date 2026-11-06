# Continue Current Task

Resume work on the current task — pick up at the right step of
`.specrune/workflow.md` instead of re-deriving the flow from scratch.

---

## Step 1: Load current context

```bash
specrune task current
specrune context --mode phase
```

`task current` confirms the session's binding, git state, and where the phase
index says you are. There is exactly one binding per session; switching tasks
is `specrune task start <task>`, never a second pointer.

## Step 2: Route by status and artifacts

This command replaces the user needing to remember the SpecRune flow; it does
not itself approve implementation.

- `planning` + no `prd.md` → the requirement exploration step (load
  `specrune-brainstorm`)
- `planning` + `prd.md` only → decide lightweight vs complex. Lightweight can
  move on to manifest curation; complex returns to requirement exploration to add
  `design.md` + `implement.md`.
- `planning` + artifacts complete + `implement.jsonl` / `check.jsonl` empty → the
  manifest curation step (`specrune task add-context`)
- `planning` + manifests curated → the activation step — which asks the user to
  confirm first; follow that step, it owns the gate
- `in_progress` + implementation not started → the implement step
- `in_progress` + implementation done, not yet checked → the quality check step
- `in_progress` + check passed → the spec update step → the commit step → the
  archive step
- `completed` / `done` → Phase 3 is still open: the spec update, the commit, then
  `specrune task archive <task>`. The two spellings mean the same thing (`done`
  was folded into `completed`); both are still read for older repositories.
- `canceled` → abandoned, not finished. There is no wrap-up and it must not be
  flipped to completed — that would erase the record of why. Archive it to close
  the record, or pick it up again with `specrune task start <task>` — it flips
  the status back to `in_progress` and records the pickup in `notes`, but cannot
  know how far you got, so add `--note "…"` via
  `specrune task set-status <task> in_progress` to say so.
- no task bound → run the `specrune-start` flow instead of guessing

**Step numbers are deliberately absent from this table.** This command is shared
by every workflow template, and the numbering differs between them — native's
Phase 3 is `3.1/3.2/3.3/3.4`, tdd's is `3.1/3.2/3.3`. Hardcoding one template's
numbers here made the routing point at the **wrong steps** under the other, and
silently: `--step` returns empty with exit code 0 for a number that does not
exist, so two `[required]` steps were skipped with no error. Route by role; get
the current template's numbers from the per-turn breadcrumb (each template
carries its own) or from the step headings in `.specrune/workflow.md`.

Phase rules (full detail in `.specrune/workflow.md`):

1. Run steps **in order** within a phase — `[required]` steps are gates.
2. `[once]` steps are already done if the required output exists.
   `prd.md` alone is enough only for lightweight tasks; complex ones also need
   `design.md` and `implement.md`.
3. Going back to an earlier phase is allowed when discoveries require it.

## Step 3: Load the specific step

Once you know which step to resume at:

```bash
specrune context --mode phase --step <X.X>
```

Follow the loaded instructions. After each `[required]` step completes, move
to the next.

---

## Reference

The canonical guidance lives in `.specrune/workflow.md`. This command is only
an entry point.
