// Summary strip: a live tree of the orchestrator and its subagents with an
// active/idle indicator, total active time and tokens in/out per agent.
//
// The store runs in the parent TUI (fed with session events) and writes JSON;
// the same file run as a script renders that JSON in the summary pane:
//   BUN_BE_BUN=1 opencode summary.js --state <file>
import fs from "node:fs";

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
 * @param {() => number} [opts.now]
 * @param {number} [opts.throttleMs]
 * @param {{ setTimeout: Function, clearTimeout: Function }} [opts.timers]
 */
export function createSummaryStore({ write, inTree, parentOf, root, now = Date.now, throttleMs = 250, timers = globalThis }) {
  let sessions = new Map(); // id -> stats
  let currentRoot;
  let pending;
  let seq = 0;

  function stats(id) {
    let s = sessions.get(id);
    if (!s) {
      s = { id, title: null, order: seq++, running: false, runStart: null, activeMs: 0, blockers: new Set(), tokensIn: 0, tokensOut: 0 };
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
        title: s.title,
        order: s.order,
        running: s.running,
        runStart: s.runStart,
        activeMs: s.activeMs,
        blocked: s.blockers.size > 0,
        tokensIn: s.tokensIn,
        tokensOut: s.tokensOut,
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
        }
        return touch(true);
      }
      if (STOP_EVENTS.has(type)) {
        if (s.running) s.activeMs += now() - s.runStart;
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
const padStart = (s, n) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

/** Render the summary to lines (with ANSI styling) for a `cols` x `rows` pane. */
export function renderSummary(snap, { cols, rows, now = Date.now() }) {
  if (!snap?.root) return [`${DIM} waiting for the orchestrator…${RESET}`];
  const tree = treeRows(snap);
  const active = (s) => s.activeMs + (s.running && s.runStart != null ? now - s.runStart : 0);
  const name = (s) => (s.id === snap.root ? `orchestrator${s.title ? ` · ${s.title}` : ""}` : s.title ?? `subagent ${s.id.slice(-6)}`);

  const STATUS_W = 12, TIME_W = 8, TOK_W = 18;
  const nameW = Math.max(16, Math.min(60, cols - (STATUS_W + TIME_W + TOK_W + 6)));
  const line = (n, st, t, tok) => ` ${pad(n, nameW)} ${pad(st, STATUS_W)}${padStart(t, TIME_W)}  ${padStart(tok, TOK_W)}`;

  // An agent that isn't running but has a running descendant is waiting on it.
  const kids = new Map();
  for (const { session: s } of tree) {
    if (s.id === snap.root) continue;
    const p = snap.sessions.some((x) => x.id === s.parentID) ? s.parentID : snap.root;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(s);
  }
  const busyBelow = (id) => (kids.get(id) ?? []).some((k) => k.running || k.blocked || busyBelow(k.id));

  const out = [`${BOLD}${line("agent", "status", "active", "tokens in / out")}${RESET}`];
  let totalMs = 0, totalIn = 0, totalOut = 0;
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
    const text = line(`${prefix}${icon} ${name(s)}`, status, formatDuration(ms), `${formatTokens(s.tokensIn)} / ${formatTokens(s.tokensOut)}`);
    // Colour the indicator and status, keep the tree lines plain.
    const iconAt = 1 + prefix.length;
    out.push(text.slice(0, iconAt) + color + icon + RESET + text.slice(iconAt + 1).replace(status, `${color}${status}${RESET}`));
  }
  if (tree.length > 1) {
    out.push(`${DIM}${line("total", "", formatDuration(totalMs), `${formatTokens(totalIn)} / ${formatTokens(totalOut)}`)}${RESET}`);
  }
  return out.slice(0, rows);
}

// ----- interactive process ---------------------------------------------------

function main() {
  const i = process.argv.indexOf("--state");
  const file = i >= 0 ? process.argv[i + 1] : undefined;
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
