import { describe, expect, test } from "bun:test";
import { createController } from "../plugin/controller.js";

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
  return {
    open: async (childId, anchor, label) => {
      const id = `w1:p${++n}`;
      open.set(id, label);
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

  test("stacks further subagents below the previous viewer", async () => {
    const { c, panes, spawn } = setup();
    spawn(A);
    spawn(B);
    await c.idle();
    expect(panes.opens()[1]).toEqual(["open", B, "w1:p1", "down"]);
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
    expect(labelOf("w1:p1")).toBe("Navigator · working (round 2)");
    expect(labelOf("w1:p2")).toBe("Driver · waiting");
    stop(NAV);
    start(DRV); // apply feedback
    await c.idle();
    expect(labelOf("w1:p2")).toBe("Driver · working (round 2)");
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

describe("layout and capacity", () => {
  test("new viewers always stack below the most recently opened one", async () => {
    const C = "ses_childC";
    const { c, panes, spawn, start, stop } = setup();
    spawn(A);
    spawn(B);
    start(B); // B stays busy throughout
    start(A);
    stop(A);
    await c.idle();
    panes.userCloses("w1:p1"); // A's pane (top) is closed by the user
    start(A); // A reopens -> goes to the bottom, below B
    await c.idle();
    spawn(C); // C goes below A (the newest), not below B
    await c.idle();
    const opens = panes.opens();
    expect(opens[2]).toEqual(["open", A, "w1:p2", "down"]);
    expect(opens[3]).toEqual(["open", C, "w1:p3", "down"]);
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
    start(A); // duplicate started, label "working (round 2)" once
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
