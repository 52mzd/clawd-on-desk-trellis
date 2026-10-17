"use strict";

// 10-18 specrune board: SpecRune (.specrune) read-only support in the
// trellis activity stack. Pins the dual-workflow contracts:
//   - root resolution recognizes .specrune (with .trellis priority when a
//     project carries both — mid-migration safety)
//   - dsh session pointers bind deepseek-harness sessions (real-pointer
//     evidence, see trellis-phase PLATFORM_ALIASES)
//   - taskPath prefixes, workflow provenance fields and the status→phase
//     mapping (legacy "done" ≡ completed; canceled never renders)
//   - renderer contract: aggregation passthrough + badge CSS/i18n guards

const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");

const { createTrellisActivity } = require("../src/trellis-activity");
const { derivePhase } = require("../src/trellis-phase");
const { aggregateTrellisTasks } = require("../src/dashboard-trellis-panel");

const PROJECT = path.resolve("/proj");
const CWD = path.join(PROJECT, "app");

// ── fakes (mirrors test/trellis-activity.test.js, minimal surface) ──

function makeFakeFs() {
  const files = new Map();
  const writeOps = [];
  const key = (p) => path.resolve(p);
  function isDir(k) {
    if (k === path.parse(k).root) return true;
    for (const f of files.keys()) {
      let d = path.dirname(f);
      for (;;) {
        if (d === k) return true;
        const parent = path.dirname(d);
        if (parent === d) break;
        d = parent;
      }
    }
    return false;
  }
  function enoent() {
    const err = new Error("ENOENT");
    err.code = "ENOENT";
    return err;
  }
  const fsApi = {
    async readFile(p) {
      const k = key(p);
      if (!files.has(k)) throw enoent();
      return files.get(k);
    },
    async stat(p) {
      const k = key(p);
      if (files.has(k)) return { isDirectory: () => false, mtimeMs: 0 };
      if (isDir(k)) return { isDirectory: () => true, mtimeMs: 0 };
      throw enoent();
    },
    async readdir(p) {
      const k = key(p);
      if (!isDir(k)) throw enoent();
      const names = new Set();
      for (const f of files.keys()) {
        const d = path.dirname(f);
        if (d === k) {
          names.add(path.basename(f));
          continue;
        }
        let cur = d;
        for (;;) {
          const parent = path.dirname(cur);
          if (parent === k) {
            names.add(path.basename(cur));
            break;
          }
          if (parent === cur) break;
          cur = parent;
        }
      }
      return [...names];
    },
  };
  const syncApi = {
    readdirSync(p, opts) {
      if (!opts || opts.withFileTypes !== true) throw new Error("fake readdirSync needs withFileTypes");
      const k = key(p);
      if (!isDir(k)) throw enoent();
      const names = new Set();
      for (const f of files.keys()) {
        const d = path.dirname(f);
        if (d === k) {
          names.add(path.basename(f));
          continue;
        }
        let cur = d;
        for (;;) {
          const parent = path.dirname(cur);
          if (parent === k) {
            names.add(path.basename(cur));
            break;
          }
          if (parent === cur) break;
          cur = parent;
        }
      }
      return [...names].map((name) => ({
        name,
        isDirectory: () => isDir(path.join(k, name)),
      }));
    },
    readFileSync(p) {
      const k = key(p);
      if (!files.has(k)) throw enoent();
      return files.get(k);
    },
    statSync(p) {
      const k = key(p);
      if (files.has(k) || isDir(k)) {
        return { isDirectory: () => (files.has(k) ? false : isDir(k)), mtimeMs: 0 };
      }
      throw enoent();
    },
  };
  return {
    fsApi,
    syncApi,
    writeOps,
    add(p, content) {
      files.set(key(p), content);
      return p;
    },
  };
}

function makeHarness({ sessions = new Map() } = {}) {
  const fakeFs = makeFakeFs();
  const updates = [];
  const activity = createTrellisActivity({
    state: { sessions },
    fs: fakeFs.fsApi,
    syncFs: fakeFs.syncApi,
    now: () => 1758000000000,
    onTrellisUpdate: (ids) => updates.push(ids),
  });
  return { fakeFs, updates, activity };
}

function makeTimers() {
  const timers = { pending: [] };
  timers.setTimeoutFn = (fn) => { timers.pending.push(fn); return timers.pending.length; };
  timers.clearTimeoutFn = () => {};
  timers.runDue = async () => {
    const due = timers.pending.splice(0);
    for (const fn of due) fn();
    for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r));
  };
  return timers;
}

function addSpecruneTask(fake, taskName, taskJson, { implementMd = null, month = null } = {}) {
  const base = month
    ? path.join(PROJECT, ".specrune", "tasks", "archive", month)
    : path.join(PROJECT, ".specrune", "tasks");
  const dir = path.join(base, taskName);
  fake.add(path.join(dir, "task.json"), JSON.stringify(taskJson));
  if (implementMd) fake.add(path.join(dir, "implement.md"), implementMd);
  return dir;
}

function addDshPointer(fake, rawSessionId, currentTask) {
  // Real shape from this repo's own .specrune/.runtime/sessions/.
  return fake.add(
    path.join(PROJECT, ".specrune", ".runtime", "sessions", `dsh_${rawSessionId}.json`),
    JSON.stringify({
      current_run: null,
      current_task: currentTask,
      last_seen_at: new Date(1758000000000 - 5 * 60 * 1000).toISOString(),
      platform: "dsh",
    })
  );
}

const SESSION_ID = "session-363694cf-98c8-4adb-88b2-170ed32ccc05";

// ── root resolution + session binding ──

describe("specrune root resolution & binding", () => {
  it("binds a deepseek-harness session onto a .specrune task via its dsh pointer", async () => {
    const timers = makeTimers();
    const fakeFs = makeFakeFs();
    const updates = [];
    // The snapshot entry id is a scoped key; the pointer file is named
    // after the RAW id (the dual-source truth contract).
    const sessions = new Map([["s1.abc.def", {
      agentId: "deepseek-harness",
      cwd: CWD,
      rawSessionId: SESSION_ID,
    }]]);
    const activity = createTrellisActivity({
      state: { sessions },
      fs: fakeFs.fsApi,
      syncFs: fakeFs.syncApi,
      now: () => 1758000000000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      onTrellisUpdate: (ids) => updates.push(ids),
    });
    addSpecruneTask(fakeFs, "10-18-dashboard-specrune-board", {
      title: "Dashboard 集成 SpecRune 工作流看板",
      status: "in_progress",
      subtasks: [],
    });
    addDshPointer(fakeFs, SESSION_ID, ".specrune/tasks/10-18-dashboard-specrune-board");

    activity.start();
    await timers.runDue();

    const info = activity.getTrellisInfo("s1.abc.def");
    assert.ok(info, "session binds");
    assert.strictEqual(info.taskPath, ".specrune/tasks/10-18-dashboard-specrune-board");
    assert.strictEqual(info.phase, "execute");
    assert.strictEqual(info.workflow, "specrune");
    assert.deepStrictEqual(fakeFs.writeOps, [], "read-only red line holds");
  });

  it("prefers .trellis when a project carries both workflow dirs (mid-migration)", async () => {
    const sessions = new Map([["pi:mine", { agentId: "pi", cwd: CWD, rawSessionId: "pi:mine" }]]);
    const h = makeHarness({ sessions });
    h.fakeFs.add(
      path.join(PROJECT, ".trellis", "tasks", "t-old", "task.json"),
      JSON.stringify({ title: "Old", status: "in_progress", subtasks: [] })
    );
    h.fakeFs.add(
      path.join(PROJECT, ".trellis", ".runtime", "sessions", "pi_mine.json"),
      JSON.stringify({
        platform: "pi",
        last_seen_at: new Date(1758000000000 - 60_000).toISOString(),
        current_task: ".trellis/tasks/t-old",
        current_run: null,
      })
    );
    addSpecruneTask(h.fakeFs, "s-new", { title: "New", status: "in_progress", subtasks: [] });

    const roots = await h.activity.resolveProjectRoot(CWD);
    assert.strictEqual(roots, PROJECT);
    const detail = await h.activity.readTaskDetail(CWD, ".trellis/tasks/t-old");
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.task.workflow, undefined);
  });

  it("isDirectProjectRoot / listChildProjectRoots recognize specrune projects", async () => {
    const h = makeHarness();
    addSpecruneTask(h.fakeFs, "a", { title: "A", status: "planning" });
    assert.strictEqual(await h.activity.isDirectProjectRoot(PROJECT), true);
    const parent = path.resolve("/parent");
    h.fakeFs.add(
      path.join(parent, "specproj", ".specrune", "tasks", "b", "task.json"),
      JSON.stringify({ title: "B", status: "planning" })
    );
    const children = await h.activity.listChildProjectRoots(parent);
    assert.deepStrictEqual(children, [path.join(parent, "specproj")]);
  });
});

// ── lists & detail reads over a .specrune root ──

describe("specrune active/archive/detail reads", () => {
  function loadedHarness() {
    const h = makeHarness();
    h.activity.setPersistedRoots([PROJECT]);
    addSpecruneTask(h.fakeFs, "10-16-alpha", {
      title: "Alpha",
      status: "in_progress",
      priority: "P1",
      subtasks: [],
    }, { implementMd: "# plan\n- [x] one\n- [ ] two\n" });
    addSpecruneTask(h.fakeFs, "10-17-beta", { title: "Beta", status: "planning", subtasks: [] });
    addSpecruneTask(h.fakeFs, "10-15-legacy-done", { title: "Legacy", status: "done", subtasks: [] });
    addSpecruneTask(h.fakeFs, "10-14-canceled", { title: "Dead", status: "canceled", subtasks: [] });
    addSpecruneTask(h.fakeFs, "09-01-shipped", {
      title: "Shipped",
      status: "completed",
      subtasks: [],
      createdAt: "2026-09-01",
      completedAt: "2026-09-05",
    }, { month: "2026-09" });
    return h;
  }

  it("readActiveList prefixes .specrune/tasks, badges workflow, maps statuses", async () => {
    const h = loadedHarness();
    const result = await h.activity.readActiveList();
    assert.strictEqual(result.status, "ok");
    const byTitle = new Map(result.tasks.map((task) => [task.title, task]));
    assert.strictEqual(byTitle.size, 3, "canceled and archived stay out");

    const alpha = byTitle.get("Alpha");
    assert.strictEqual(alpha.taskPath, ".specrune/tasks/10-16-alpha");
    assert.strictEqual(alpha.workflow, "specrune");
    assert.strictEqual(alpha.phase, "execute");
    assert.deepStrictEqual(alpha.progress, { done: 1, total: 2 });

    assert.strictEqual(byTitle.get("Beta").phase, "plan");
    // Legacy read-only "done" status maps like completed → finish.
    assert.strictEqual(byTitle.get("Legacy").phase, "finish");
    assert.strictEqual(byTitle.get("Legacy").workflow, "specrune");
  });

  it("readTaskDetail accepts the .specrune/tasks/ prefix and reports provenance", async () => {
    const h = loadedHarness();
    const result = await h.activity.readTaskDetail(PROJECT, ".specrune/tasks/10-16-alpha");
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.task.title, "Alpha");
    assert.strictEqual(result.task.workflow, "specrune");
    assert.strictEqual(result.task.rawStatus, "in_progress");
    assert.ok(result.task.docs.some((doc) => doc.name === "implement.md"));

    // The old prefix against a pure specrune project must NOT resolve a
    // foreign tree (prefix mismatch is rejected before any join).
    const wrong = await h.activity.readTaskDetail(PROJECT, ".trellis/tasks/10-16-alpha");
    assert.strictEqual(wrong.status, "missing");
  });

  it("readArchiveList emits .specrune/tasks/archive paths with workflow", async () => {
    const h = loadedHarness();
    const result = await h.activity.readArchiveList();
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.tasks.length, 1);
    const entry = result.tasks[0];
    assert.strictEqual(entry.taskPath, ".specrune/tasks/archive/2026-09/09-01-shipped");
    assert.strictEqual(entry.workflow, "specrune");
    assert.strictEqual(entry.completedAt, "2026-09-05");
    // cwd is a trusted root so the detail channel can open the row.
    const detail = await h.activity.readTaskDetail(entry.cwd, entry.taskPath);
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.task.archived, true);
  });

  it("readSpecTree walks a flat specrune spec tree", async () => {
    const h = makeHarness();
    h.activity.setPersistedRoots([PROJECT]);
    h.fakeFs.add(
      path.join(PROJECT, ".specrune", "spec", "frontend", "index.md"),
      "# Index\n\nbody line one\nbody line two\nbody line three\nbody line four\nbody line five\n"
    );
    const result = await h.activity.readSpecTree(PROJECT);
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.files.length, 1);
    assert.strictEqual(result.files[0].relPath, "frontend/index.md");
    assert.strictEqual(result.files[0].filled, true);

    const doc = await h.activity.readSpecDoc(PROJECT, "frontend/index.md");
    assert.strictEqual(doc.status, "ok");
  });

  it("readTaskNetworkOverview cites .specrune/spec references", async () => {
    const h = makeHarness();
    h.activity.setPersistedRoots([PROJECT]);
    addSpecruneTask(h.fakeFs, "a", { title: "A", status: "in_progress", subtasks: [] });
    addSpecruneTask(h.fakeFs, "b", { title: "B", status: "in_progress", subtasks: [] });
    h.fakeFs.add(
      path.join(PROJECT, ".specrune", "tasks", "a", "prd.md"),
      "Follows .specrune/spec/frontend/index.md"
    );
    h.fakeFs.add(
      path.join(PROJECT, ".specrune", "tasks", "b", "design.md"),
      "Also follows .specrune/spec/frontend/index.md"
    );
    const result = await h.activity.readTaskNetworkOverview(PROJECT);
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.nodes.length, 2);
    assert.ok(result.nodes.every((n) => n.taskPath.startsWith(".specrune/tasks/")));
    assert.strictEqual(result.specGroups.length, 1);
    assert.strictEqual(result.specGroups[0].specPath, "frontend/index.md");
  });
});

// ── status mapping (pure) ──

describe("specrune status → phase mapping", () => {
  it("maps the specrune write whitelist plus legacy done", () => {
    assert.strictEqual(derivePhase({ status: "planning" }), "plan");
    assert.strictEqual(derivePhase({ status: "in_progress" }), "execute");
    assert.strictEqual(derivePhase({ status: "completed" }), "finish");
    assert.strictEqual(derivePhase({ status: "done" }), "finish");
    assert.strictEqual(derivePhase({ status: "canceled" }), null, "canceled never renders");
    assert.strictEqual(derivePhase({ status: "custom-status" }), null, "unknown stays null");
  });
});

// ── renderer contract: passthrough + static guards ──

describe("specrune renderer contract", () => {
  it("aggregateTrellisTasks passes workflow through", () => {
    const tasks = aggregateTrellisTasks([
      {
        id: "s1",
        cwd: CWD,
        trellis: { taskPath: ".specrune/tasks/a", title: "A", phase: "execute", workflow: "specrune" },
      },
      {
        id: "s2",
        cwd: CWD,
        trellis: { taskPath: ".trellis/tasks/b", title: "B", phase: "plan" },
      },
    ]);
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(tasks[0].workflow, "specrune");
    assert.strictEqual(tasks[1].workflow, null, "trellis stays unbadged");
  });

  it("dashboard.html defines the workflow badge CSS both schemes", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf8");
    assert.ok(/\.trellis-workflow-badge\s*{/.test(html), "light-scheme rule");
    const darkIdx = html.indexOf("prefers-color-scheme: dark");
    const badgeIdx = html.indexOf(".trellis-workflow-badge");
    assert.ok(darkIdx !== -1 && badgeIdx !== -1);
    assert.ok(
      /\.trellis-workflow-badge\s*{[^}]*color:\s*#7dd3fc/.test(html),
      "dark-scheme rule"
    );
  });

  it("dashboard-renderer consumes the badge class and the i18n key (×7 locales)", () => {
    const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");
    assert.ok(renderer.includes('"trellis-workflow-badge"'));
    assert.ok(renderer.includes('t("dashboardTrellisSpecruneBadge")'));

    const i18n = fs.readFileSync(path.join(__dirname, "..", "src", "i18n.js"), "utf8");
    const count = (i18n.match(/dashboardTrellisSpecruneBadge:/g) || []).length;
    assert.strictEqual(count, 7, "key present in every locale block");
  });

  it("the HUD jump gate accepts the .specrune/tasks/ prefix", () => {
    const ipc = fs.readFileSync(path.join(__dirname, "..", "src", "session-ipc.js"), "utf8");
    assert.ok(ipc.includes('.specrune/tasks/'), "prefix allowed in session-hud:open-trellis-task");
  });
});
