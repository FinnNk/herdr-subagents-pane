// Summary strip: a live tree of the orchestrator and its subagents with an
// active/idle indicator, total active time, tokens in/out, model and cost per
// agent, and a timeline of when each agent was working.
//
// The store runs in the parent TUI (fed with session events) and writes JSON;
// the same file run as a script renders that JSON in the summary pane:
//   BUN_BE_BUN=1 opencode summary.js --state <file> [--owner <TUI pid>]
// (the plugin passes the arguments in the pane environment instead; see launch.js)
import fs from "node:fs";
import path from "node:path";
import { watchOwner } from "./watchdog.js";
import { launchArgs } from "./launch.js";
import { writeCommand } from "./control.js";
import { describeIncoming, summarizeTool, toolChips } from "./cards.js";

export { toolChips };

/** History kept per agent for the timeline, detail view and replay (oldest dropped first). */
const MAX_RUNS = 200;
const MAX_TOOLS = 200;
const MAX_STEPS = 400;
const MAX_PROMPT = 400;
const MAX_MESSAGES = 100;

const pushCapped = (list, item, max) => {
  list.push(item);
  if (list.length > max) list.shift();
};

const STOP_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.interrupted",
  "session.execution.failed",
]);

// ----- store (parent TUI) ----------------------------------------------------

/**
 * @param {object} opts
 * @param {(snapshot: object) => void} opts.write
 * @param {(id: string) => boolean} opts.inTree   is this session the root or one of its descendants?
 * @param {(id: string) => string|undefined} opts.parentOf
 * @param {() => string|undefined} opts.root
 * @param {(id: string) => string|undefined} [opts.titleOf] display title override (e.g. "#2" for repeats)
 * @param {() => number} [opts.now]
 * @param {number} [opts.throttleMs]
 * @param {{ setTimeout: Function, clearTimeout: Function }} [opts.timers]
 */
export function createSummaryStore({ write, inTree, parentOf, root, titleOf = () => undefined, now = Date.now, throttleMs = 250, timers = globalThis }) {
  let sessions = new Map(); // id -> stats
  let messages = []; // { t, from, to, kind: "task" | "result" }, for the graph's animations
  let currentRoot;
  let pending;
  let seq = 0;

  function stats(id) {
    let s = sessions.get(id);
    if (!s) {
      s = {
        id, title: null, order: seq++, seenAt: now(), running: false, runStart: null, activeMs: 0,
        blockers: new Set(), blockStart: null, blocks: [], tokensIn: 0, tokensOut: 0, steps: [],
        model: null, cost: 0, runs: [], tools: [], toolCount: 0, prompt: null,
      };
      sessions.set(id, s);
    }
    return s;
  }

  function snapshot() {
    const r = root();
    return {
      root: r,
      at: now(),
      messages,
      sessions: [...sessions.values()].map((s) => ({
        id: s.id,
        parentID: s.id === r ? null : parentOf(s.id) ?? null,
        title: (s.id === r ? undefined : titleOf(s.id)) ?? s.title,
        order: s.order,
        running: s.running,
        runStart: s.runStart,
        activeMs: s.activeMs,
        blocked: s.blockers.size > 0,
        tokensIn: s.tokensIn,
        tokensOut: s.tokensOut,
        model: s.model,
        cost: s.cost,
        runs: s.runs.map((r) => [r.start, r.end]),
        seenAt: s.seenAt,
        blocks: [...s.blocks, ...(s.blockStart != null ? [[s.blockStart, null]] : [])],
        steps: s.steps,
        tools: s.tools,
        toolCount: s.toolCount,
        prompt: s.prompt,
      })),
    };
  }

  function flush() {
    pending = undefined;
    write(snapshot());
  }

  function touch(immediate = false) {
    if (immediate || throttleMs <= 0) {
      if (pending !== undefined) timers.clearTimeout(pending);
      flush();
    } else if (pending === undefined) {
      pending = timers.setTimeout(flush, throttleMs);
    }
  }

  // Tool calls: the name arrives with input.started, the input with called.
  const toolCalls = new Map(); // tool call id -> entry in some session's tools

  function blockersChanged(s, before) {
    if (before === 0 && s.blockers.size > 0) s.blockStart = now();
    else if (before > 0 && s.blockers.size === 0 && s.blockStart != null) {
      pushCapped(s.blocks, [s.blockStart, now()], MAX_RUNS);
      s.blockStart = null;
    }
  }

  function syncRoot() {
    const r = root();
    if (r === currentRoot) return;
    currentRoot = r;
    sessions = new Map();
    messages = [];
    seq = 0;
    if (r) stats(r);
  }

  return {
    /** Feed an opencode v2 event. */
    handle(type, data) {
      syncRoot();
      const id = type === "form.created" ? data?.form?.sessionID : data?.sessionID;
      if (!currentRoot || !id || !inTree(id)) return;
      const s = stats(id);
      if (type === "session.created" || type === "session.renamed") {
        if (data.title) s.title = data.title;
        return touch(true);
      }
      if (type === "session.execution.started") {
        if (!s.running) {
          s.running = true;
          s.runStart = now();
          s.runs.push({ start: s.runStart, end: null });
          if (s.runs.length > MAX_RUNS) s.runs.shift();
        }
        return touch(true);
      }
      if (STOP_EVENTS.has(type)) {
        if (s.running) s.activeMs += now() - s.runStart;
        const open = s.runs.at(-1);
        if (open && open.end === null) open.end = now();
        for (const t of s.tools) if (t.end == null) t.end = now(); // a run's end settles its calls
        s.running = false;
        s.runStart = null;
        return touch(true);
      }
      if (type === "session.step.ended" && data.tokens) {
        const t = data.tokens;
        const tin = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
        const tout = (t.output ?? 0) + (t.reasoning ?? 0);
        s.tokensIn += tin;
        s.tokensOut += tout;
        pushCapped(s.steps, [now(), tin, tout], MAX_STEPS);
        return touch();
      }
      if (type === "session.inbox.enqueued") {
        const text = data.item?.payload?.text;
        if (typeof text !== "string" || !text.trim()) return;
        const msg = describeIncoming(text);
        // A result from one of its subagents (<subagent description=…>), or a task from its parent.
        const isResult = /^<subagent\b/.test(text.replace(/^You are a subagent spawned by another session\.\s*/, "").trim());
        if (isResult) {
          const title = msg.from.replace(/ \([^)]*\)$/, ""); // "Driver: impl (completed)" -> "Driver: impl"
          const child = [...sessions.values()].find((x) => x.id !== id && x.title === title && parentOf(x.id) === id);
          if (child) pushCapped(messages, { t: now(), from: child.id, to: id, kind: "result" }, MAX_MESSAGES);
        } else {
          if (!s.prompt) s.prompt = msg.text.replace(/\s+/g, " ").slice(0, MAX_PROMPT);
          const from = id === currentRoot ? undefined : parentOf(id);
          if (from) pushCapped(messages, { t: now(), from, to: id, kind: "task" }, MAX_MESSAGES);
        }
        return touch(true);
      }
      if (type === "session.tool.input.started") {
        const entry = { id: data.id, name: data.name ?? "tool", summary: data.name ?? "tool", start: now(), end: null, ok: null };
        toolCalls.set(data.id, entry);
        pushCapped(s.tools, entry, MAX_TOOLS);
        s.toolCount += 1;
        return touch();
      }
      if (type === "session.tool.called") {
        const entry = toolCalls.get(data.id);
        if (entry) entry.summary = summarizeTool(entry.name, data.input);
        return touch();
      }
      if (type === "session.tool.success" || type === "session.tool.failed" || type === "session.tool.error") {
        const entry = toolCalls.get(data.id);
        if (entry && entry.end == null) {
          entry.end = now();
          entry.ok = type === "session.tool.success";
        }
        toolCalls.delete(data.id);
        return touch();
      }
      const before = s.blockers.size;
      if (type === "permission.asked") s.blockers.add(`p:${data.id}`);
      else if (type === "permission.replied") s.blockers.delete(`p:${data.requestID}`);
      else if (type === "form.created") s.blockers.add(`f:${data.form?.id}`);
      else if (type === "form.replied" || type === "form.cancelled") s.blockers.delete(`f:${data.id}`);
      else return;
      blockersChanged(s, before);
      touch(true);
    },

    /** Set a title for a session (e.g. from the controller or opencode cache). */
    title(id, title) {
      syncRoot();
      if (!currentRoot || !title || !inTree(id)) return;
      const s = stats(id);
      if (s.title === title) return;
      s.title = title;
      touch();
    },

    /** Model and cost for a session, from opencode's cache (cost is cumulative). */
    meta(id, { model, cost } = {}) {
      syncRoot();
      if (!currentRoot || !inTree(id)) return;
      const s = stats(id);
      let changed = false;
      if (typeof model === "string" && model && model !== s.model) {
        s.model = model;
        changed = true;
      }
      if (typeof cost === "number" && Number.isFinite(cost) && cost > s.cost) {
        s.cost = cost;
        changed = true;
      }
      if (changed) touch();
    },

    /**
     * Seed a session that existed before this TUI attached, from opencode's
     * cache: totals so far, and whether (and since when) it is running. Active
     * time before attaching isn't known, so it counts from the current run.
     */
    seed(id, { title, running = false, runStart, tokensIn = 0, tokensOut = 0 } = {}) {
      syncRoot();
      if (!currentRoot || !inTree(id)) return;
      const s = stats(id);
      if (title) s.title = title;
      if (running && !s.running) {
        s.running = true;
        s.runStart = runStart ?? now();
        s.runs.push({ start: s.runStart, end: null });
      }
      s.tokensIn = Math.max(s.tokensIn, tokensIn);
      s.tokensOut = Math.max(s.tokensOut, tokensOut);
      touch(true);
    },

    snapshot,

    dispose() {
      if (pending !== undefined) timers.clearTimeout(pending);
      pending = undefined;
    },
  };
}

// ----- rendering (summary pane) ---------------------------------------------

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const GREY = `${ESC}90m`;
const YELLOW = `${ESC}33m`;
const REVERSE = `${ESC}7m`;
const strip = (t) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

export function formatTokens(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatDuration(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** Depth-first rows: [{ session, prefix }], children in creation order. */
export function treeRows(snap) {
  const byParent = new Map();
  for (const s of snap.sessions) {
    if (s.id === snap.root) continue;
    const p = snap.sessions.some((x) => x.id === s.parentID) ? s.parentID : snap.root;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(s);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order);
  const rows = [];
  const rootSession = snap.sessions.find((s) => s.id === snap.root);
  if (!rootSession) return rows;
  rows.push({ session: rootSession, prefix: "" });
  const walk = (id, indent) => {
    const kids = byParent.get(id) ?? [];
    kids.forEach((k, i) => {
      const last = i === kids.length - 1;
      rows.push({ session: k, prefix: `${indent}${last ? "└─ " : "├─ "}` });
      walk(k.id, `${indent}${last ? "   " : "│  "}`);
    });
  };
  walk(rootSession.id, "");
  return rows;
}

const pad = (s, n) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const padStart = (s, n) => (s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s);

export function formatCost(c) {
  if (!c) return "";
  return c < 0.01 ? "<$0.01" : `$${c.toFixed(2)}`;
}

const overlap = (a, b, from, to) => Math.max(0, Math.min(b, to) - Math.max(a, from));

/**
 * The snapshot as it stood at time `t` (for replay): agents not yet seen are
 * left out, and running/blocked, active time, tokens and tool calls are
 * recomputed from the recorded history.
 */
export function snapshotAt(snap, t) {
  if (!snap?.root || t == null) return snap;
  const sessions = snap.sessions
    .filter((s) => s.id === snap.root || (s.seenAt ?? 0) <= t)
    .map((s) => {
      const runs = (s.runs ?? []).filter(([a]) => a <= t).map(([a, b]) => [a, b != null && b <= t ? b : null]);
      const open = runs.find(([, b]) => b == null);
      const steps = s.steps ?? [];
      const sum = (i, upTo) => steps.filter((x) => x[0] <= upTo).reduce((n, x) => n + x[i], 0);
      // Tokens recorded before the history (seeded, or dropped from the cap) count from the start.
      const baseIn = (s.tokensIn ?? 0) - sum(1, Infinity);
      const baseOut = (s.tokensOut ?? 0) - sum(2, Infinity);
      const tools = (s.tools ?? []).filter((x) => x.start <= t).map((x) => (x.end != null && x.end > t ? { ...x, end: null, ok: null } : x));
      return {
        ...s,
        runs,
        running: !!open,
        runStart: open ? open[0] : null,
        activeMs: runs.reduce((n, [a, b]) => n + (b != null ? b - a : 0), 0),
        blocked: (s.blocks ?? []).some(([a, b]) => a <= t && (b == null || b > t)),
        tokensIn: baseIn + sum(1, t),
        tokensOut: baseOut + sum(2, t),
        tools,
        toolCount: Math.max(0, (s.toolCount ?? 0) - (s.tools?.length ?? 0)) + tools.length,
      };
    });
  return { ...snap, at: t, sessions };
}

/** The subagent that most recently did something (for the strip's follow mode). */
export function mostRecentlyActive(snap) {
  let best, bestAt = -Infinity;
  for (const s of snap?.sessions ?? []) {
    if (s.id === snap.root) continue;
    const times = [
      ...(s.runs ?? []).flatMap(([a, b]) => [a, b ?? Infinity]),
      ...(s.tools ?? []).map((x) => x.end ?? x.start),
      ...(s.steps ?? []).map((x) => x[0]),
    ];
    const at = Math.max(-Infinity, ...times.filter((x) => x != null));
    if (at > bestAt) [best, bestAt] = [s.id, at];
  }
  return best;
}

/**
 * One timeline row: `width` slots spanning [t0, t1]; a slot is active ("█") if
 * any run overlaps it, idle ("·") once the agent has started, blank before.
 */
export function timelineBar(runs, t0, t1, width, now) {
  if (width <= 0) return "";
  const span = Math.max(1, t1 - t0);
  const first = runs.length ? Math.min(...runs.map(([a]) => a)) : Infinity;
  let out = "";
  for (let i = 0; i < width; i++) {
    const a = t0 + (span * i) / width;
    const b = t0 + (span * (i + 1)) / width;
    const active = runs.some(([start, end]) => start < b && (end ?? now) > a);
    out += active ? "█" : b > first ? "·" : " ";
  }
  return out;
}

/** Lines for the detail view of one agent, at most `rows` lines of `width`. */
export function detailLines(s, { width, rows, now, parentTitle }) {
  const fit = (t) => (t.length > width ? `${t.slice(0, Math.max(0, width - 1))}…` : t);
  const lines = [];
  const facts = [s.model, parentTitle && `from ${parentTitle}`].filter(Boolean).join(" · ");
  if (facts) lines.push(fit(facts));
  if (s.prompt) lines.push(fit(`prompt: ${s.prompt}`));
  const chips = toolChips(s.tools);
  lines.push(fit(chips ? `tools: ${chips}` : "tools: none yet"));
  const calls = s.tools ?? [];
  const room = Math.max(0, rows - lines.length);
  for (const c of calls.slice(-room)) {
    const mark = c.end == null ? "⚒" : c.ok === false ? "✗" : "✓";
    const took = formatDuration((c.end ?? now) - c.start);
    const label = `${mark} ${c.summary ?? c.name}`;
    const gap = Math.max(1, width - label.length - took.length);
    lines.push(label.length + 1 + took.length > width ? fit(`${label} ${took}`) : `${label}${" ".repeat(gap)}${took}`);
  }
  return lines.slice(0, rows);
}

export const STRIP_HINT = "↑↓ select · ⏎ expand · o open · f follow · ←→ replay · g graph";

/**
 * Render the summary to lines (with ANSI styling) for a `cols` x `rows` pane.
 * `selected`: session highlighted for the keyboard controls (and shown in the
 * detail view); `cursor`: replay time, or undefined for live; `follow`: the
 * selection tracks the most recently active agent (shown in the header).
 */
export function renderSummary(full, { cols, rows, now = Date.now(), selected, cursor, follow = false }) {
  if (!full?.root) return [`${DIM} waiting for the orchestrator…${RESET}`];
  const snap = cursor != null ? snapshotAt(full, cursor) : full;
  const at = cursor ?? now;
  const tree = treeRows(snap);
  const active = (s) => s.activeMs + (s.running && s.runStart != null ? at - s.runStart : 0);
  const name = (s) => (s.id === snap.root ? `orchestrator${s.title ? ` · ${s.title}` : ""}` : s.title ?? `subagent ${s.id.slice(-6)}`);

  // An agent that isn't running but has a running descendant is waiting on it.
  const kids = new Map();
  for (const { session: s } of tree) {
    if (s.id === snap.root) continue;
    const p = snap.sessions.some((x) => x.id === s.parentID) ? s.parentID : snap.root;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(s);
  }
  const busyBelow = (id) => (kids.get(id) ?? []).some((k) => k.running || k.blocked || busyBelow(k.id));

  // Columns: name, status, active, tokens, tools, then model and cost when there
  // is anything to show, and a timeline (or the detail view) in what's left.
  const sessions = tree.map((r) => r.session);
  const STATUS_W = 11, TIME_W = 7, TOK_W = 16, TOOLS_W = 5, COST_W = 8;
  const models = sessions.map((s) => s.model ?? "");
  let modelW = Math.min(18, Math.max(0, ...models.map((m) => m.length)));
  if (modelW) modelW = Math.max(modelW, 5);
  const costW = sessions.some((s) => s.cost > 0) ? COST_W : 0;
  const natural = Math.max(...tree.map(({ session: s, prefix }) => prefix.length + 2 + name(s).length));
  let nameW = Math.max(16, Math.min(44, natural));
  const fixed = () => 1 + nameW + 1 + STATUS_W + TIME_W + 2 + TOK_W + 2 + TOOLS_W + (modelW ? 2 + modelW : 0) + (costW ? 2 + costW : 0);
  if (fixed() > cols) modelW = 0; // narrow: drop the model column first
  while (fixed() > cols && nameW > 16) nameW -= 1;
  const rest = cols - fixed() - 2;
  const sideW = rest >= 12 ? rest : 0;

  // The timeline always spans the whole recorded run, so the replay cursor moves across it.
  const runsOf = (s) => s.runs ?? (s.runStart != null ? [[s.runStart, s.running ? null : s.runStart]] : []);
  const allRuns = full.sessions.flatMap(runsOf);
  const t0 = allRuns.length ? Math.min(...allRuns.map(([a]) => a)) : now;
  const anyRunning = full.sessions.some((s) => s.running);
  const t1 = anyRunning || !allRuns.length ? now : Math.max(...allRuns.map(([, b]) => b ?? now));
  const cursorSlot = cursor != null && sideW ? Math.min(sideW - 1, Math.max(0, Math.floor(((cursor - t0) / Math.max(1, t1 - t0)) * sideW))) : -1;

  // Detail view replaces the timeline while an agent is selected.
  const picked = selected ? sessions.find((s) => s.id === selected) : undefined;
  const parentOfPicked = picked && sessions.find((s) => s.id === picked.parentID);
  const detail = picked && sideW
    ? detailLines(picked, { width: sideW, rows: Math.max(1, Math.min(rows, tree.length + 2) - 1), now: at, parentTitle: parentOfPicked ? name(parentOfPicked) : undefined })
    : undefined;

  const line = (n, st, t, tok, tl, model, cost, side) =>
    ` ${pad(n, nameW)} ${pad(st, STATUS_W)}${padStart(t, TIME_W)}  ${padStart(tok, TOK_W)}  ${padStart(tl, TOOLS_W)}` +
    (modelW ? `  ${pad(model, modelW)}` : "") +
    (costW ? `  ${padStart(cost, costW)}` : "") +
    (sideW && side ? `  ${side}` : "");

  const span = formatDuration(t1 - t0);
  const mode = [cursor != null ? `replay · ${formatDuration(cursor - t0)} of ${span}` : allRuns.length ? `timeline · ${span}` : "timeline", follow ? "follow" : ""].filter(Boolean).join(" · ");
  const sideHead = sideW ? pad(detail ? `${name(picked)}${cursor != null ? ` · at ${formatDuration(cursor - t0)}` : ""}` : mode, sideW) : "";
  const out = [`${BOLD}${line("agent", "status", "active", "tokens in / out", "tools", "model", "cost", sideHead).trimEnd()}${RESET}`];
  let totalMs = 0, totalIn = 0, totalOut = 0, totalCost = 0, totalTools = 0;
  tree.forEach(({ session: s, prefix }, row) => {
    const [icon, color, status] = s.blocked
      ? ["▲", RED, "needs input"]
      : s.running
        ? ["●", GREEN, "active"]
        : busyBelow(s.id)
          ? ["◌", YELLOW, "waiting"]
          : ["○", GREY, "idle"];
    const ms = active(s);
    totalMs += ms;
    totalIn += s.tokensIn;
    totalOut += s.tokensOut;
    totalCost += s.cost ?? 0;
    totalTools += s.toolCount ?? 0;
    let side = "";
    if (detail) side = detail[row] ?? "";
    else if (sideW) {
      const fullRuns = runsOf(full.sessions.find((x) => x.id === s.id) ?? s);
      side = timelineBar(fullRuns, t0, t1, sideW, now);
    }
    const tl = s.toolCount ? `⚒ ${s.toolCount}` : "";
    let text = line(`${prefix}${icon} ${name(s)}`, status, formatDuration(ms), `${formatTokens(s.tokensIn)} / ${formatTokens(s.tokensOut)}`, tl, s.model ?? "", formatCost(s.cost), side);
    if (!side) text = text.trimEnd();
    // Colour the indicator, status and active timeline slots; keep the tree lines plain.
    const iconAt = 1 + prefix.length;
    let styled = text.slice(0, iconAt) + color + icon + RESET + text.slice(iconAt + 1).replace(status, `${color}${status}${RESET}`);
    if (!detail && side) {
      const barAt = styled.length - side.length;
      let bar = side.replace(/█+/g, (m) => `${GREEN}${m}${RESET}`);
      if (cursorSlot >= 0) bar = [...side].map((ch, i) => (i === cursorSlot ? `${REVERSE}${ch === " " ? "│" : ch}${RESET}` : ch === "█" ? `${GREEN}█${RESET}` : ch)).join("");
      styled = styled.slice(0, barAt) + bar;
    }
    if (s.id === selected) styled = `${REVERSE}${strip(styled)}${RESET}`; // plain reverse video for the selected row
    out.push(styled);
  });
  // Detail lines that didn't fit beside a tree row continue under the tree.
  const extra = detail ? detail.slice(tree.length) : [];
  if (tree.length > 1) {
    const hint = !extra.length && sideW >= STRIP_HINT.length ? STRIP_HINT : extra.shift() ?? "";
    out.push(`${DIM}${line("total", "", formatDuration(totalMs), `${formatTokens(totalIn)} / ${formatTokens(totalOut)}`, totalTools ? `⚒ ${totalTools}` : "", "", formatCost(totalCost), hint).trimEnd()}${RESET}`);
  }
  for (const e of extra) out.push(line("", "", "", "", "", "", "", e).trimEnd());
  return out.slice(0, rows);
}

/** Rows the strip's selection moves over: subagents, top to bottom (not the orchestrator). */
export function selectable(snap) {
  if (!snap?.root) return [];
  return treeRows(snap).map((r) => r.session.id).filter((id) => id !== snap.root);
}

/** Next selection for a key, or undefined to leave it. */
export function moveSelection(ids, current, key) {
  if (!ids.length) return undefined;
  const i = ids.indexOf(current);
  if (key === "down") return i < 0 ? ids[0] : ids[Math.min(ids.length - 1, i + 1)];
  if (key === "up") return i < 0 ? ids.at(-1) : ids[Math.max(0, i - 1)];
  return undefined;
}

/**
 * The interactive loop shared by the strip and the graph tab: reads the
 * summary state file, keeps selection / follow / replay state, handles keys,
 * and sends commands to the plugin through its runtime dir.
 * @param {object} opts
 * @param {string} opts.file summary state file
 * @param {(snap: object, view: {cols: number, rows: number, selected?: string, cursor?: number, follow: boolean}) => string[]} opts.render
 * @param {Record<string, string>} [opts.extraKeys] raw key -> command name sent without a selection (e.g. "g": "graph")
 */
export function runInteractive({ file, render, extraKeys = {}, intervalMs = 500 }) {
  const { stdout, stdin } = process;
  let last = "";
  let snap;
  let selected;
  let follow = false;
  let cursor; // replay time, or undefined for live
  const read = () => {
    try {
      snap = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
  };
  // Replay steps move the cursor about 1/60 of the run.
  const span = () => {
    const runs = (snap?.sessions ?? []).flatMap((s) => s.runs ?? []);
    if (!runs.length) return undefined;
    const t0 = Math.min(...runs.map(([a]) => a));
    const live = (snap.sessions ?? []).some((s) => s.running);
    const t1 = live ? Date.now() : Math.max(...runs.map(([, b]) => b ?? Date.now()));
    return [t0, t1];
  };
  const step = (dir) => {
    const sp = span();
    if (!sp) return;
    const [t0, t1] = sp;
    const delta = Math.max(250, (t1 - t0) / 60);
    const next = (cursor ?? t1) + dir * delta;
    cursor = next >= t1 ? undefined : Math.max(t0, next);
  };
  const draw = (force = false) => {
    read();
    const view = cursor != null ? snapshotAt(snap, cursor) : snap;
    if (follow) selected = mostRecentlyActive(view) ?? selected;
    if (selected && !selectable(view).includes(selected)) selected = undefined;
    const frame = render(snap, { cols: stdout.columns || 100, rows: stdout.rows || 10, selected, cursor, follow }).join("\r\n");
    if (!force && frame === last) return;
    last = frame;
    stdout.write(`${ESC}H${ESC}2J${frame}`);
  };
  const dir = file ? path.dirname(file) : undefined;
  const send = (cmd, withSelection = true) => {
    if (!dir || (withSelection && !selected)) return;
    try {
      writeCommand(dir, withSelection ? { cmd, session: selected } : { cmd });
    } catch {}
  };
  const KEYS = {
    "\x1b[A": "up", k: "up", "\x1b[B": "down", j: "down", "\r": "enter", "\n": "enter", o: "open", f: "follow",
    "\x1b[D": "back", "\x1b[C": "forward", "\x1b[H": "start", "\x1b[1~": "start", "\x1b[F": "live", "\x1b[4~": "live", "\x1b": "clear",
  };
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", (buf) => {
    const raw = buf.toString("utf8");
    if (extraKeys[raw]) return send(extraKeys[raw], false);
    const key = KEYS[raw];
    const view = cursor != null ? snapshotAt(snap, cursor) : snap;
    if (key === "up" || key === "down") {
      follow = false; // moving the selection by hand ends follow mode
      selected = moveSelection(selectable(view), selected, key) ?? selected;
    } else if (key === "follow") follow = !follow;
    else if (key === "back") step(-1);
    else if (key === "forward") step(1);
    else if (key === "start") cursor = span()?.[0];
    else if (key === "live") cursor = undefined;
    else if (key === "clear") {
      selected = undefined;
      follow = false;
    } else if (key === "enter") send("expand");
    else if (key === "open") send("open");
    // ctrl+c is ignored: the plugin owns this pane and closes it when done.
    draw(true);
  });
  stdout.write(`${ESC}?25l`);
  process.on("exit", () => stdout.write(`${ESC}?25h`));
  process.on("SIGINT", () => {});
  stdout.on("resize", () => draw(true));
  draw(true);
  setInterval(draw, intervalMs); // state updates, ticking active time, animations
}

function main() {
  const { state: file, owner } = launchArgs();
  if (owner) watchOwner(owner);
  runInteractive({ file, render: renderSummary, extraKeys: { g: "graph" } });
}

if (import.meta.main) main();
