// Agent graph: the orchestrator and its subagents as boxes joined by lines,
// laid out as a tree (leaves spread evenly, each parent centred over its
// children). Reads the same state file as the summary strip and shares its
// keyboard controls (select, expand, follow, replay).
//
// Run by the plugin in its own tab as:
//   BUN_BE_BUN=1 opencode graph.js --state <summary.json> [--owner <TUI pid>]
// (the plugin passes the arguments in the pane environment instead; see launch.js)
import { watchOwner } from "./watchdog.js";
import { launchArgs } from "./launch.js";
import { formatDuration, formatTokens, runInteractive, snapshotAt, treeRows } from "./summary.js";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const REVERSE = `${ESC}7m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const YELLOW = `${ESC}33m`;
const GREY = `${ESC}90m`;
const CYAN = `${ESC}1;36m`;
const MAGENTA = `${ESC}1;35m`;

/** How long a message takes to travel along an edge. */
export const MESSAGE_MS = 1_200;

export const BOX_H = 5; // top border, three lines, bottom border
export const GAP_H = 3; // connector rows between levels
const MIN_W = 14;
const MAX_W = 28;
const H_GAP = 2;
export const GRAPH_HINT = "↑↓ select · ⏎ expand · o open · f follow · ←→ replay";

/** The snapshot's agents as a tree of { session, children } (orphans hang off the root). */
export function buildTree(snap) {
  const rows = treeRows(snap);
  if (!rows.length) return undefined;
  const nodes = new Map(rows.map(({ session }) => [session.id, { session, children: [] }]));
  const root = nodes.get(snap.root);
  for (const { session } of rows) {
    if (session.id === snap.root) continue;
    const parent = nodes.get(session.parentID) ?? root;
    parent.children.push(nodes.get(session.id));
  }
  return root;
}

const leaves = (n) => (n.children.length ? n.children.reduce((k, c) => k + leaves(c), 0) : 1);

/**
 * Collapse siblings into a "+N more" node until at most `maxLeaves` leaves
 * remain, taking from whichever node has the most children.
 */
export function collapse(root, maxLeaves) {
  const all = (n) => [n, ...n.children.flatMap(all)];
  while (leaves(root) > maxLeaves) {
    const widest = all(root).filter((n) => n.children.filter((c) => !c.more).length >= 2).sort((a, b) => b.children.length - a.children.length)[0];
    if (!widest) break;
    let more = widest.children.find((c) => c.more);
    if (!more) {
      more = { more: [], children: [] };
      widest.children.push(more);
    }
    const victim = [...widest.children].reverse().find((c) => !c.more);
    widest.children.splice(widest.children.indexOf(victim), 1);
    more.more.push(victim.session, ...all(victim).slice(1).filter((n) => n.session).map((n) => n.session));
  }
  return root;
}

/**
 * Positions: each node gets { x, y, w } (its box), leaves in slots left to
 * right, parents centred over their children. Returns { nodes, width, height }.
 */
export function layoutTree(root, { cols }) {
  const maxLeaves = Math.max(1, Math.floor((cols + H_GAP) / (MIN_W + H_GAP)));
  collapse(root, maxLeaves);
  const count = leaves(root);
  const w = Math.max(MIN_W, Math.min(MAX_W, Math.floor((cols - H_GAP * (count - 1)) / count)));
  const placed = [];
  let slot = 0;
  let depthMax = 0;
  const place = (n, depth) => {
    depthMax = Math.max(depthMax, depth);
    let cx;
    if (!n.children.length) {
      cx = slot * (w + H_GAP) + Math.floor(w / 2);
      slot += 1;
    } else {
      const centres = n.children.map((c) => place(c, depth + 1));
      cx = Math.floor((centres[0] + centres.at(-1)) / 2);
    }
    n.x = cx - Math.floor(w / 2);
    n.y = depth * (BOX_H + GAP_H);
    n.w = w;
    n.cx = cx;
    placed.push(n);
    return cx;
  };
  place(root, 0);
  return { nodes: placed, width: count * w + (count - 1) * H_GAP, height: (depthMax + 1) * BOX_H + depthMax * GAP_H };
}

/**
 * The cells of the connector from a parent's box down to a child's box, in
 * order from parent to child: down from the parent, along the bus, down to the child.
 */
export function edgePath(parent, child, { top, left }) {
  const yb = top + parent.y + BOX_H - 1;
  const px = left + parent.cx;
  const cx = left + child.cx;
  const cells = [[px, yb + 1], [px, yb + 2]];
  const dir = Math.sign(cx - px);
  for (let x = px + dir; dir !== 0 && x !== cx + dir; x += dir) cells.push([x, yb + 2]);
  cells.push([cx, yb + 3]);
  return cells;
}

/**
 * Glyphs for messages in flight at time `at`: a task travels down its edge, a
 * result travels up, over MESSAGE_MS. Returns [{ x, y, glyph, style }].
 */
export function messageGlyphs(messages, nodesById, at, offsets) {
  const out = [];
  for (const m of messages ?? []) {
    const age = at - m.t;
    if (age < 0 || age >= MESSAGE_MS) continue;
    const down = m.kind !== "result";
    const parent = nodesById.get(down ? m.from : m.to);
    const child = nodesById.get(down ? m.to : m.from);
    if (!parent || !child || !parent.children.includes(child)) continue;
    const path = edgePath(parent, child, offsets);
    const ordered = down ? path : [...path].reverse();
    const i = Math.min(ordered.length - 1, Math.floor((age / MESSAGE_MS) * ordered.length));
    const style = down ? CYAN : MAGENTA;
    for (let k = 2; k >= 1; k--) if (i - k >= 0) out.push({ x: ordered[i - k][0], y: ordered[i - k][1], glyph: "·", style });
    out.push({ x: ordered[i][0], y: ordered[i][1], glyph: down ? "●" : "◆", style });
  }
  return out;
}

/** A grid of characters with a style per cell, flattened to ANSI lines. */
function canvas(cols, rows) {
  const ch = Array.from({ length: rows }, () => Array(cols).fill(" "));
  const st = Array.from({ length: rows }, () => Array(cols).fill(""));
  return {
    put(x, y, text, style = "") {
      if (y < 0 || y >= rows) return;
      [...text].forEach((c, i) => {
        if (x + i >= 0 && x + i < cols) {
          ch[y][x + i] = c;
          st[y][x + i] = style;
        }
      });
    },
    lines() {
      return ch.map((row, y) => {
        let out = "";
        let cur = "";
        row.forEach((c, x) => {
          const s = st[y][x];
          if (s !== cur) {
            out += (cur ? RESET : "") + s;
            cur = s;
          }
          out += c;
        });
        return (out + (cur ? RESET : "")).replace(/\s+$/, "");
      });
    },
  };
}

const fit = (t, n) => (t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t + " ".repeat(n - t.length));

/** Render the graph for a `cols` x `rows` tab (same options as the strip). */
export function renderGraph(full, { cols, rows, now = Date.now(), selected, cursor, follow = false }) {
  if (!full?.root) return [`${DIM} waiting for the orchestrator…${RESET}`];
  const snap = cursor != null ? snapshotAt(full, cursor) : full;
  const at = cursor ?? now;
  const root = buildTree(snap);
  if (!root) return [`${DIM} waiting for the orchestrator…${RESET}`];

  const busy = (s) => s.running || s.blocked;
  // Collapsed "+N more" boxes count for whatever they hide.
  const busyBelow = (n) => n.children.some((c) => (c.session && busy(c.session)) || c.more?.some(busy) || busyBelow(c));
  const look = (n) => {
    if (n.more) {
      const blocked = n.more.filter((s) => s.blocked).length;
      const active = n.more.filter((s) => s.running).length;
      if (blocked) return { icon: "▲", color: RED, status: `${blocked} need input` };
      if (active) return { icon: "●", color: GREEN, status: `${active} active` };
      return { icon: "…", color: GREY, status: "all idle" };
    }
    const s = n.session;
    if (s.blocked) return { icon: "▲", color: RED, status: "needs input" };
    if (s.running) return { icon: "●", color: GREEN, status: "active" };
    if (busyBelow(n)) return { icon: "◌", color: YELLOW, status: "waiting" };
    return { icon: "○", color: GREY, status: "idle" };
  };
  const name = (s) => (s.id === snap.root ? `orchestrator${s.title ? ` · ${s.title}` : ""}` : s.title ?? `subagent ${s.id.slice(-6)}`);

  const top = 2; // header and a blank line
  const { nodes, width, height } = layoutTree(root, { cols: cols - 2 });
  const left = Math.max(1, Math.floor((cols - width) / 2));
  const c = canvas(cols, Math.max(rows, top + height + 2));

  // Connectors first, boxes on top.
  for (const n of nodes) {
    if (!n.children.length) continue;
    const yb = top + n.y + BOX_H - 1; // parent's bottom border row
    const px = left + n.cx;
    const centres = n.children.map((k) => left + k.cx);
    const lo = Math.min(...centres, px);
    const hi = Math.max(...centres, px);
    const hot = n.children.some((k) => (k.session && busy(k.session)) || k.more?.some(busy) || busyBelow(k));
    const edge = hot ? GREEN : GREY;
    c.put(px, yb + 1, "│", edge);
    for (let x = lo; x <= hi; x++) {
      const isChild = centres.includes(x);
      const up = x === px;
      const l = x > lo;
      const r = x < hi;
      const glyph =
        lo === hi ? "│"
        : up && isChild ? (l && r ? "┼" : l ? "┤" : "├")
        : up ? "┴"
        : isChild ? (l && r ? "┬" : l ? "┐" : "┌")
        : "─";
      c.put(x, yb + 2, glyph, edge);
    }
    for (const k of n.children) {
      const kHot = (k.session && (busy(k.session) || busyBelow(k))) || k.more?.some(busy);
      c.put(left + k.cx, yb + 3, "│", kHot ? GREEN : GREY);
    }
  }

  for (const n of nodes) {
    const x = left + n.x;
    const y = top + n.y;
    const w = n.w;
    const { icon, color, status } = look(n);
    const sel = n.session && n.session.id === selected;
    const border = sel ? `${BOLD}${color}` : color;
    const inner = w - 2;
    let lines;
    if (n.more) {
      lines = [`${icon} +${n.more.length} more`, status, n.more.slice(0, 2).map((s) => s.title ?? "subagent").join(", ")];
    } else {
      const s = n.session;
      const ms = s.activeMs + (s.running && s.runStart != null ? at - s.runStart : 0);
      lines = [
        `${icon} ${name(s)}`,
        `${status} · ${formatDuration(ms)}`,
        `${formatTokens(s.tokensIn)}/${formatTokens(s.tokensOut)}${s.toolCount ? ` · ⚒ ${s.toolCount}` : ""}`,
      ];
    }
    const topBorder = `┌${"─".repeat(inner)}┐`.split("");
    const bottomBorder = `└${"─".repeat(inner)}┘`.split("");
    if (n !== root) topBorder[n.cx - n.x] = "┴";
    if (n.children.length) bottomBorder[n.cx - n.x] = "┬";
    c.put(x, y, topBorder.join(""), border);
    lines.forEach((t, i) => {
      c.put(x, y + 1 + i, "│", border);
      c.put(x + 1, y + 1 + i, fit(` ${t}`, inner), sel ? REVERSE : i === 0 ? "" : DIM);
      c.put(x + w - 1, y + 1 + i, "│", border);
    });
    c.put(x, y + BOX_H - 1, bottomBorder.join(""), border);
  }

  // Messages in flight, drawn over the connectors.
  const byId = new Map(nodes.filter((n) => n.session).map((n) => [n.session.id, n]));
  for (const g of messageGlyphs(full.messages, byId, at, { top, left })) c.put(g.x, g.y, g.glyph, g.style);

  const span = (() => {
    const runs = full.sessions.flatMap((s) => s.runs ?? []);
    if (!runs.length) return undefined;
    const t0 = Math.min(...runs.map(([a]) => a));
    return [t0, full.sessions.some((s) => s.running) ? now : Math.max(...runs.map(([, b]) => b ?? now))];
  })();
  const mode = cursor != null && span ? `replay · ${formatDuration(cursor - span[0])} of ${formatDuration(span[1] - span[0])}` : "live";
  const lines = c.lines();
  lines[0] = `${BOLD} agent graph${RESET}${DIM} · ${mode}${follow ? " · follow" : ""}${RESET}`;
  const out = lines.slice(0, Math.max(1, rows - 1));
  while (out.length < rows - 1) out.push("");
  out.push(`${DIM} ${GRAPH_HINT}${RESET}`);
  return out.slice(0, rows);
}

function main() {
  const { state: file, owner } = launchArgs();
  if (owner) watchOwner(owner);
  runInteractive({ file, render: renderGraph, intervalMs: 100 }); // fast enough for message animations
}

if (import.meta.main) main();
