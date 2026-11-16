import { describe, expect, test } from "bun:test";
import { buildTree, collapse, edgePath, layoutTree, MESSAGE_MS, messageGlyphs, renderGraph } from "../plugin/graph.js";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const S = (id, parentID, title, extra = {}) => ({
  id, parentID, title, order: 0, running: false, runStart: null, activeMs: 9000, blocked: false,
  tokensIn: 1000, tokensOut: 100, runs: [[0, 9000]], toolCount: 0, ...extra,
});

describe("graph layout", () => {
  const snap = {
    root: "r",
    sessions: [S("r", null, "Build"), S("a", "r", "Research: x"), S("n", "r", "Navigator: y"), S("d", "n", "Driver: y")],
  };

  test("buildTree nests by parent", () => {
    const t = buildTree(snap);
    expect(t.session.id).toBe("r");
    expect(t.children.map((c) => c.session.id)).toEqual(["a", "n"]);
    expect(t.children[1].children.map((c) => c.session.id)).toEqual(["d"]);
  });

  test("leaves get slots left to right; parents centre over their children", () => {
    const { nodes, width, height } = layoutTree(buildTree(snap), { cols: 60 });
    const at = Object.fromEntries(nodes.map((n) => [n.session.id, n]));
    expect(at.a.w).toBe(28);
    expect([at.a.x, at.d.x]).toEqual([0, 30]); // two leaves
    expect(at.n.x).toBe(at.d.x); // single child: straight down
    expect(at.r.cx).toBe(Math.floor((at.a.cx + at.n.cx) / 2));
    expect([at.r.y, at.a.y, at.d.y]).toEqual([0, 8, 16]);
    expect([width, height]).toEqual([58, 21]);
  });

  test("too many siblings collapse into a '+N more' box", () => {
    const wide = { root: "r", sessions: [S("r", null, "x"), ...["1", "2", "3", "4", "5"].map((i) => S(i, "r", `T${i}: t`))] };
    const t = collapse(buildTree(wide), 3);
    expect(t.children.length).toBe(3);
    expect(t.children[2].more.map((s) => s.id)).toEqual(["5", "4", "3"]);
  });
});

describe("renderGraph", () => {
  test("draws boxes and connectors with status, time, tokens and tools", () => {
    const snap = {
      root: "r",
      sessions: [S("r", null, "Build", { activeMs: 1000 }), S("a", "r", "Research: x", { toolCount: 3 }), S("b", "r", "Docs: y", { running: true, runStart: 0, activeMs: 0 })],
    };
    const lines = renderGraph(snap, { cols: 64, rows: 16, now: 5000 }).map(strip);
    expect(lines).toEqual([
      " agent graph · live",
      "",
      "                  ┌──────────────────────────┐",
      "                  │ ◌ orchestrator · Build   │",
      "                  │ waiting · 1s             │",
      "                  │ 1.0k/100                 │",
      "                  └─────────────┬────────────┘",
      "                                │",
      "                 ┌──────────────┴──────────────┐",
      "                 │                             │",
      "   ┌─────────────┴────────────┐  ┌─────────────┴────────────┐",
      "   │ ○ Research: x            │  │ ● Docs: y                │",
      "   │ idle · 9s                │  │ active · 5s              │",
      "   │ 1.0k/100 · ⚒ 3           │  │ 1.0k/100                 │",
      "   └──────────────────────────┘  └──────────────────────────┘",
      " ↑↓ select · ⏎ expand · o open · f follow · ←→ replay",
    ]);
  });

  test("a collapsed box counts what it hides, and the root waits on it", () => {
    const snap = { root: "r", sessions: [S("r", null, "x"), ...["1", "2", "3", "4"].map((i) => S(i, "r", `T${i}: t`, i === "4" ? { blocked: true } : {}))] };
    const text = renderGraph(snap, { cols: 50, rows: 16, now: 0 }).map(strip).join("\n");
    expect(text).toContain("▲ +2 more");
    expect(text).toContain("1 need inp");
    expect(text).toContain("◌ orchestr");
  });

  test("selected box content is in reverse video; replay shows in the header", () => {
    const snap = { root: "r", sessions: [S("r", null, "x"), S("a", "r", "Research: x", { runs: [[0, 9000]] })] };
    const lines = renderGraph(snap, { cols: 60, rows: 14, now: 9000, selected: "a", cursor: 4000 });
    expect(lines.some((l) => l.includes("\x1b[7m ○ Research: x") || l.includes("\x1b[7m ● Research: x"))).toBe(true);
    expect(strip(lines[0])).toBe(" agent graph · replay · 4s of 9s");
  });
});

describe("message animations", () => {
  const snap = {
    root: "r",
    sessions: [S("r", null, "Build"), S("a", "r", "Research: x"), S("b", "r", "Docs: y")],
    messages: [{ t: 1000, from: "r", to: "b", kind: "task" }, { t: 1000, from: "a", to: "r", kind: "result" }],
  };
  const laid = () => {
    const tree = buildTree(snap);
    const { nodes } = layoutTree(tree, { cols: 62 });
    return { tree, byId: new Map(nodes.map((n) => [n.session.id, n])) };
  };

  test("edgePath runs from under the parent, along the bus, to above the child", () => {
    const { byId } = laid();
    const path = edgePath(byId.get("r"), byId.get("b"), { top: 2, left: 3 });
    expect(path[0]).toEqual([3 + byId.get("r").cx, 2 + 5]);
    expect(path.at(-1)).toEqual([3 + byId.get("b").cx, 2 + 7]);
    expect(path.every(([, y], i) => i === 0 || y >= path[i - 1][1])).toBe(true);
  });

  test("a task travels down its edge and a result travels up, only while in flight", () => {
    const { byId } = laid();
    const offsets = { top: 2, left: 3 };
    const heads = (at) => messageGlyphs(snap.messages, byId, at, offsets).filter((g) => g.glyph !== "·");
    const task = (at) => heads(at).find((g) => g.glyph === "●");
    const result = (at) => heads(at).find((g) => g.glyph === "◆");
    const down = edgePath(byId.get("r"), byId.get("b"), offsets);
    const up = edgePath(byId.get("r"), byId.get("a"), offsets).reverse();
    expect([task(1000).x, task(1000).y]).toEqual(down[0]);
    expect([task(1000 + MESSAGE_MS - 1).x, task(1000 + MESSAGE_MS - 1).y]).toEqual(down.at(-1));
    expect([result(1000).x, result(1000).y]).toEqual(up[0]); // starts just above the subagent
    expect(heads(999)).toEqual([]);
    expect(heads(1000 + MESSAGE_MS)).toEqual([]);
  });

  test("renderGraph draws the glyphs over the connectors", () => {
    const text = renderGraph(snap, { cols: 64, rows: 16, now: 1500 }).map(strip).join("\n");
    expect(text).toContain("●");
    expect(text).toContain("◆");
    expect(renderGraph(snap, { cols: 64, rows: 16, now: 5000 }).map(strip).join("\n")).not.toContain("●");
  });
});
