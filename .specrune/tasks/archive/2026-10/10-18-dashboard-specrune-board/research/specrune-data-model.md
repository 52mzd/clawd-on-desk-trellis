# Research — SpecRune on-disk data model (read-only board consumption)

- Status: done
- Sources: /Users/Dae/Downloads/codes/SpecRune (.specrune/ live data, core/ Go source,
  .specrune/spec/backend/disk-format.md, dshplatform panel, specrune-board skill)
- Revision: 2026-10-18 (research dispatch: .dispatch/specrune-data-model.json)

## 1. Task directory layout

`.specrune/tasks/<MM-DD-slug>/` (constants core/internal/trellis/paths.go:48-54):

- `task.json` — metadata (schema §2)
- `prd.md` — requirements; fixed sections (disk-format.md:245)
- `design.md` — optional technical design
- `implement.md` — implementation plan with checkbox progress
- `implement.jsonl` / `check.jsonl` — context manifests, one JSON object per line
  `{"file": "<repo-rel path>", "reason": "<why>"}`
- `research/` — optional free-form markdown

Archive: `.specrune/tasks/archive/<YYYY-MM>/<MM-DD-slug>/` — same shape; in-memory-only
`__archiveMonth` key injected on load, never on disk (task.go:279).

## 2. task.json schema

Authoritative table: .specrune/spec/backend/disk-format.md:171-228. Go keeps the file
schemaless: `TaskInfo.Raw map[string]any` (task.go:117-129); LoadTask task.go:183.

Keys: id, name (== slug; fallback name→id→dirname, task.go:131), title, description,
status, dev_type, scope, package, priority (P2 default), creator, assignee,
createdAt (`YYYY-MM-DD`), completedAt (null until first completion, then immutable),
branch, base_branch, worktree_path, commit, pr_url, parent (parent DIR NAME),
children[], subtasks[], relatedFiles[], notes "", meta {}.

Status constants task.go:19-23: planning / in_progress / completed / done / canceled.
Write whitelist (task.go:37): planning|in_progress|completed|anceled — `done` removed
from writes, still accepted on reads. IsTerminalStatus = completed∨done (task.go:63).
Readers must tolerate unknown keys AND unknown statuses (custom statuses allowed via
workflow.md state blocks).

## 3. Workflow phases

.workflow.md: Phase 1 Plan (:258), Phase 2 Execute (:360), Phase 3 Finish (:386).
Phase derives from STATUS, not artifacts: DeriveWorkflowStatus (workflow.go:366):
no session pointer→no_task; pointer but dir gone→stale_<source>; task unreadable→
task_error; else task.json status verbatim. Artifact presence (hasPrd/hasDesign/
hasImpl) exposed separately in task summaries; implement.md checkboxes give
step-level progress.

## 4. Authoritative Go code

- IterActiveTasks task.go:207; IterArchivedTasks/At task.go:238/243; StatusMap
  task.go:287; ChildrenProgress task.go:299.
- **TaskSummaryOf task.go:340 — canonical summary shape**: dir,name,title,status,
  priority,assignee,children,childDone,createdAt,hasPrd,hasDesign,hasImpl,path,
  active,contextCnt,specRefs[],package?,parent?,completedAt?,archived?+archiveMonth?,
  worktreePath?

## 5. Current-task binding

No single CURRENT TASK file — PER-SESSION:
`.specrune/.runtime/sessions/<platform>_<sessionid>.json` =
`{"current_run":null,"current_task":".specrune/tasks/10-14-native-chat-port",
"last_seen_at":"...","platform":"dsh"}`. An external tool maps session→task by
reading these. (`.specrune/workspace/<dev>/` is legacy journal data, not a pointer.)
active.go:61-72 keyCurrentTask; SessionPath active.go:804.

## 6. Sessions

`.specrune/sessions/<YYYYMMDDTHHMMSS>-<hash>.md`. Frontmatter (sessionrecord.go:45):
id, session, created, developer, platform, branch, task (free-text), status, title,
legacy_source. Body: `## Session N` with Summary / Git Commits / Main Changes /
Testing / Next Steps.

## 7. Spec tree

Flat per package: `.specrune/spec/<package>/*.md` + `index.md` (packages configured
in config.yaml). index.md = topic doc with `## 文件清单 {#file-inventory}` table.
Spec docs carry `req:<doc>#<anchor>` contract ids.

## 8. CLI JSON output

`specrune task list [--mine] [--status S] [--all] --json`, `task show <ref> --json`,
`task current --json` (core/internal/cli/task.go:99-136). Rows come from
TaskSummaryOf.

## Existing dashboards (prior art)

1. **DSH panel plugin** core/internal/trellis/dshplatform/panel/lib/index.js —
   read-only board over HTTP that shells out to `specrune task list --json` /
   `task show --json` (index.js:8-14); client.js = board UI (812 lines).
2. **specrune-board skill** .../skills/specrune-board/assets/specrune-board.html
   (~2160 lines) — zero-dep single-file dashboard reading `.specrune/` directly.
3. desktop/ — Tauri "SpecRune 工作台" (built assets only).

## Data contract proposal (read-only kanban)

- Columns from status: planning | in_progress | completed | canceled; legacy
  `done`≡completed; unknown custom statuses pass through as extra columns/bucket.
- Card = TaskSummaryOf fields (direct file read also fine: glob
  `.specrune/tasks/*/task.json` + archive, tolerate unknown keys).
- Session→task binding (optional): `.specrune/.runtime/sessions/*.json`.
- Detail drill-down (optional): prd/design/implement.md (checkbox progress),
  implement.jsonl / check.jsonl manifests.
