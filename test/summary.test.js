import { describe, expect, test } from "bun:test";
import { createSummaryStore, detailLines, formatCost, formatDuration, formatTokens, mostRecentlyActive, moveSelection, renderSummary, selectable, snapshotAt, STRIP_HINT, timelineBar, toolChips, treeRows } from "../plugin/summary.js";
import { summaryCommand } from "../plugin/tui.js";

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const ROOT = "ses_root";
const NAV = "ses_nav";
const DRV = "ses_drv";
const RES = "ses_res";

function setup() {
  let t = 0;
  const parents = new Map([[RES, ROOT], [NAV, ROOT], [DRV, NAV]]);
  const writes = [];
  const store = createSummaryStore({
    write: (snap) => writes.push(snap),
    inTree: (id) => id === ROOT || parents.has(id),
    parentOf: (id) => parents.get(id),
    root: () => ROOT,
    now: () => t,
    throttleMs: 0,
  });
  const ev = (type, data) => store.handle(type, data);
  return { store, ev, writes, tick: (ms) => (t += ms), now: () => t };
}

describe("summary store", () => {
  test("accumulates active time across rounds and tracks running state", () => {
    const { store, ev, tick } = setup();
    ev("session.execution.started", { sessionID: NAV });
    tick(10_000);
    ev("session.execution.succeeded", { sessionID: NAV });
    tick(50_000); // idle time doesn't count
    ev("session.execution.started", { sessionID: NAV });
    tick(5_000);
    const nav = store.snapshot().sessions.find((s) => s.id === NAV);
    expect(nav).toMatchObject({ running: true, activeMs: 10_000, runStart: 60_000 });
  });

  test("sums tokens in (incl. cache) and out (incl. reasoning) per agent", () => {
    const { store, ev } = setup();
    ev("session.step.ended", { sessionID: DRV, tokens: { input: 1000, output: 200, reasoning: 50, cache: { read: 4000, write: 100 } } });
    ev("session.step.ended", { sessionID: DRV, tokens: { input: 500, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } });
    const drv = store.snapshot().sessions.find((s) => s.id === DRV);
    expect(drv).toMatchObject({ tokensIn: 5600, tokensOut: 350 });
  });

  test("ignores sessions outside the tree and records titles and blockers", () => {
    const { store, ev } = setup();
    ev("session.execution.started", { sessionID: "ses_elsewhere" });
    ev("session.created", { sessionID: NAV, parentID: ROOT, title: "Navigator: implementation" });
    ev("permission.asked", { sessionID: NAV, id: "p1" });
    const snap = store.snapshot();
    expect(snap.sessions.map((s) => s.id)).toEqual([ROOT, NAV]);
    expect(snap.sessions[1]).toMatchObject({ title: "Navigator: implementation", blocked: true, parentID: ROOT });
  });
});

describe("summary store: titles and seeding", () => {
  test("uses display titles (e.g. #2) for subagents but not the root", () => {
    const parents = new Map([[RES, ROOT], [NAV, ROOT]]);
    const store = createSummaryStore({
      write: () => {},
      inTree: (id) => id === ROOT || parents.has(id),
      parentOf: (id) => parents.get(id),
      root: () => ROOT,
      titleOf: (id) => (id === NAV ? "Research: x #2" : id === ROOT ? "nope" : undefined),
      throttleMs: 0,
    });
    store.handle("session.created", { sessionID: RES, parentID: ROOT, title: "Research: x" });
    store.handle("session.created", { sessionID: NAV, parentID: ROOT, title: "Research: x" });
    store.title(ROOT, "Wordfreq");
    const titles = store.snapshot().sessions.map((s) => s.title);
    expect(titles).toEqual(["Wordfreq", "Research: x", "Research: x #2"]);
  });

  test("seed sets totals so far and a running state; later steps add to it", () => {
    const { store, ev, tick, now } = setup();
    tick(100_000);
    store.seed(DRV, { title: "Driver: impl", running: true, runStart: 90_000, tokensIn: 5_000, tokensOut: 300 });
    ev("session.step.ended", { sessionID: DRV, tokens: { input: 100, output: 10 } });
    const drv = store.snapshot().sessions.find((s) => s.id === DRV);
    expect(drv).toMatchObject({ title: "Driver: impl", running: true, runStart: 90_000, tokensIn: 5_100, tokensOut: 310 });
    expect(now()).toBe(100_000);
  });
});

describe("history: tools, steps, waits, prompt", () => {
  function run() {
    const { store, ev, tick } = setup();
    ev("session.created", { sessionID: DRV, parentID: NAV, title: "Driver: impl" });
    ev("session.created", { sessionID: NAV, parentID: ROOT, title: "Navigator: impl" });
    ev("session.inbox.enqueued", { sessionID: DRV, item: { payload: { text: "You are a subagent spawned by another session.\nWrite wordfreq.js" } } });
    ev("session.execution.started", { sessionID: DRV }); // t=0
    ev("session.tool.input.started", { sessionID: DRV, id: "t1", name: "read" });
    ev("session.tool.called", { sessionID: DRV, id: "t1", input: { filePath: "/r/sample.txt" } });
    tick(1_000);
    ev("session.tool.success", { sessionID: DRV, id: "t1" }); // t=1s
    ev("session.step.ended", { sessionID: DRV, tokens: { input: 1000, output: 100 } });
    tick(1_000);
    ev("session.tool.input.started", { sessionID: DRV, id: "t2", name: "bash" }); // t=2s
    ev("permission.asked", { sessionID: DRV, id: "p1" });
    tick(3_000);
    ev("permission.replied", { sessionID: DRV, requestID: "p1" }); // t=5s
    ev("session.tool.failed", { sessionID: DRV, id: "t2" });
    ev("session.step.ended", { sessionID: DRV, tokens: { input: 500, output: 50 } });
    tick(1_000);
    ev("session.execution.succeeded", { sessionID: DRV }); // t=6s
    return { store, tick };
  }

  test("records tool calls, token steps, input waits and the spawning prompt", () => {
    const drv = run().store.snapshot().sessions.find((s) => s.id === DRV);
    expect(drv.prompt).toBe("Write wordfreq.js");
    expect(drv.toolCount).toBe(2);
    expect(drv.tools.map((t) => [t.summary, t.start, t.end, t.ok])).toEqual([["read sample.txt", 0, 1000, true], ["bash", 2000, 5000, false]]);
    expect(drv.steps).toEqual([[1000, 1000, 100], [5000, 500, 50]]);
    expect(drv.blocks).toEqual([[2000, 5000]]);
  });

  test("snapshotAt rebuilds the state at a moment of the run", () => {
    const snap = run().store.snapshot();
    const at = (t) => snapshotAt(snap, t).sessions.find((s) => s.id === DRV);
    expect(at(3000)).toMatchObject({ running: true, blocked: true, tokensIn: 1000, tokensOut: 100, toolCount: 2, activeMs: 0 });
    expect(at(3000).tools[1]).toMatchObject({ name: "bash", end: null, ok: null }); // still in progress at 3s
    expect(at(500)).toMatchObject({ toolCount: 1, tokensIn: 0, blocked: false });
    expect(at(10_000)).toMatchObject({ running: false, activeMs: 6000, tokensIn: 1500, toolCount: 2 });
  });

  test("mostRecentlyActive picks the subagent that last did something", () => {
    const { store, tick } = run();
    tick(1_000);
    store.handle("session.execution.started", { sessionID: NAV });
    expect(mostRecentlyActive(store.snapshot())).toBe(NAV);
  });

  test("detail view lines: model and parent, prompt, chips, recent calls with timings", () => {
    const drv = run().store.snapshot().sessions.find((s) => s.id === DRV);
    const lines = detailLines({ ...drv, model: "sonnet" }, { width: 40, rows: 6, now: 6000, parentTitle: "Navigator: impl" });
    expect(lines).toEqual([
      "sonnet · from Navigator: impl",
      "prompt: Write wordfreq.js",
      "tools: bash · read",
      "✓ read sample.txt                     1s",
      "✗ bash                                3s",
    ]);
    expect(toolChips([{ name: "bash" }, { name: "read" }, { name: "bash" }])).toBe("bash ×2 · read");
  });

  test("the strip shows the detail view for the selected agent and a replay cursor", () => {
    const snap = run().store.snapshot();
    const detail = renderSummary(snap, { cols: 140, rows: 12, now: 6000, selected: DRV }).map(strip);
    expect(detail[0]).toMatch(/tools  Driver: impl$/);
    expect(detail.join("\n")).toContain("prompt: Write wordfreq.js");
    const replay = renderSummary(snap, { cols: 140, rows: 12, now: 6000, cursor: 3000 }).map(strip);
    expect(replay[0]).toMatch(/replay · 3s of 6s/);
    expect(replay.find((l) => l.includes("Driver"))).toMatch(/needs input/);
  });
});

describe("renderSummary", () => {
  test("draws the tree with indicators, live active time, tokens and a total", () => {
    const { store, ev, tick, now } = setup();
    store.title(ROOT, "Wordfreq feature");
    ev("session.execution.started", { sessionID: ROOT });
    ev("session.created", { sessionID: RES, parentID: ROOT, title: "Research: word splitting" });
    ev("session.created", { sessionID: NAV, parentID: ROOT, title: "Navigator: implementation" });
    ev("session.created", { sessionID: DRV, parentID: NAV, title: "Driver: implementation" });
    ev("session.execution.started", { sessionID: RES });
    tick(18_000);
    ev("session.execution.succeeded", { sessionID: RES });
    ev("session.step.ended", { sessionID: RES, tokens: { input: 8100, output: 600 } });
    ev("session.execution.started", { sessionID: DRV });
    tick(31_000);
    // Narrow enough that there's no room for a timeline.
    const lines = renderSummary(store.snapshot(), { cols: 80, rows: 10, now: now() }).map(strip);
    expect(lines[0]).toMatch(/agent\s+status\s+active\s+tokens in \/ out  tools$/);
    expect(lines[1]).toMatch(/^ ● orchestrator · Wordfreq feature\s+active\s+49s\s+0 \/ 0$/);
    expect(lines[2]).toMatch(/^ ├─ ○ Research: word splitting\s+idle\s+18s\s+8\.1k \/ 600$/);
    expect(lines[3]).toMatch(/^ └─ ◌ Navigator: implementation\s+waiting\s+0s/); // its driver is active
    expect(lines[4]).toMatch(/^    └─ ● Driver: implementation\s+active\s+31s/);
    expect(lines[5]).toMatch(/^ total\s+1m38s\s+8\.1k \/ 600$/);

    // Wide: a timeline fills the rest. Research ran first, the driver after it.
    const wide = renderSummary(store.snapshot(), { cols: 120, rows: 10, now: now() }).map(strip);
    expect(wide[0]).toMatch(/tokens in \/ out  tools  timeline · 49s/);
    const bar = (l) => l.match(/[█· ]+$/)[0].trim();
    expect(bar(wide[2])).toMatch(/^█+·+$/); // research: active, then idle
    expect(bar(wide[4])).toMatch(/^█+$/); // driver: active since it started
    expect(wide[2].indexOf("█")).toBeLessThan(wide[4].indexOf("█"));
  });

  test("model and cost columns appear only when there is something to show", () => {
    const { store, ev } = setup();
    store.meta(RES, { model: "sonnet" });
    ev("session.created", { sessionID: RES, parentID: ROOT, title: "Research: x" });
    let lines = renderSummary(store.snapshot(), { cols: 90, rows: 10, now: 0 }).map(strip);
    expect(lines[0]).toMatch(/tokens in \/ out  tools  model/);
    expect(lines[0]).not.toContain("cost");
    expect(lines[2]).toMatch(/0 \/ 0\s+sonnet/);
    store.meta(RES, { cost: 0.4321 });
    lines = renderSummary(store.snapshot(), { cols: 90, rows: 10, now: 0 }).map(strip);
    expect(lines[0]).toMatch(/model\s+cost/);
    expect(lines[2]).toMatch(/sonnet\s+\$0\.43/);
    expect(lines.at(-1)).toMatch(/\$0\.43$/); // total
    // Very narrow: the model column goes first.
    expect(renderSummary(store.snapshot(), { cols: 60, rows: 10, now: 0 }).map(strip)[0]).not.toContain("model");
  });

  test("strip selection: subagents only, arrows move and stop at the ends, selected row in reverse", () => {
    const { store, ev } = setup();
    ev("session.created", { sessionID: RES, parentID: ROOT, title: "Research: x" });
    ev("session.created", { sessionID: NAV, parentID: ROOT, title: "Navigator: y" });
    ev("session.created", { sessionID: DRV, parentID: NAV, title: "Driver: y" });
    const snap = store.snapshot();
    const ids = selectable(snap);
    expect(ids).toEqual([RES, NAV, DRV]);
    expect(moveSelection(ids, undefined, "down")).toBe(RES);
    expect(moveSelection(ids, undefined, "up")).toBe(DRV);
    expect(moveSelection(ids, DRV, "down")).toBe(DRV);
    expect(moveSelection(ids, NAV, "up")).toBe(RES);
    const lines = renderSummary(snap, { cols: 170, rows: 10, now: 0, selected: NAV });
    expect(lines[3].startsWith("\x1b[7m")).toBe(true);
    expect(lines[2].startsWith("\x1b[7m")).toBe(false);
    expect(strip(lines.at(-1))).toContain(STRIP_HINT);
    expect(strip(renderSummary(snap, { cols: 170, rows: 10, now: 0 }).at(-1))).toContain(STRIP_HINT);
  });

  test("timelineBar marks active slots, idle after the first run, blank before", () => {
    expect(timelineBar([[20, 40], [70, null]], 0, 100, 10, 100)).toBe("  ██···███");
    expect(timelineBar([], 0, 100, 4, 100)).toBe("    ");
    expect(formatCost(0)).toBe("");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(1.5)).toBe("$1.50");
  });

  test("shows needs input and a placeholder before a root exists", () => {
    expect(strip(renderSummary(undefined, { cols: 80, rows: 5 })[0])).toContain("waiting for the orchestrator");
    const snap = { root: ROOT, sessions: [{ id: ROOT, order: 0, blocked: true, running: true, activeMs: 0, runStart: 0, tokensIn: 0, tokensOut: 0 }] };
    expect(strip(renderSummary(snap, { cols: 80, rows: 5, now: 0 })[1])).toContain("▲ orchestrator");
  });

  test("treeRows nests by parent in creation order", () => {
    const snap = {
      root: ROOT,
      sessions: [
        { id: ROOT, order: 0 },
        { id: NAV, parentID: ROOT, order: 2 },
        { id: RES, parentID: ROOT, order: 1 },
        { id: DRV, parentID: NAV, order: 3 },
      ],
    };
    expect(treeRows(snap).map((r) => `${r.prefix}${r.session.id}`)).toEqual([ROOT, `├─ ${RES}`, `└─ ${NAV}`, `   └─ ${DRV}`]);
  });

  test("formatters", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(25_300)).toBe("25.3k");
    expect(formatTokens(1_250_000)).toBe("1.25M");
    expect(formatDuration(98_000)).toBe("1m38s");
    expect(formatDuration(3_720_000)).toBe("1h02m");
  });
});

test("summaryCommand passes the owner pid for the watchdog", () => {
  expect(summaryCommand({ bin: "/o/opencode", summaryScript: "/p/summary.js", stateFile: "/r/s.json", owner: 42 })).toEndWith(" --owner 42");
});

test("summaryCommand runs the summary script with embedded bun", () => {
  expect(summaryCommand({ bin: "/o/opencode", summaryScript: "/p/summary.js", stateFile: "/r/s.json" }))
    .toBe("exec env BUN_BE_BUN=1 '/o/opencode' '/p/summary.js' --state '/r/s.json'");
});
