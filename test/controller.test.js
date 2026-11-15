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
  const open = new Set();
  const calls = [];
  return {
    open: async (childId, anchor, label) => {
      const id = `w1:p${++n}`;
      open.add(id);
      calls.push(["open", childId, anchor.paneId ?? "parent", anchor.direction, label]);
      return id;
    },
    exists: async (paneId) => open.has(paneId),
    close: async (paneId) => {
      open.delete(paneId);
      calls.push(["close", paneId]);
    },
    rename: async (paneId, label) => calls.push(["rename", paneId, label]),
    userCloses: (paneId) => open.delete(paneId),
    open_: open,
    calls,
  };
}

function setup(opts = {}) {
  const timers = fakeTimers();
  const panes = fakePanes();
  const c = createController({ panes, timers, closeDelayMs: 20_000, maxPanes: 4, ...opts });
  c.setRoute(ROOT);
  const spawn = (id, parentID = ROOT) => c.handle("session.created", { sessionID: id, parentID });
  const ev = (type, data) => c.handle(type, data);
  return { c, timers, panes, spawn, ev };
}

describe("opening", () => {
  test("opens a pane to the right of the parent when a subagent is created", async () => {
    const { c, panes, spawn } = setup();
    spawn(A);
    await c.idle();
    expect(panes.calls).toEqual([["open", A, "parent", "right", "subagent childA"]]);
  });

  test("stacks further subagents below the previous viewer", async () => {
    const { c, panes, spawn } = setup();
    spawn(A);
    spawn(B);
    await c.idle();
    expect(panes.calls[1]).toEqual(["open", B, "w1:p1", "down", "subagent childB"]);
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
    expect(panes.calls.map((x) => x[1])).toEqual([A, "ses_grandchild"]);
  });

  test("does nothing before a route is known", async () => {
    const timers = fakeTimers();
    const panes = fakePanes();
    const c = createController({ panes, timers });
    c.handle("session.created", { sessionID: A, parentID: ROOT });
    await c.idle();
    expect(panes.calls).toEqual([]);
  });

  test("resolves the root via the fallback lookup when the event was missed", async () => {
    const { c, panes, ev } = setup({ lookupParent: (id) => (id === A ? ROOT : undefined) });
    ev("session.execution.started", { sessionID: A });
    await c.idle();
    expect(panes.calls[0][0]).toBe("open");
  });

  test("respects the pane cap", async () => {
    const { c, panes, spawn } = setup({ maxPanes: 1 });
    spawn(A);
    spawn(B);
    await c.idle();
    expect(panes.calls.filter((x) => x[0] === "open").length).toBe(1);
  });
});

describe("debounced closing", () => {
  test("closes only after the debounce once the subagent is idle", async () => {
    const { c, timers, panes, spawn, ev } = setup();
    spawn(A);
    ev("session.execution.started", { sessionID: A });
    await c.idle();
    ev("session.execution.succeeded", { sessionID: A });
    timers.advance(19_999);
    await c.idle();
    expect(panes.open_.size).toBe(1);
    timers.advance(1);
    await c.idle();
    expect(panes.open_.size).toBe(0);
  });

  test("new work within the debounce cancels the close and keeps the same pane", async () => {
    const { c, timers, panes, spawn, ev } = setup();
    spawn(A);
    ev("session.execution.started", { sessionID: A });
    await c.idle();
    ev("session.execution.succeeded", { sessionID: A });
    timers.advance(10_000);
    ev("session.execution.started", { sessionID: A }); // parent resumes the child
    timers.advance(30_000);
    await c.idle();
    expect(panes.calls.filter((x) => x[0] === "close")).toEqual([]);
    expect(panes.calls.filter((x) => x[0] === "open").length).toBe(1);
  });

  test("rapid idle/active flapping produces a single open and a single close", async () => {
    const { c, timers, panes, spawn, ev } = setup();
    spawn(A);
    for (let i = 0; i < 10; i++) {
      ev("session.execution.started", { sessionID: A });
      ev("session.execution.succeeded", { sessionID: A });
      timers.advance(1_000);
    }
    await c.idle();
    timers.advance(20_000);
    await c.idle();
    expect(panes.calls.filter((x) => x[0] === "open").length).toBe(1);
    expect(panes.calls.filter((x) => x[0] === "close").length).toBe(1);
    expect(timers.count).toBe(0);
  });

  test("reopens if the child is resumed after its pane closed", async () => {
    const { c, timers, panes, spawn, ev } = setup();
    spawn(A);
    ev("session.execution.started", { sessionID: A });
    ev("session.execution.succeeded", { sessionID: A });
    await c.idle();
    timers.advance(20_000);
    await c.idle();
    ev("session.execution.started", { sessionID: A });
    await c.idle();
    expect(panes.calls.map((x) => x[0])).toEqual(["open", "close", "open"]);
  });

  test("a child that goes idle before its pane finished opening still gets closed", async () => {
    const { c, timers, panes, spawn, ev } = setup();
    spawn(A);
    ev("session.execution.started", { sessionID: A });
    ev("session.execution.succeeded", { sessionID: A }); // before open resolves
    await c.idle();
    timers.advance(20_000);
    await c.idle();
    expect(panes.open_.size).toBe(0);
  });

  test("interrupted and failed rounds also start the debounce", async () => {
    for (const type of ["session.execution.interrupted", "session.execution.failed"]) {
      const { c, timers, panes, spawn, ev } = setup();
      spawn(A);
      ev("session.execution.started", { sessionID: A });
      ev(type, { sessionID: A });
      await c.idle();
      timers.advance(20_000);
      await c.idle();
      expect(panes.open_.size).toBe(0);
    }
  });

  test("stays open while a permission request is pending, closes after reply + debounce", async () => {
    const { c, timers, panes, spawn, ev } = setup();
    spawn(A);
    ev("session.execution.started", { sessionID: A });
    ev("permission.asked", { sessionID: A, id: "perm1" });
    ev("session.execution.succeeded", { sessionID: A });
    await c.idle();
    timers.advance(60_000);
    await c.idle();
    expect(panes.open_.size).toBe(1);
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
    const { c, panes, spawn, ev } = setup();
    spawn(A);
    await c.idle();
    panes.userCloses("w1:p1");
    ev("session.execution.started", { sessionID: A });
    await c.idle();
    expect(panes.calls.filter((x) => x[0] === "open").length).toBe(2);
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
    const { c, panes, spawn, ev } = setup();
    spawn(A);
    await c.idle();
    ev("session.renamed", { sessionID: A, title: "Reply PONG" });
    await c.idle();
    expect(panes.calls.at(-1)).toEqual(["rename", "w1:p1", "subagent: Reply PONG"]);
  });

  test("dispose closes everything, clears timers and ignores later events", async () => {
    const { c, timers, panes, spawn, ev } = setup();
    spawn(A);
    ev("session.execution.succeeded", { sessionID: A });
    await c.idle();
    await c.dispose();
    expect(panes.open_.size).toBe(0);
    expect(timers.count).toBe(0);
    spawn(B);
    await c.idle();
    expect(panes.calls.filter((x) => x[0] === "open").length).toBe(1);
  });
});
