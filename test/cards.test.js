import { describe, expect, test } from "bun:test";
import { createCardStore, describeIncoming, summarizeTool } from "../plugin/cards.js";
import { formatElapsed, renderCard, wrap } from "../plugin/card.js";
import { cardCommand } from "../plugin/tui.js";

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function store() {
  const writes = [];
  let t = 1_000;
  const s = createCardStore({ write: (id, card) => writes.push(card), now: () => t, throttleMs: 0 });
  return { s, writes, last: () => writes.at(-1), tick: (ms) => (t += ms) };
}

describe("card store", () => {
  test("tracks status, rounds and round timing", () => {
    const { s, last, tick } = store();
    s.status("A", { title: "Navigator: impl", status: "starting", rounds: 0 });
    s.handle("session.execution.started", { sessionID: "A" });
    tick(5_000);
    s.handle("session.execution.succeeded", { sessionID: "A" });
    expect(last()).toMatchObject({ title: "Navigator: impl", startedAt: 1_000, endedAt: 6_000 });
  });

  test("keeps the latest incoming message without the subagent preamble", () => {
    const { s, last } = store();
    s.handle("session.inbox.enqueued", {
      sessionID: "A",
      item: { payload: { text: "You are a subagent spawned by another session.\nDriver says: tests added" } },
    });
    expect(last().incoming).toBe("parent: Driver says: tests added");
  });

  test("streams assistant text and settles on the final text", () => {
    const { s, last } = store();
    s.handle("session.text.started", { sessionID: "A" });
    s.handle("session.text.delta", { sessionID: "A", delta: "Plan: " });
    s.handle("session.text.delta", { sessionID: "A", delta: "export words()" });
    expect(last().text).toBe("Plan: export words()");
    s.handle("session.text.ended", { sessionID: "A", text: "Plan: export words() and topWords()" });
    expect(last().text).toBe("Plan: export words() and topWords()");
  });

  test("names the current tool and marks it done", () => {
    const { s, last } = store();
    s.handle("session.tool.input.started", { sessionID: "A", id: "t1", name: "read" });
    s.handle("session.tool.called", { sessionID: "A", id: "t1", input: { filePath: "/repo/wordfreq.js" } });
    expect(last().tool).toEqual({ name: "read", summary: "read wordfreq.js", done: false });
    s.handle("session.tool.success", { sessionID: "A", id: "t1" });
    expect(last().tool.done).toBe(true);
  });

  test("throttles streaming writes but writes status changes immediately", () => {
    const pending = [];
    const timers = { setTimeout: (fn) => pending.push(fn) && pending.length, clearTimeout: () => {} };
    const writes = [];
    const s = createCardStore({ write: (id, c) => writes.push(c), throttleMs: 200, timers });
    for (let i = 0; i < 20; i++) s.handle("session.text.delta", { sessionID: "A", delta: "x" });
    expect(writes.length).toBe(0);
    expect(pending.length).toBe(1);
    pending[0]();
    expect(writes.length).toBe(1);
    s.status("A", { status: "working" });
    expect(writes.length).toBe(2);
  });
});

describe("describeIncoming", () => {
  test("attributes messages from the parent", () => {
    expect(describeIncoming("You are a subagent spawned by another session.\nPlan the work", "orchestrator"))
      .toEqual({ from: "orchestrator", text: "Plan the work" });
  });

  test("attributes results from the subagent's own subagents", () => {
    const text = '<subagent sessionID="ses_d" state="completed" description="Driver: implementation">\nImplemented words().\n</subagent>';
    expect(describeIncoming(text, "orchestrator")).toEqual({ from: "Driver: implementation (completed)", text: "Implemented words()." });
  });

  test("the store prefixes the sender using parentLabel", () => {
    const writes = [];
    const s = createCardStore({ write: (id, c) => writes.push(c), parentLabel: () => "Navigator: implementation", throttleMs: 0 });
    s.handle("session.inbox.enqueued", { sessionID: "D", item: { payload: { text: "Add a test for --top 0" } } });
    expect(writes.at(-1).incoming).toBe("Navigator: implementation: Add a test for --top 0");
  });
});

describe("summarizeTool", () => {
  test("prefers command, then file name, then other descriptive fields", () => {
    expect(summarizeTool("bash", { command: "bun test   --watch" })).toBe("bash bun test --watch");
    expect(summarizeTool("edit", { filePath: "/a/b/c.js" })).toBe("edit c.js");
    expect(summarizeTool("grep", { pattern: "\\p{L}" })).toBe("grep \\p{L}");
    expect(summarizeTool("todo", {})).toBe("todo");
  });
});

describe("renderCard", () => {
  const base = {
    id: "A",
    title: "Navigator: implementation",
    status: "working (run 2)",
    rounds: 2,
    startedAt: 0,
    endedAt: null,
    tool: { name: "read", summary: "read wordfreq.js", done: false },
    text: "Looks good overall. One issue: **--top 0** should be rejected.",
    incoming: "Driver says: implemented words(), countWords(), topWords()",
  };

  test("shows title, status with elapsed time, incoming message, tool, text and hint", () => {
    const lines = renderCard(base, { cols: 60, rows: 14, now: 65_000 }).map(strip);
    expect(lines[0]).toBe(" Navigator: implementation");
    expect(lines[1]).toBe(" ● working (run 2)  ·  1m05s");
    expect(lines.join("\n")).toContain("← Driver says: implemented words()");
    expect(lines.join("\n")).toContain("⚙ read wordfreq.js");
    expect(lines.join("\n")).toContain("--top 0 should be rejected."); // markdown stripped
    expect(lines.at(-1)).toContain("ctrl+b z: expand / return");
    expect(lines.at(-1)).not.toContain("click");
    expect(lines.length).toBe(14);
  });

  test("keeps the most recent text when space is short", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const lines = renderCard({ ...base, text, incoming: null, tool: null }, { cols: 40, rows: 8, now: 0 }).map(strip);
    expect(lines.join("\n")).toContain("line29");
    expect(lines.join("\n")).not.toContain("line0\n");
  });

  test("renders a placeholder before state exists", () => {
    expect(strip(renderCard(undefined, { cols: 40, rows: 5 })[0])).toContain("waiting for subagent");
  });

  test("wrap and formatElapsed", () => {
    expect(wrap("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
    expect(formatElapsed(4_200)).toBe("4s");
    expect(formatElapsed(125_000)).toBe("2m05s");
  });
});

test("cardCommand runs the card script with embedded bun and quotes arguments", () => {
  const cmd = cardCommand({ bin: "/o/opencode", cardScript: "/p/card.js", stateFile: "/r/x.json", childId: "ses_1", server: "http://h:1" });
  expect(cmd).toBe("exec env BUN_BE_BUN=1 '/o/opencode' '/p/card.js' --state '/r/x.json' --session 'ses_1' --bin '/o/opencode' --server 'http://h:1'");
});

test("cards count tool calls and show a chips line", () => {
  const writes = [];
  const store = createCardStore({ write: (id, c) => writes.push(c), throttleMs: 0 });
  for (const [i, name] of ["bash", "read", "bash"].entries()) store.handle("session.tool.input.started", { sessionID: "s", id: `t${i}`, name });
  expect(writes.at(-1)).toMatchObject({ toolCount: 3, chips: "bash ×2 · read" });
  expect(writes.at(-1).tools).toBeUndefined();
  const lines = renderCard(writes.at(-1), { cols: 60, rows: 12, now: 0 }).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  expect(lines.join("\n")).toContain("⚒ 3 · bash ×2 · read");
});
