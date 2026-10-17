# Research — Trellis Dashboard integration architecture (mirror targets)

- Status: done
- Sources: /Users/Dae/Downloads/codes/clawd-on-desk (src/, test/, docs/)
- Revision: 2026-10-18 (research dispatch: .dispatch/specrune-board-architecture.json)

## 1. Dashboard surface

- DOM: src/dashboard.html — header view switch `#viewSwitch` (`#viewSessionsTab` +
  `#viewTrellisTab`) :3522-3525; session-embedded panel `#trellisPanel`
  (dashboard.html:3530); second main `#trellisView` :3534; task-detail overlay
  `#trellisDetailOverlay` :3536; UMD script order :3537-3541
  (dashboard-trellis-panel.js → trellis-doc-renderer.js → dashboard-renderer.js).
- Renderer: src/dashboard-renderer.js — globalThis destructure :5-17, element refs
  :51-56; `activeView` ("sessions"|"trellis") :1147; `switchDashboardView` :3150-3160;
  tab binding :3176-3178; title/count swap :5206-5217.
  - Embedded panel: `renderTrellisPanel()` :1347-1411 (aggregate → group → phase
    sections plan/execute/check/finish/done/other), row builder :1268-1344.
  - Independent view state :1142-1166; fetchers `refreshTrellisViewRoots` :1420-1448,
    `refreshTrellisActive` :1450-1477, `refreshTrellisViewArchive` :1480-1513.
  - Split view (left rail + detail pane): `trellisSplit` :1599-1625; selection
    fast path :1723-1760; keyboard nav :5264-5286; row builder :1940+; detail card
    `buildTrellisDetailCard` :3984+; overlay `openTrellisDetail` :3639+.
  - Spec tree :2716-2721; archive month grouping :1506-1513.
  - Events: `onNavigateTrellis` :5333-5352, `onTrellisRootsChanged` :5354-5359.

## 2. IPC surface

- Preload bridge src/preload-dashboard.js :65-110: onNavigateTrellis :69,
  onTrellisRootsChanged :73, getTrellisTaskDetail :87, getTrellisNetworkOverview :88,
  getTrellisTaskDoc :89, getTrellisSpecTree :90, getTrellisSpecDoc :91,
  getTrellisArchiveList :92, getTrellisActiveList :93, listTrellisRoots :94,
  addTrellisRoot :95 (main-side dir picker), removeTrellisRoot :96, removeTrellisPick :97.
- Handlers ALL in src/session-ipc.js: task-detail :187-205, network-overview :213-228,
  task-doc :234-255, spec-tree :261-275, spec-doc :277-295, archive-list :302-305,
  roots-list :312-315, roots-add :316-319, roots-remove :320-335, pick-remove :337-352,
  active-list :357-360. Every handler gated by `rejectUntrustedDashboardEvent`
  (session-ipc.js:106-125) + exact-key payload validation → `{status:"invalid"}`.
- Push: `dashboard:trellis-roots-changed` from src/main.js:2578;
  `dashboard:navigate-trellis` from main.js:3019-3031.
- Getter injection: session-ipc.js:47-93; main.js wires at 5530-5610
  (`_trellisActivity.readX`, roots store; listTrellisRoots recency sort :5581-5598).

## 3. Root discovery / registration

- Polling owner `_trellisActivity = createTrellisActivity({...})` main.js:2529-2554
  (getLiveSessions :2536, onTrellisUpdate → snapshot :2547, onRootDiscovered →
  autoRegisterDiscoveredRoot :2552). Self-timer 5s active / 15s idle
  (trellis-activity.js:54-55).
- Roots store src/trellis-roots.js: persists `~/.clawd/trellis-roots.json`, v1 shape
  `{version, roots, picks:[{picked, roots}]}` :4-10, MAX_ROOTS=64 :23,
  API {load,list,listPicks,recordPick,removePick,add,remove,registerScanRoots} :229.
- Auto-register `autoRegisterDiscoveredRoot` main.js:2585-2604 (projectRoot =
  dirname(.trellis), stray ~/.trellis guard).
- Add/remove `pickAndRegisterTrellisRoot` main.js:2643-2711 (isDirectProjectRoot vs
  listChildProjectRoots), `removeRegisteredTrellisRoot` :2712, `removeTrellisPick`
  :2723; broadcast :2569-2579. Settings→Dashboard scan-roots feed via trellis-ipc.js
  :196-198,:279-294 and main.js:2606-2620.
- Scanner (Settings side): src/trellis-scanner.js, wired main.js:94.

## 4. Data reading layer

- src/trellis-activity.js (1640 lines), strictly read-only. findTrellisRoot memoized,
  depth 8 :56; session pointers `.trellis/.runtime/sessions` :662-705; readTaskInfo
  :715-770 (task.json + prd stat + implement checklist); readTaskDetail(cwd,taskPath)
  :889-925 → `{status:"ok", task:{title, phase, rawStatus, priority, createdAt,
  completedAt, completedAtRealMs, archived, checklist:{items,done,total},
  docs:[{name,size}]}}`; readTaskDoc :972-1003; readSpecTree :1099-1141;
  readSpecDoc :1149-1188; readTaskNetworkOverview :1214-1348; readArchiveList
  :1369-1413; readActiveList :1458-1482 (ACTIVE_LIST_MAX 200); readHudTaskPanel
  :1496-1555; readRootRecencies :1583.
- Helpers required at trellis-activity.js:53-64: trellis-checklist.js,
  trellis-phase.js, trellis-archive.js, trellis-doc-renderer.js.
- Per-session binding shape (snapshot `entry.trellis`): `{taskPath, title, phase,
  progress:{done,total}|null, parallelCount}`.

## 5. i18n

Single file src/i18n.js, 7 locales (en :9, zh :619, zh-TW :1221, ko :1826, ja :2428,
pt-BR :3030, es :3632). Trellus keys `dashboardTrellis*` (~40+; en :135-172+) and
`sessionHudTrellisPhase{Plan,Execute,Check,Finish,Done}` (en :303-307) shared with HUD.

## 6. Styling

All inline in dashboard.html `<style>`: trellis tokens :281-289, `.trellis-panel`
:292-309, phase colors light :429-433 / dark :436-440, progress chips :443-518, tree
depth :520-537, archive :539-603 + :825-895, view styles :604-670, split view
~:1200-2300, detail overlay ~:3980s. Static CSS guards asserted by tests
([hidden]{display:none} :301,:606).

## 7. Tests

- test/dashboard-trellis-panel.test.js (2786 lines, 83 tests) — fake DOM + static CSS
  guards. CAVEAT: imports buildTrellisTree/boardPhaseFor/bucketByBoardPhase/
  TRELLIS_TREE_DEPTH_CAP which no longer exist in src (dead destructures, suite green)
  — mirror tests against actual exports.
- test/trellis-activity.test.js (2170 lines) — injected fake fs.
- Siblings: trellis-archive/checklist/phase/doc-renderer/roots/scanner/ipc/runtime/
  cli/platforms/version tests; settings-tab-trellis(.wizard)(-static); recap-trellis.

## 8. Docs

docs/project/trellis-settings-panel.md (Settings side; Dashboard side undocumented).
docs/releases/release-v1.2.0-trellis.1.0.md:42 (TRELLIS_ROOTS_MAX=64 fix).

## Touch-points a specrune board must mirror

1. New pure aggregation module src/dashboard-specrune-panel.js + script tag
   (dashboard.html ~:3538).
2. Renderer src/dashboard-renderer.js: refs :51-56, third tab / view extension
   (:1147, :3150-3180, :5206-5217), render blocks, event wiring :5333-5359.
3. dashboard.html DOM :3522-3536 + inline styles.
4. preload-dashboard.js :87-97 (+ push channels).
5. session-ipc.js handlers :187-360 + dep injection :47-93; main.js getters
   :5530-5610, broadcast :2569-2579.
6. New reading layer src/specrune-activity.js over `.specrune/` + helper twins
   (phase/checklist/doc-renderer/archive).
7. Roots store: reuse createTrellisRootsStore with a second file
   (~/.clawd/specrune-roots.json) or generalize; add/remove/pick flow main.js
   :2585-2731.
8. i18n: `dashboardSpecrune*` + phase keys in all 7 locale blocks.
9. Tests: dashboard-specrune-panel.test.js + specrune-activity.test.js.
10. Docs: docs/project/specrune-board.md.

## Noteworthy

- This workspace itself migrated .trellis → .specrune (git status: renames; live
  .specrune/ dir) — dogfooding target.
- Prior art in this repo: .agents/skills/specrune-board/assets/specrune-board.html.
