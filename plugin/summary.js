// Summary strip: a live tree of the orchestrator and its subagents with an
// active/idle indicator, total active time, tokens in/out, model and cost per
// agent, and a timeline of when each agent was working.
//
// The store runs in the parent TUI (fed with session events) and writes JSON;
// the same file run as a script renders that JSON in the summary pane:
//   BUN_BE_BUN=1 opencode summary.js --state <file> [--owner <TUI pid>]
import fs from "node:fs";
import { watchOwner } from "./watchdog.js";

/** Runs kept per agent for the timeline (oldest dropped first). */
const MAX_RUNS = 200;

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
  let currentRoot;
  let pending;
  let seq = 0;

  function stats(id) {
    let s = sessions.get(id);
    if (!s) {
      s = { id, title: null, order: seq++, running: false, runStart: null, activeMs: 0, blockers: new Set(), tokensIn: 0, tokensOut: 0, model: null, cost: 0, runs: [] };
      sessions.set(id, s);
    }
    return s;
  }

  function snapshot() {
    const r = root();
    return {
      root: r,
      at: now(),
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

  function syncRoot() {
    const r = root();
    if (r === currentRoot) return;
    currentRoot = r;
    sessions = new Map();
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
        s.running = false;
        s.runStart = null;
        return touch(true);
      }
      if (type === "session.step.ended" && data.tokens) {
        const t = data.tokens;
        s.tokensIn += (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
        s.tokensOut += (t.output ?? 0) + (t.reasoning ?? 0);
        return touch();
      }
      if (type === "permission.asked") s.blockers.add(`p:${data.id}`);
      else if (type === "permission.replied") s.blockers.delete(`p:${data.requestID}`);
      else if (type === "form.created") s.blockers.add(`f:${data.form?.id}`);
      else if (type === "form.replied" || type === "form.cancelled") s.blockers.delete(`f:${data.id}`);
      else return;
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

/** Render the summary to lines (with ANSI styling) for a `cols` x `rows` pane. */
export function renderSummary(snap, { cols, rows, now = Date.now() }) {
  if (!snap?.root) return [`${DIM} waiting for the orchestrator…${RESET}`];
  const tree = treeRows(snap);
  const active = (s) => s.activeMs + (s.running && s.runStart != null ? now - s.runStart : 0);
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

  // Columns: name, status, active, tokens, then model and cost when there is
  // anything to show, and a timeline in whatever width is left.
  const sessions = tree.map((r) => r.session);
  const STATUS_W = 11, TIME_W = 7, TOK_W = 16, COST_W = 8;
  const models = sessions.map((s) => s.model ?? "");
  let modelW = Math.min(18, Math.max(0, ...models.map((m) => m.length)));
  if (modelW) modelW = Math.max(modelW, 5);
  const costW = sessions.some((s) => s.cost > 0) ? COST_W : 0;
  const natural = Math.max(...tree.map(({ session: s, prefix }) => prefix.length + 2 + name(s).length));
  let nameW = Math.max(16, Math.min(44, natural));
  const fixed = () => 1 + nameW + 1 + STATUS_W + TIME_W + 2 + TOK_W + (modelW ? 2 + modelW : 0) + (costW ? 2 + costW : 0);
  if (fixed() > cols) modelW = 0; // narrow: drop the model column first
  while (fixed() > cols && nameW > 16) nameW -= 1;
  const rest = cols - fixed() - 2;
  const timelineW = rest >= 12 ? rest : 0;

  const runsOf = (s) => s.runs ?? (s.runStart != null ? [[s.runStart, s.running ? null : s.runStart]] : []);
  const allRuns = sessions.flatMap(runsOf);
  const t0 = allRuns.length ? Math.min(...allRuns.map(([a]) => a)) : now;
  const anyRunning = sessions.some((s) => s.running);
  const t1 = anyRunning || !allRuns.length ? now : Math.max(...allRuns.map(([, b]) => b ?? now));

  const line = (n, st, t, tok, model, cost, timeline) =>
    ` ${pad(n, nameW)} ${pad(st, STATUS_W)}${padStart(t, TIME_W)}  ${padStart(tok, TOK_W)}` +
    (modelW ? `  ${pad(model, modelW)}` : "") +
    (costW ? `  ${padStart(cost, costW)}` : "") +
    (timelineW && timeline ? `  ${timeline}` : "");

  const span = formatDuration(t1 - t0);
  const timelineHead = timelineW ? pad(`timeline${allRuns.length ? ` · ${span}` : ""}`, timelineW) : "";
  const out = [`${BOLD}${line("agent", "status", "active", "tokens in / out", "model", "cost", timelineHead).trimEnd()}${RESET}`];
  let totalMs = 0, totalIn = 0, totalOut = 0, totalCost = 0;
  for (const { session: s, prefix } of tree) {
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
    const bar = timelineW ? timelineBar(runsOf(s), t0, t1, timelineW, now) : "";
    const text = line(`${prefix}${icon} ${name(s)}`, status, formatDuration(ms), `${formatTokens(s.tokensIn)} / ${formatTokens(s.tokensOut)}`, s.model ?? "", formatCost(s.cost), bar);
    // Colour the indicator, status and active timeline slots; keep the tree lines plain.
    const iconAt = 1 + prefix.length;
    let styled = text.slice(0, iconAt) + color + icon + RESET + text.slice(iconAt + 1).replace(status, `${color}${status}${RESET}`);
    if (bar) styled = styled.slice(0, styled.length - bar.length) + bar.replace(/█+/g, (m) => `${GREEN}${m}${RESET}`);
    out.push(styled);
  }
  if (tree.length > 1) {
    out.push(`${DIM}${line("total", "", formatDuration(totalMs), `${formatTokens(totalIn)} / ${formatTokens(totalOut)}`, "", formatCost(totalCost), "").trimEnd()}${RESET}`);
  }
  return out.slice(0, rows);
}

// ----- interactive process ---------------------------------------------------

function main() {
  const i = process.argv.indexOf("--state");
  const file = i >= 0 ? process.argv[i + 1] : undefined;
  const o = process.argv.indexOf("--owner");
  if (o >= 0) watchOwner(process.argv[o + 1]);
  const { stdout } = process;
  let last = "";
  const draw = (force = false) => {
    let snap;
    try {
      snap = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
    const frame = renderSummary(snap, { cols: stdout.columns || 100, rows: stdout.rows || 10 }).join("\r\n");
    if (!force && frame === last) return;
    last = frame;
    stdout.write(`${ESC}H${ESC}2J${frame}`);
  };
  stdout.write(`${ESC}?25l`);
  process.on("exit", () => stdout.write(`${ESC}?25h`));
  process.on("SIGINT", () => process.exit(0));
  stdout.on("resize", () => draw(true));
  draw(true);
  setInterval(draw, 500); // state updates + ticking active time
}

if (import.meta.main) main();
