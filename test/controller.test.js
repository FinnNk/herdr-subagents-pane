import { describe, expect, test } from "bun:test";
import { createController, taskKey } from "../plugin/controller.js";

const ROOT = "ses_root";
const A = "ses_childA";
const B = "ses_childB";

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && pending.has(id)) {
          pending.delete(id);
          t.fn();
        }
      }
    },
    get count() {
      return pending.size;
    },
  };
}

function fakePanes() {
  let n = 0;
  const open = new Map(); // paneId -> label
  const calls = [];
  const anchors = []; // [childId, paneId, anchor]
  return {
    open: async (childId, anchor, label) => {
      const id = `w1:p${++n}`;
      open.set(id, label);
      anchors.push([childId, id, anchor]);
      calls.push(["open", childId, anchor.paneId ?? "parent", anchor.direction]);
      return id;
    },
    exists: async (paneId) => open.has(paneId),
    close: async (paneId) => {
      open.delete(paneId);
      calls.push(["close", paneId]);
    },
    rename: async (paneId, label) => {
      if (open.has(paneId)) open.set(paneId, label);
      calls.push(["rename", paneId, label]);
    },
    userCloses: (paneId) => open.delete(paneId),
    open_: open,
    calls,
    anchors,
    opens: () => calls.filter((x) => x[0] === "open"),
    closes: () => calls.filter((x) => x[0] === "close"),
  };
}

function setup(opts = {}) {
  const timers = fakeTimers();
  const panes = fakePanes();
  const c = createController({ panes, timers, closeDelayMs: 20_000, settleMs: 0, maxPanes: 4, ...opts });
  c.setRoute(ROOT);
  const spawn = (id, parentID = ROOT, title) => c.handle("session.created", { sessionID: id, parentID, title });
  const ev = (type, data) => c.handle(type, data);
  const start = (id) => ev("session.execution.started", { sessionID: id });
  const stop = (id) => ev("session.execution.succeeded", { sessionID: id });
  const labelOf = (paneId) => panes.open_.get(paneId);
  return { c, timers, panes, spawn, ev, start, stop, labelOf };
}

describe("opening", () => {
  test("opens a pane to the right of the parent when a subagent is created", async () => {
    const { c, panes, spawn, labelOf } = setup();
    spawn(A, ROOT, "Research");
    await c.idle();
    expect(panes.calls[0]).toEqual(["open", A, "parent", "right"]);
    expect(labelOf("w1:p1")).toBe("Research · starting");
  });

  test("falls back to a short id label when the child has no title", async () => {
    const { c, spawn, labelOf } = setup();
    spawn(A);
    await c.idle();
    expect(labelOf("w1:p1")).toBe("subagent childA · starting");
  });

  test("the first viewer leaves the orchestrator a third of its pane", async () => {
    const { c, panes, spawn } = setup();
    spawn(A, ROOT, "Research: word splitting");
    await c.idle();
    expect(panes.anchors[0][2]).toEqual({ direction: "right", ratio: 1 / 3 });
  });

  test("ignores sessions that are not descendants of this TUI's root", async () => {
    const { c, panes, spawn } = setup();
    spawn("ses_other_root", null);
    spawn("ses_foreign_child", "ses_other_root");
    await c.idle();
    expect(panes.calls).toEqual([]);
  });

  test("opens panes for nested subagents (grandchildren)", async () => {
    const { c, panes, spawn } = setup();
    spawn(A);
    spawn("ses_grandchild", A);
    await c.idle();
    expect(panes.opens().map((x) => x[1])).toEqual([A, "ses_grandchild"]);
  });

  test("does nothing before a route is known", async () => {
    const panes = fakePanes();
    const c = createController({ panes, timers: fakeTimers() });
    c.handle("session.created", { sessionID: A, parentID: ROOT });
    await c.idle();
    expect(panes.calls).toEqual([]);
  });

  test("resolves the root via the fallback lookup when the event was missed", async () => {
    const { c, panes, start } = setup({ lookupParent: (id) => (id === A ? ROOT : undefined) });
    start(A);
    await c.idle();
    expect(panes.opens().length).toBe(1);
  });
});

describe("debounced closing", () => {
  test("closes only after the debounce once the subagent (and parent) are idle", async () => {
    const { c, timers, panes, spawn, start, stop } = setup();
    spawn(A);
    start(A);
    await c.idle();
    stop(A);
    timers.advance(19_999);
    await c.idle();
    expect(panes.open_.size).toBe(1);
    timers.advance(1);
    await c.idle();
    expect(panes.open_.size).toBe(0);
  });

  test("new work within the debounce cancels the close and keeps the same pane", async () => {
    const { c, timers, panes, spawn, start, stop } = setup();
    spawn(A);
    start(A);
    stop(A);
    await c.idle();
    timers.advance(10_000);
    start(A);
    timers.advance(30_000);
    await c.idle();
    expect(panes.closes()).toEqual([]);
    expect(panes.opens().length).toBe(1);
  });

  test("rapid idle/active flapping produces a single open and a single close", async () => {
    const { c, timers, panes, spawn, start, stop } = setup();
    spawn(A);
    for (let i = 0; i < 10; i++) {
      start(A);
      stop(A);
      timers.advance(1_000);
    }
    await c.idle();
    timers.advance(20_000);
    await c.idle();
    expect(panes.opens().length).toBe(1);
    expect(panes.closes().length).toBe(1);
    expect(timers.count).toBe(0);
  });

  test("reopens if the child is resumed after its pane closed", async () => {
    const { c, timers, panes, spawn, start, stop } = setup();
    spawn(A);
    start(A);
    stop(A);
    await c.idle();
    timers.advance(20_000);
    await c.idle();
    start(A);
    await c.idle();
    expect(panes.calls.filter((x) => x[0] !== "rename").map((x) => x[0])).toEqual(["open", "close", "open"]);
  });

  test("a child that goes idle before its pane finished opening still gets closed", async () => {
    const { c, timers, panes, spawn, start, stop } = setup();
    spawn(A);
    start(A);
    stop(A);
    await c.idle();
    timers.advance(20_000);
    await c.idle();
    expect(panes.open_.size).toBe(0);
  });

  test("interrupted and failed rounds also start the debounce", async () => {
    for (const type of ["session.execution.interrupted", "session.execution.failed"]) {
      const { c, timers, panes, spawn, start, ev } = setup();
      spawn(A);
      start(A);
      ev(type, { sessionID: A });
      await c.idle();
      timers.advance(20_000);
      await c.idle();
      expect(panes.open_.size).toBe(0);
    }
  });

  test("stays open while a permission request is pending, closes after reply + debounce", async () => {
    const { c, timers, panes, spawn, start, stop, ev, labelOf } = setup();
    spawn(A);
    start(A);
    ev("permission.asked", { sessionID: A, id: "perm1" });
    stop(A);
    await c.idle();
    timers.advance(60_000);
    await c.idle();
    expect(labelOf("w1:p1")).toBe("subagent childA · needs input");
    ev("permission.replied", { sessionID: A, requestID: "perm1" });
    timers.advance(20_000);
    await c.idle();
    expect(panes.open_.size).toBe(0);
  });

  test("stays open while a form (question) is pending", async () => {
    const { c, timers, panes, spawn, ev } = setup();
    spawn(A);
    ev("form.created", { form: { sessionID: A, id: "f1" } });
    await c.idle();
    timers.advance(60_000);
    await c.idle();
    expect(panes.open_.size).toBe(1);
    ev("form.replied", { sessionID: A, id: "f1" });
    timers.advance(20_000);
    await c.idle();
    expect(panes.open_.size).toBe(0);
  });

  test("a pane closed by the user is reopened on the next round of work", async () => {
    const { c, panes, spawn, start } = setup();
    spawn(A);
    await c.idle();
    panes.userCloses("w1:p1");
    start(A);
    await c.idle();
    expect(panes.opens().length).toBe(2);
  });
});

describe("parent-aware closing (pairing)", () => {
  test("an idle child stays open while its parent is still working", async () => {
    const { c, timers, panes, spawn, start, stop, labelOf } = setup();
    start(ROOT);
    spawn(A, ROOT, "Navigator");
    start(A);
    stop(A);
    await c.idle();
    timers.advance(120_000);
    await c.idle();
    expect(panes.open_.size).toBe(1);
    expect(labelOf("w1:p1")).toBe("Navigator · waiting");
  });

  test("the countdown starts when the parent goes idle", async () => {
    const { c, timers, panes, spawn, start, stop, labelOf } = setup();
    start(ROOT);
    spawn(A, ROOT, "Navigator");
    start(A);
    stop(A);
    stop(ROOT);
    await c.idle();
    expect(labelOf("w1:p1")).toBe("Navigator · done, closing in 20s");
    timers.advance(20_000);
    await c.idle();
    expect(panes.open_.size).toBe(0);
  });

  test("the parent resuming work cancels a pending close", async () => {
    const { c, timers, panes, spawn, start, stop } = setup();
    spawn(A);
    start(A);
    stop(A); // parent idle too -> countdown
    await c.idle();
    timers.advance(15_000);
    start(ROOT); // parent picks up again, may resume A
    timers.advance(60_000);
    await c.idle();
    expect(panes.open_.size).toBe(1);
  });

  test("driver/navigator loop relayed through the parent keeps both panes, counts rounds", async () => {
    const DRV = "ses_driver";
    const NAV = "ses_navigator";
    const { c, timers, panes, spawn, start, stop, labelOf } = setup();
    start(ROOT);
    spawn(NAV, ROOT, "Navigator");
    start(NAV); // plan
    stop(NAV);
    spawn(DRV, ROOT, "Driver");
    start(DRV); // implement (navigator idle for a long time)
    await c.idle();
    timers.advance(90_000);
    stop(DRV);
    start(NAV); // review
    await c.idle();
    expect(labelOf("w1:p1")).toBe("Navigator · working (run 2)");
    expect(labelOf("w1:p2")).toBe("Driver · waiting");
    stop(NAV);
    start(DRV); // apply feedback
    await c.idle();
    expect(labelOf("w1:p2")).toBe("Driver · working (run 2)");
    stop(DRV);
    stop(ROOT);
    await c.idle();
    expect(panes.opens().length).toBe(2); // no close/reopen during pairing
    expect(panes.closes()).toEqual([]);
    timers.advance(20_000);
    await c.idle();
    expect(panes.open_.size).toBe(0);
  });

  test("uses the running lookup when the parent's events were missed", async () => {
    const { c, timers, panes, spawn, start, stop } = setup({ lookupRunning: (id) => id === ROOT });
    spawn(A);
    start(A);
    stop(A);
    await c.idle();
    timers.advance(60_000);
    await c.idle();
    expect(panes.open_.size).toBe(1);
  });
});

describe("tree-quiet closing", () => {
  test("with autoClose off, panes stay open labelled done, and reopen work as usual", async () => {
    const { c, timers, panes, spawn, start, stop, labelOf } = setup({ autoClose: false });
    start(ROOT);
    spawn(A, ROOT, "Research");
    start(A);
    stop(A);
    stop(ROOT);
    await c.idle();
    timers.advance(600_000);
    await c.idle();
    expect(labelOf("w1:p1")).toBe("Research · done");
    expect(panes.closes()).toEqual([]);
    expect(timers.count).toBe(0);
    start(A); // resumed later: back to working
    await c.idle();
    expect(labelOf("w1:p1")).toBe("Research · working (run 2)");
  });

  test("with autoClose off, the pane cap still evicts the oldest idle pane", async () => {
    const { c, panes, spawn, start, stop } = setup({ autoClose: false, maxPanes: 1 });
    start(ROOT);
    spawn(A, ROOT, "Research: a");
    start(A);
    stop(A);
    spawn(B, ROOT, "Docs: b");
    await c.idle();
    expect(panes.closes()).toEqual([["close", "w1:p1"]]);
  });

  test("a sibling still working keeps an idle child open even when the parent is idle", async () => {
    // Orchestrators end their turn after launching background subagents.
    const { c, timers, panes, spawn, start, stop, labelOf } = setup();
    start(ROOT);
    spawn(A, ROOT, "Research");
    spawn(B, ROOT, "Navigator");
    start(A);
    start(B);
    stop(ROOT); // parent waits for the <subagent> results
    stop(A);
    await c.idle();
    timers.advance(120_000);
    await c.idle();
    expect(labelOf("w1:p1")).toBe("Research · waiting");
    expect(panes.open_.size).toBe(2);
    stop(B);
    await c.idle();
    expect(labelOf("w1:p1")).toBe("Research · done, closing in 20s");
    expect(labelOf("w1:p2")).toBe("Navigator · done, closing in 20s");
  });

  test("all viewers count down together once the tree is quiet", async () => {
    const { c, timers, panes, spawn, start, stop } = setup();
    spawn(A);
    spawn(B);
    start(A);
    start(B);
    stop(A);
    timers.advance(50_000); // A idle for a long time while B works
    stop(B);
    await c.idle();
    timers.advance(19_999);
    await c.idle();
    expect(panes.open_.size).toBe(2);
    timers.advance(1);
    await c.idle();
    expect(panes.open_.size).toBe(0);
  });

  test("a brief quiet gap shorter than the settle period never shows 'closing'", async () => {
    const { c, timers, panes, spawn, start, stop } = setup({ settleMs: 3_000 });
    start(ROOT);
    spawn(A, ROOT, "Navigator");
    start(A);
    stop(A);
    stop(ROOT); // last subagent finished, parent about to be woken by its result
    timers.advance(300);
    start(ROOT);
    await c.idle();
    timers.advance(60_000);
    await c.idle();
    const labels = panes.calls.filter((x) => x[0] === "rename").map((x) => x[2]);
    expect(labels.some((l) => l.includes("closing"))).toBe(false);
    expect(panes.open_.size).toBe(1);
  });

  test("after the settle period the countdown starts", async () => {
    const { c, timers, panes, spawn, start, stop, labelOf } = setup({ settleMs: 3_000 });
    spawn(A, ROOT, "Navigator");
    start(A);
    stop(A);
    await c.idle();
    timers.advance(2_999);
    await c.idle();
    expect(labelOf("w1:p1")).toBe("Navigator · waiting");
    timers.advance(1);
    await c.idle();
    expect(labelOf("w1:p1")).toBe("Navigator · done, closing in 20s");
    timers.advance(20_000);
    await c.idle();
    expect(panes.open_.size).toBe(0);
  });
});

describe("expanded views", () => {
  test("a pane whose view is expanded is not closed; the countdown restarts", async () => {
    let pinned = true;
    const { c, timers, panes, spawn, start, stop } = setup({ isPinned: () => pinned });
    spawn(A);
    start(A);
    stop(A);
    await c.idle();
    timers.advance(20_000);
    await c.idle();
    timers.advance(20_000);
    await c.idle();
    expect(panes.open_.size).toBe(1);
    pinned = false; // user collapsed it
    timers.advance(20_000);
    await c.idle();
    expect(panes.open_.size).toBe(0);
  });
});

describe("layout and capacity", () => {
  test("taskKey groups '<Role>: <Task>' titles by task", () => {
    expect(taskKey("Driver: implementation", "x")).toBe("implementation");
    expect(taskKey("Navigator:  Implementation ", "y")).toBe("implementation");
    expect(taskKey("Research", "z")).toBe("id:z");
    expect(taskKey(undefined, "z")).toBe("id:z");
  });

  test("each task gets a column; same-task subagents stack in it", async () => {
    const R = "ses_research", NAV = "ses_nav", DRV = "ses_drv";
    const { c, panes, spawn } = setup();
    spawn(R, ROOT, "Research: word splitting");
    spawn(NAV, ROOT, "Navigator: implementation");
    spawn(DRV, ROOT, "Driver: implementation");
    await c.idle();
    expect(panes.anchors).toEqual([
      [R, "w1:p1", { direction: "right", ratio: 1 / 3 }], // orchestrator keeps 1/3
      [NAV, "w1:p2", { paneId: "w1:p1", direction: "right", ratio: 0.5 }], // new column
      [DRV, "w1:p3", { paneId: "w1:p2", direction: "down" }], // stacks under navigator
    ]);
  });

  test("untitled subagents each get their own column", async () => {
    const { c, panes, spawn } = setup();
    spawn(A);
    spawn(B);
    await c.idle();
    expect(panes.anchors[1][2]).toEqual({ paneId: "w1:p1", direction: "right", ratio: 0.5 });
  });

  test("a new column splits the rightmost single-pane column so it is full height", async () => {
    const { c, panes, spawn } = setup();
    spawn("ses_r", ROOT, "Research: a");
    spawn("ses_n", ROOT, "Navigator: impl");
    spawn("ses_d", ROOT, "Driver: impl"); // impl column now has 2 panes
    spawn("ses_x", ROOT, "Docs: b");
    await c.idle();
    expect(panes.anchors[3][2]).toEqual({ paneId: "w1:p1", direction: "right", ratio: 0.5 });
  });

  test("when every column is stacked, the rightmost is collapsed, split, and restacked", async () => {
    // The cipher demo: three codebreakers stack in one column, then the solvers need a new one.
    const { c, panes, spawn, labelOf } = setup({ maxPanes: 6 });
    spawn("ses_c", ROOT, "Caesar: codebreaking");
    spawn("ses_a", ROOT, "Atbash: codebreaking");
    spawn("ses_v", ROOT, "Vigenere: codebreaking");
    await c.idle();
    spawn("ses_f", ROOT, "Formula: answer");
    await c.idle();
    expect(panes.calls.filter((x) => x[0] !== "rename").slice(3)).toEqual([
      ["close", "w1:p2"], // Atbash and Vigenere close…
      ["close", "w1:p3"],
      ["open", "ses_f", "w1:p1", "right"], // …so splitting Caesar's pane is full height…
      ["open", "ses_a", "w1:p1", "down"], // …and they come back under Caesar, in order
      ["open", "ses_v", "w1:p5", "down"],
    ]);
    expect(labelOf("w1:p5")).toBe("Atbash: codebreaking · starting");
    // The answer column then stacks normally under Formula.
    spawn("ses_s", ROOT, "Simulation: answer");
    await c.idle();
    expect(panes.anchors.at(-1)).toEqual(["ses_s", "w1:p7", { paneId: "w1:p4", direction: "down" }]);
    expect(c.snapshot().map((s) => s.paneId).sort()).toEqual(["w1:p1", "w1:p4", "w1:p5", "w1:p6", "w1:p7"]);
  });

  test("a stacked column with an expanded view is not collapsed", async () => {
    const { c, panes, spawn } = setup({ isPinned: (id) => id === "ses_a" });
    spawn("ses_c", ROOT, "Caesar: codebreaking");
    spawn("ses_a", ROOT, "Atbash: codebreaking");
    await c.idle();
    spawn("ses_f", ROOT, "Formula: answer");
    await c.idle();
    expect(panes.closes()).toEqual([]);
    expect(panes.anchors.at(-1)[2]).toEqual({ paneId: "w1:p1", direction: "right", ratio: 0.5 });
  });

  test("a reopened viewer goes back into its task's column", async () => {
    const NAV = "ses_nav", DRV = "ses_drv";
    const { c, panes, spawn, start } = setup();
    spawn("ses_r", ROOT, "Research: a");
    spawn(NAV, ROOT, "Navigator: impl");
    spawn(DRV, ROOT, "Driver: impl");
    start(DRV);
    await c.idle();
    panes.userCloses("w1:p2"); // navigator pane closed by the user
    start(NAV);
    await c.idle();
    expect(panes.anchors.at(-1)).toEqual([NAV, "w1:p4", { paneId: "w1:p3", direction: "down" }]);
  });

  test("at the cap, the oldest idle viewer is closed to make room", async () => {
    const { c, panes, spawn, start, stop } = setup({ maxPanes: 2 });
    start(ROOT);
    spawn(A);
    start(A);
    stop(A); // idle (waiting), parent still running
    spawn(B);
    start(B); // busy
    await c.idle();
    spawn("ses_childC");
    await c.idle();
    expect(panes.closes()).toEqual([["close", "w1:p1"]]);
    expect([...panes.open_.keys()]).toEqual(["w1:p2", "w1:p3"]);
  });

  test("at the cap with every viewer busy, no pane is opened", async () => {
    const { c, panes, spawn, start } = setup({ maxPanes: 1 });
    spawn(A);
    start(A);
    spawn(B);
    await c.idle();
    expect(panes.opens().length).toBe(1);
  });
});

describe("overflow tab", () => {
  test("past the cap, viewers go to an overflow tab as a two-row grid instead of evicting", async () => {
    const { c, panes, spawn, start } = setup({ maxPanes: 2, overflow: "tab" });
    for (const id of ["s1", "s2", "s3", "s4", "s5", "s6"]) {
      spawn(id, ROOT, `T${id}: ${id}`);
      start(id);
    }
    await c.idle();
    expect(panes.closes()).toEqual([]);
    const ov = panes.anchors.slice(2).map(([id, , a]) => [id, a]);
    expect(ov).toEqual([
      ["s3", { area: "overflow" }], // becomes the new tab's pane (w1:p3)
      ["s4", { area: "overflow", paneId: "w1:p3", direction: "down" }], // starts the bottom row
      ["s5", { area: "overflow", paneId: "w1:p3", direction: "right", ratio: 0.5 }], // top row
      ["s6", { area: "overflow", paneId: "w1:p4", direction: "right", ratio: 0.5 }], // bottom row
    ]);
  });

  test("when the overflow tab is full too, the oldest idle viewer makes room in its own area", async () => {
    const { c, panes, spawn, start, stop } = setup({ maxPanes: 1, overflow: "tab", overflowMaxPanes: 1 });
    start(ROOT);
    spawn(A, ROOT, "Research: a");
    start(A);
    spawn(B, ROOT, "Docs: b");
    start(B);
    await c.idle();
    stop(B); // the overflow viewer goes idle
    spawn("ses_c", ROOT, "Tests: c");
    start("ses_c");
    await c.idle();
    expect(panes.closes()).toEqual([["close", "w1:p2"]]);
    expect(panes.anchors.at(-1)).toEqual(["ses_c", "w1:p3", { area: "overflow" }]);
  });

  test("the default still evicts", async () => {
    const { c, panes, spawn, start, stop } = setup({ maxPanes: 1 });
    start(ROOT);
    spawn(A);
    start(A);
    stop(A);
    spawn(B);
    await c.idle();
    expect(panes.closes()).toEqual([["close", "w1:p1"]]);
  });
});

describe("rebalancing", () => {
  test("after panes open or close, rebalance gets the open viewer panes (coalesced)", async () => {
    const calls = [];
    const timers = fakeTimers();
    const panes = { ...fakePanes(), rebalance: async (ids) => calls.push(ids) };
    const c = createController({ panes, timers, settleMs: 0, closeDelayMs: 1_000 });
    c.setRoute(ROOT);
    c.handle("session.created", { sessionID: A, parentID: ROOT, title: "Research: a" });
    c.handle("session.created", { sessionID: B, parentID: ROOT, title: "Docs: b" });
    await c.idle();
    expect(calls).toEqual([["w1:p1", "w1:p2"]]);
    timers.advance(1_000);
    await c.idle();
    expect(calls.at(-1)).toEqual([]);
  });
});

describe("herdr status and alerts", () => {
  test("each viewer pane's status is reported when it changes (and again for a reopened pane)", async () => {
    const reports = [];
    const timers = fakeTimers();
    const panes = { ...fakePanes(), report: async (paneId, status, title) => reports.push([paneId, status, title]) };
    const c = createController({ panes, timers, settleMs: 0, closeDelayMs: 20_000 });
    c.setRoute(ROOT);
    c.handle("session.execution.started", { sessionID: ROOT });
    c.handle("session.created", { sessionID: A, parentID: ROOT, title: "Driver: impl" });
    c.handle("session.execution.started", { sessionID: A });
    await c.idle();
    c.handle("permission.asked", { sessionID: A, id: "p1" });
    await c.idle();
    c.handle("permission.replied", { sessionID: A, requestID: "p1" });
    c.handle("session.execution.succeeded", { sessionID: A });
    await c.idle();
    expect(reports.map(([, st]) => st)).toEqual(["working", "needs input", "waiting"]);
    expect(reports[0]).toEqual(["w1:p1", "working", "Driver: impl"]);
    panes.userCloses("w1:p1");
    c.handle("session.execution.started", { sessionID: A });
    await c.idle();
    expect(reports.at(-1)).toEqual(["w1:p2", "working (run 2)", "Driver: impl"]);
  });

  test("onNeedsInput fires once per wait, for panes and pane-less subagents alike", async () => {
    const alerts = [];
    const { c, ev, spawn } = setup({ exclude: () => true, onNeedsInput: (id, info) => alerts.push([id, info]) });
    spawn(A, ROOT, "Echo: x");
    ev("permission.asked", { sessionID: A, id: "p1", permission: "bash" });
    ev("form.created", { form: { sessionID: A, id: "f1", title: "Which file?" } }); // already waiting: no second alert
    ev("permission.replied", { sessionID: A, requestID: "p1" });
    ev("form.replied", { sessionID: A, id: "f1" });
    ev("form.created", { form: { sessionID: A, id: "f2", title: "Which file?" } });
    await c.idle();
    expect(alerts).toEqual([
      [A, { title: "Echo: x", kind: "permission", detail: "bash" }],
      [A, { title: "Echo: x", kind: "question", detail: "Which file?" }],
    ]);
  });
});

describe("open delay", () => {
  const D = 10_000;

  test("a subagent gets a pane only after working for the delay", async () => {
    const { c, timers, panes, spawn, start } = setup({ openDelayMs: D });
    spawn(A, ROOT, "Research: a");
    start(A);
    await c.idle();
    timers.advance(D - 1);
    await c.idle();
    expect(panes.opens()).toEqual([]);
    timers.advance(1);
    await c.idle();
    expect(panes.opens().map((x) => x[1])).toEqual([A]);
  });

  test("a subagent that finishes within the delay never gets a pane", async () => {
    const { c, timers, panes, spawn, start, stop } = setup({ openDelayMs: D });
    spawn(A, ROOT, "Caesar: codebreaking");
    start(A);
    timers.advance(4_000);
    stop(A);
    timers.advance(D);
    await c.idle();
    expect(panes.opens()).toEqual([]);
    expect(c.isTracked(A)).toBe(true); // still known (e.g. for the summary strip)
  });

  test("a resumed subagent gets a fresh delay", async () => {
    const { c, timers, panes, spawn, start, stop } = setup({ openDelayMs: D });
    spawn(A, ROOT, "Navigator: impl");
    start(A);
    timers.advance(3_000);
    stop(A);
    timers.advance(D);
    start(A);
    timers.advance(D);
    await c.idle();
    expect(panes.opens().map((x) => x[1])).toEqual([A]);
  });

  test("asking for input opens the pane at once", async () => {
    const { c, panes, spawn, start, ev } = setup({ openDelayMs: D });
    spawn(A);
    start(A);
    ev("permission.asked", { sessionID: A, id: "p1" });
    await c.idle();
    expect(panes.opens().map((x) => x[1])).toEqual([A]);
  });

  test("a parent waiting on a working child opens with it", async () => {
    const NAV = "ses_nav", DRV = "ses_drv";
    const { c, timers, panes, spawn, start, stop } = setup({ openDelayMs: D });
    spawn(NAV, ROOT, "Navigator: impl");
    start(NAV);
    timers.advance(5_000);
    spawn(DRV, NAV, "Driver: impl");
    stop(NAV); // waits for its driver
    start(DRV);
    timers.advance(D);
    await c.idle();
    expect(panes.opens().map((x) => x[1]).sort()).toEqual([DRV, NAV].sort());
  });

  test("a pane the user closed reopens at once on the next work", async () => {
    const { c, timers, panes, spawn, start, stop } = setup({ openDelayMs: D });
    spawn(A);
    start(A);
    timers.advance(D);
    await c.idle();
    stop(A);
    panes.userCloses("w1:p1");
    start(A);
    await c.idle();
    expect(panes.opens().length).toBe(2);
  });
});

describe("summary strip", () => {
  function withStrip(opts = {}) {
    const events = [];
    const strip = { open: async () => events.push("open"), close: async () => events.push("close") };
    return { ...setup({ strip, ...opts }), events };
  }

  test("opens with the first subagent, before its delayed pane", async () => {
    const { c, timers, panes, spawn, start, events } = withStrip({ openDelayMs: 10_000 });
    start(ROOT);
    spawn(A, ROOT, "Caesar: codebreaking");
    start(A);
    await c.idle();
    expect(events).toEqual(["open"]);
    expect(panes.opens()).toEqual([]);
    spawn(B, ROOT, "Atbash: codebreaking");
    await c.idle();
    expect(events).toEqual(["open"]); // only once
    timers.advance(10_000);
    await c.idle();
  });

  test("shows quick subagents that never get a pane, then closes once quiet", async () => {
    const { c, timers, panes, spawn, start, stop, events } = withStrip({ openDelayMs: 10_000 });
    start(ROOT);
    spawn(A);
    start(A);
    timers.advance(3_000);
    stop(A);
    stop(ROOT);
    await c.idle();
    timers.advance(19_999);
    await c.idle();
    expect(events).toEqual(["open"]);
    timers.advance(1);
    await c.idle();
    expect(events).toEqual(["open", "close"]);
    expect(panes.opens()).toEqual([]);
  });

  test("new activity cancels the strip countdown; it reopens for a later run", async () => {
    const { c, timers, spawn, start, stop, events } = withStrip();
    spawn(A);
    start(A);
    stop(A);
    await c.idle();
    timers.advance(10_000);
    start(A); // resumed before the countdown ended
    timers.advance(30_000);
    await c.idle();
    expect(events).toEqual(["open"]);
    stop(A);
    timers.advance(20_000);
    await c.idle();
    spawn(B);
    await c.idle();
    expect(events).toEqual(["open", "close", "open"]);
  });

  test("stays open while a view is expanded, and with autoClose off", async () => {
    const pinned = withStrip({ isPinned: () => true });
    pinned.spawn(A);
    pinned.start(A);
    pinned.stop(A);
    await pinned.c.idle();
    pinned.timers.advance(120_000);
    await pinned.c.idle();
    expect(pinned.events).toEqual(["open"]);

    const keep = withStrip({ autoClose: false });
    keep.spawn(A);
    keep.timers.advance(120_000);
    await keep.c.idle();
    expect(keep.events).toEqual(["open"]);
  });

  test("closes with everything else when the route changes", async () => {
    const { c, spawn, events } = withStrip();
    spawn(A);
    c.setRoute("ses_other_root");
    await c.idle();
    expect(events).toEqual(["open", "close"]);
  });
});

describe("exclusion", () => {
  test("excluded subagents get no pane but stay tracked", async () => {
    const { c, panes, spawn, start } = setup({ exclude: ({ title }) => /^Echo:/.test(title ?? "") });
    spawn(A, ROOT, "Echo: x");
    spawn(B, ROOT, "Research: y");
    start(A);
    start(B);
    await c.idle();
    expect(panes.opens().map((x) => x[1])).toEqual([B]);
    expect(c.isTracked(A)).toBe(true);
  });

  test("an excluded subagent that needs input still gets a pane", async () => {
    const { c, panes, spawn, ev } = setup({ exclude: () => true });
    spawn(A);
    ev("form.created", { form: { sessionID: A, id: "f1" } });
    await c.idle();
    expect(panes.opens().map((x) => x[1])).toEqual([A]);
  });
});

describe("unique titles", () => {
  test("repeated titles get #2, #3 in creation order", async () => {
    const { c, spawn } = setup();
    spawn("ses_1", ROOT, "Research: x");
    spawn("ses_2", ROOT, "Research: x");
    spawn("ses_3", ROOT, "Research: x");
    spawn("ses_4", ROOT, "Docs: y");
    await c.idle();
    expect(["ses_1", "ses_2", "ses_3", "ses_4"].map((id) => c.titleOf(id))).toEqual([
      "Research: x",
      "Research: x #2",
      "Research: x #3",
      "Docs: y",
    ]);
    expect(c.snapshot().find((x) => x.id === "ses_2").label).toBe("Research: x #2 · starting");
  });
});

describe("adopting existing subagents", () => {
  test("running ones open at once, idle ones are tracked without a pane", async () => {
    const { c, panes } = setup({ openDelayMs: 10_000 });
    c.adopt([
      { id: "ses_nav", parentID: ROOT, title: "Navigator: impl", running: false },
      { id: "ses_drv", parentID: "ses_nav", title: "Driver: impl", running: true },
      { id: "ses_res", parentID: ROOT, title: "Research: a", running: false },
      { id: "ses_foreign", parentID: "ses_elsewhere", title: "Other", running: true },
    ]);
    await c.idle();
    // The driver runs; its navigator waits on it, so both show. Research is done.
    expect(panes.opens().map((x) => x[1]).sort()).toEqual(["ses_drv", "ses_nav"]);
    expect(c.isTracked("ses_res")).toBe(true);
    expect(c.isTracked("ses_foreign")).toBe(false);
    expect(c.snapshot().find((s) => s.id === "ses_drv").label).toBe("Driver: impl · working");
  });

  test("adopted panes close once the tree is quiet, like any other", async () => {
    const { c, timers, panes, stop } = setup();
    c.adopt([{ id: A, parentID: ROOT, title: "Research: a", running: true }]);
    await c.idle();
    stop(A);
    await c.idle();
    timers.advance(20_000);
    await c.idle();
    expect(panes.closes()).toEqual([["close", "w1:p1"]]);
  });
});

describe("lifecycle", () => {
  test("session.deleted closes immediately", async () => {
    const { c, panes, spawn, ev } = setup();
    spawn(A);
    await c.idle();
    ev("session.deleted", { sessionID: A });
    await c.idle();
    expect(panes.open_.size).toBe(0);
  });

  test("switching to a different root session closes all viewers", async () => {
    const { c, panes, spawn } = setup();
    spawn(A);
    spawn(B);
    await c.idle();
    c.setRoute("ses_unrelated");
    await c.idle();
    expect(panes.open_.size).toBe(0);
  });

  test("navigating into a child keeps viewers (same root)", async () => {
    const { c, panes, spawn } = setup();
    spawn(A);
    await c.idle();
    c.setRoute(A);
    await c.idle();
    expect(panes.open_.size).toBe(1);
  });

  test("renames the pane when the child session gets a title", async () => {
    const { c, spawn, ev, labelOf } = setup();
    spawn(A);
    await c.idle();
    ev("session.renamed", { sessionID: A, title: "Reply PONG" });
    await c.idle();
    expect(labelOf("w1:p1")).toBe("Reply PONG · starting");
  });

  test("labels are only pushed when they change", async () => {
    const { c, panes, spawn, start } = setup();
    spawn(A);
    start(A);
    start(A); // duplicate started, label "working (run 2)" once
    await c.idle();
    const renames = panes.calls.filter((x) => x[0] === "rename").map((x) => x[2]);
    expect(new Set(renames).size).toBe(renames.length);
  });

  test("dispose closes everything, clears timers and ignores later events", async () => {
    const { c, timers, panes, spawn, stop } = setup();
    spawn(A);
    stop(A);
    await c.idle();
    await c.dispose();
    expect(panes.open_.size).toBe(0);
    expect(timers.count).toBe(0);
    spawn(B);
    await c.idle();
    expect(panes.opens().length).toBe(1);
  });
});
