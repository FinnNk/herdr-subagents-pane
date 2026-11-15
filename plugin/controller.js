// Pure state machine: decides when subagent viewer panes open, close and how
// they are labelled. All side effects go through the injected `panes` adapter
// and `timers`, so this file has no dependency on opencode or herdr.
//
// Rules:
// - A pane opens once a descendant of the TUI's root session has been working
//   for `openDelayMs` (or has a working subagent of its own), so short-lived
//   subagents never get one. Asking for input opens it at once. Subagents the
//   `exclude` callback rejects get no pane unless they ask for input.
// - Close countdowns start only when the whole tree is quiet: nothing under the
//   TUI's root session (root included) is running or waiting for input, for at
//   least `settleMs`. Orchestrators end their turn after launching background
//   subagents and are woken by their results, so "parent idle" alone is not a
//   reliable "done" signal (e.g. a driver/navigator loop relayed via the parent).
// - Any activity anywhere in the tree cancels pending closes.
// - At the pane cap, the oldest idle viewer is closed to make room, or with
//   `overflow: "tab"` new viewers go to an overflow tab (a two-row grid) until
//   that is full too.
// - After panes open or close, `panes.rebalance` evens out widths and heights.
// - Layout: the orchestrator keeps the left third; each task gets a column.
//   Subagents titled "<Role>: <Task>" with the same task share a column
//   (e.g. "Driver: implementation" and "Navigator: implementation" stack in
//   one column). A title without a colon gets a column of its own. herdr only
//   splits single panes, so when every column is stacked, the rightmost one is
//   collapsed to its top pane, split, and its other panes reopened below (cards
//   hold no state of their own, so reopening them is invisible).
// - Labels carry status: "· working (run 2)", "· waiting", "· needs input",
//   "· done, closing in 30s".

export const DEFAULT_CLOSE_DELAY_MS = 20_000;
export const DEFAULT_MAX_PANES = 4;
export const DEFAULT_SETTLE_MS = 3_000;
/** The controller opens panes immediately by default; the plugin passes the configured delay. */
export const DEFAULT_OPEN_DELAY_MS = 0;
/** Share of its pane the orchestrator keeps when the first column opens. */
export const ORCHESTRATOR_SHARE = 1 / 3;

/** Column key for a subagent: the task part of "<Role>: <Task>", else its own id. */
export function taskKey(title, id) {
  const m = typeof title === "string" ? title.match(/^[^:]+:\s*(.+)$/) : null;
  return m ? m[1].trim().toLowerCase() : `id:${id}`;
}

const STOP_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.interrupted",
  "session.execution.failed",
]);

/**
 * @param {object} opts
 * @param {{ open(childId: string, anchor: {paneId?: string, direction: "right"|"down", ratio?: number}, label: string): Promise<string|undefined>,
 *           exists(paneId: string): Promise<boolean>,
 *           close(paneId: string): Promise<void>,
 *           rename?(paneId: string, label: string): Promise<void> }} opts.panes
 * @param {{ open(): Promise<void>, close(): Promise<void> }} [opts.strip] summary strip: opened
 *        with the first subagent, closed once the tree has been quiet for closeDelayMs
 * @param {(id: string) => string|undefined} [opts.lookupParent] fallback parent lookup (e.g. opencode cache)
 * @param {(id: string) => boolean|undefined} [opts.lookupRunning] fallback "is this session running" (e.g. opencode cache)
 * @param {number} [opts.openDelayMs] how long a subagent must be working before its pane opens
 * @param {(info: {id: string, title?: string}) => boolean} [opts.exclude] true: no pane (unless it needs input)
 * @param {boolean} [opts.autoClose] close panes once the tree is quiet (false: keep them, labelled "done")
 * @param {number} [opts.closeDelayMs] debounce before closing an idle subagent's pane
 * @param {number} [opts.settleMs] how long the tree must stay quiet before countdowns start
 * @param {number} [opts.maxPanes] cap on simultaneously open viewer panes (in the main tab)
 * @param {"evict"|"tab"} [opts.overflow] at the cap: close the oldest idle viewer, or use an overflow tab
 * @param {number} [opts.overflowMaxPanes] cap on viewers in the overflow tab
 * @param {{ setTimeout: Function, clearTimeout: Function }} [opts.timers]
 * @param {(id: string, info: {title?: string, status: string, rounds: number}) => void} [opts.onStatus]
 *        called whenever a subagent's status may have changed (e.g. to update a card)
 * @param {(id: string) => boolean} [opts.isPinned] true while the user has a subagent's view
 *        expanded; its pane is never auto-closed, the countdown just restarts
 * @param {(msg: string, extra?: object) => void} [opts.log]
 */
export function createController({
  panes,
  strip,
  lookupParent = () => undefined,
  lookupRunning = () => undefined,
  onStatus = () => {},
  isPinned = () => false,
  autoClose = true,
  openDelayMs = DEFAULT_OPEN_DELAY_MS,
  exclude = () => false,
  closeDelayMs = DEFAULT_CLOSE_DELAY_MS,
  settleMs = DEFAULT_SETTLE_MS,
  maxPanes = DEFAULT_MAX_PANES,
  overflow = "evict",
  overflowMaxPanes = 6,
  timers = globalThis,
  log = () => {},
}) {
  const parents = new Map(); // sessionID -> parentID (from events; the cache lags behind)
  const running = new Map(); // sessionID -> boolean, for every session we saw execution events for
  const children = new Map(); // childID -> ChildState
  let root; // root session shown in this TUI
  let disposed = false;
  let queue = Promise.resolve();
  let openSeq = 0;
  let settleTimer; // pending "tree has been quiet for settleMs"
  let settled = false; // tree quiet and settle period elapsed
  let stripOpen = false;
  let stripTimer; // pending strip close

  /** Serialize all pane operations so splits/closes never race each other. */
  function enqueue(fn) {
    const next = queue.then(fn).catch((err) => log("pane operation failed", { err: String(err) }));
    queue = next;
    return next;
  }

  function parentOf(id) {
    return parents.get(id) ?? lookupParent(id);
  }

  function rootOf(id) {
    const seen = new Set();
    while (typeof id === "string" && !seen.has(id)) {
      seen.add(id);
      const parent = parentOf(id);
      if (!parent) return id;
      id = parent;
    }
    return undefined;
  }

  function isRunning(id) {
    if (!id) return false;
    return running.has(id) ? running.get(id) : !!lookupRunning(id);
  }

  /** A descendant (child, grandchild, …) of the session this TUI shows. */
  function isOurSubagent(id) {
    return !!root && typeof id === "string" && id !== root && rootOf(id) === root;
  }

  function child(id) {
    let c = children.get(id);
    if (!c) {
      c = {
        id,
        title: undefined,
        column: undefined, // task key the current pane was placed under
        area: undefined, // "main" or "overflow" (tab the current pane is in)
        row: undefined, // overflow grid row (0 or 1)
        paneId: undefined,
        openedSeq: 0, // order in which the current pane was opened (stacking)
        rounds: 0, // number of times the subagent started work
        blockers: new Set(),
        closeTimer: undefined,
        openTimer: undefined, // pending delayed open
        shownLabel: undefined,
      };
      children.set(id, c);
      openStrip();
    }
    return c;
  }

  // ----- state -------------------------------------------------------------

  function busy(c) {
    return isRunning(c.id) || c.blockers.size > 0;
  }

  /** Is any tracked descendant of `id` running or blocked? */
  function busyBelow(id) {
    for (const k of children.values()) {
      if (k.id === id) continue;
      let p = parentOf(k.id);
      const seen = new Set();
      while (p && !seen.has(p) && p !== root) {
        if (p === id) {
          if (busy(k)) return true;
          break;
        }
        seen.add(p);
        p = parentOf(p);
      }
    }
    return false;
  }

  /** Title shown for a subagent; repeated titles get "#2", "#3"… in creation order. */
  function displayTitle(c) {
    const base = c.title ?? `subagent ${c.id.slice(-6)}`;
    if (!c.title) return base;
    let n = 0;
    for (const k of children.values()) {
      if (k.title === c.title) n += 1;
      if (k === c) break;
    }
    return n > 1 ? `${base} #${n}` : base;
  }

  /** Nothing in the tree (root + all tracked descendants) is running or blocked. */
  function treeQuiet() {
    if (isRunning(root)) return false;
    for (const c of children.values()) if (busy(c)) return false;
    return true;
  }

  /** May this pane be closed? */
  function closable(c) {
    return !busy(c) && treeQuiet();
  }

  function status(c) {
    if (c.blockers.size > 0) return "needs input";
    if (c.rounds === 0 && !isRunning(c.id)) return "starting";
    if (isRunning(c.id)) return c.rounds > 1 ? `working (run ${c.rounds})` : "working";
    if (c.closeTimer !== undefined) return `done, closing in ${Math.round(closeDelayMs / 1000)}s`;
    if (!autoClose && settled && closable(c)) return "done";
    return "waiting";
  }

  function label(c) {
    return `${displayTitle(c)} · ${status(c)}`;
  }

  /** Push the current label to the pane if it changed. */
  function refreshLabel(c) {
    try {
      onStatus(c.id, { title: displayTitle(c), status: status(c), rounds: c.rounds });
    } catch (err) {
      log("onStatus failed", { err: String(err) });
    }
    if (!panes.rename) return;
    enqueue(async () => {
      if (!c.paneId) return;
      const next = label(c);
      if (next === c.shownLabel) return;
      c.shownLabel = next;
      await panes.rename(c.paneId, next);
    });
  }

  // ----- panes -------------------------------------------------------------

  function openPanes(area) {
    return [...children.values()].filter((c) => c.paneId && (!area || (c.area ?? "main") === area));
  }

  let rebalancePending = false;
  /** Even out sizes once the current pane operations are done. */
  function requestRebalance() {
    if (!panes.rebalance || rebalancePending) return;
    rebalancePending = true;
    enqueue(async () => {
      rebalancePending = false;
      if (disposed) return;
      await panes.rebalance(openPanes().map((c) => c.paneId));
    });
  }

  /** Open viewers grouped by column, columns ordered left to right (by first open). */
  function columns(except) {
    const byKey = new Map();
    for (const o of openPanes("main")) {
      if (o === except) continue;
      if (!byKey.has(o.column)) byKey.set(o.column, []);
      byKey.get(o.column).push(o);
    }
    const cols = [...byKey.entries()].map(([key, members]) => ({
      key,
      members: members.sort((a, b) => a.openedSeq - b.openedSeq),
    }));
    return cols.sort((a, b) => a.members[0].openedSeq - b.members[0].openedSeq);
  }

  /**
   * Where a new viewer goes: its task's column, else a new column on the right.
   * `restack` names a column whose lower panes must be closed first (and reopened
   * after) so the new column can be split off its top pane at full height.
   */
  function placement(c) {
    const key = taskKey(c.title, c.id);
    const cols = columns(c);
    const own = cols.find((col) => col.key === key);
    if (own) return { key, anchor: { paneId: own.members.at(-1).paneId, direction: "down" } };
    if (cols.length === 0) return { key, anchor: { direction: "right", ratio: ORCHESTRATOR_SHARE } };
    // herdr splits single panes, so a full-height column needs a single-pane column to split.
    const single = [...cols].reverse().find((col) => col.members.length === 1);
    const from = (single ?? cols.at(-1)).members[0];
    const anchor = { paneId: from.paneId, direction: "right", ratio: 0.5 };
    if (single) return { key, anchor };
    // Every column is stacked: temporarily collapse the rightmost one to its top
    // pane, unless one of its panes is expanded (closing it would kill the view).
    const lower = cols.at(-1).members.slice(1);
    if (lower.some((m) => isPinned(m.id))) return { key, anchor };
    return { key, anchor, restack: lower };
  }

  /**
   * Where a viewer goes in the overflow tab: a two-row grid, filling the row
   * with fewer panes. The first viewer becomes the new tab's own pane.
   */
  function overflowPlacement(c) {
    const key = "overflow";
    const ov = openPanes("overflow").filter((o) => o !== c).sort((a, b) => a.openedSeq - b.openedSeq);
    if (ov.length === 0) {
      c.row = 0;
      return { key, anchor: { area: "overflow" } };
    }
    const rows = [ov.filter((o) => o.row !== 1), ov.filter((o) => o.row === 1)];
    const lone = rows[0].length + rows[1].length === 1 ? ov[0] : undefined;
    if (lone) {
      // Second viewer: start the bottom row under the only one.
      lone.row = 0;
      c.row = 1;
      return { key, anchor: { area: "overflow", paneId: lone.paneId, direction: "down" } };
    }
    let r = rows[0].length <= rows[1].length ? 0 : 1;
    if (rows[r].length === 0) r = 1 - r; // an emptied row can't be split into; extend the other
    c.row = r;
    return { key, anchor: { area: "overflow", paneId: rows[r].at(-1).paneId, direction: "right", ratio: 0.5 } };
  }

  /** Oldest idle viewer whose parent is idle too, or failing that any idle viewer. */
  function evictionCandidate(except) {
    const idle = openPanes().filter((c) => c !== except && !busy(c));
    idle.sort((a, b) => Number(closable(b)) - Number(closable(a)) || a.openedSeq - b.openedSeq);
    return idle[0];
  }

  async function closePane(c, why) {
    cancelClose(c);
    if (!c.paneId) return;
    const paneId = c.paneId;
    c.paneId = undefined;
    c.shownLabel = undefined;
    await panes.close(paneId);
    log("closed viewer", { child: c.id, pane: paneId, why });
    requestRebalance();
  }

  /** Open (or reopen) the pane now. Excluded subagents only open when they need input. */
  function ensureOpen(c) {
    cancelClose(c);
    cancelOpen(c);
    enqueue(async () => {
      if (disposed || !children.has(c.id)) return;
      if (c.paneId && (await panes.exists(c.paneId))) return;
      c.paneId = undefined;
      if (c.blockers.size === 0 && isExcluded(c)) return;
      let area = "main";
      if (openPanes("main").length >= maxPanes) {
        if (overflow === "tab" && openPanes("overflow").length < overflowMaxPanes) area = "overflow";
        else {
          const victim = evictionCandidate(c);
          if (!victim) {
            log("max panes reached and all viewers busy; not opening", { child: c.id });
            return;
          }
          area = victim.area ?? "main";
          await closePane(victim, "evicted for a newer subagent");
        }
      }
      c.area = area;
      const { key, anchor, restack = [] } = area === "overflow" ? overflowPlacement(c) : placement(c);
      // Collapse the column to its top pane so the split below spans its full height.
      for (const m of restack) {
        const paneId = m.paneId;
        m.paneId = undefined;
        m.shownLabel = undefined;
        await panes.close(paneId);
      }
      c.column = key;
      c.shownLabel = label(c);
      c.paneId = await panes.open(c.id, anchor, c.shownLabel);
      c.openedSeq = ++openSeq;
      log("opened viewer", { child: c.id, pane: c.paneId, anchor });
      // Put the collapsed panes back under the column's top pane, in their order.
      let below = anchor.paneId;
      for (const m of restack) {
        m.shownLabel = label(m);
        m.paneId = below ? await panes.open(m.id, { paneId: below, direction: "down" }, m.shownLabel) : undefined;
        if (m.paneId) below = m.paneId;
        if (m.closeTimer !== undefined && !m.paneId) cancelClose(m);
      }
      if (restack.length) log("restacked column", { panes: restack.map((m) => m.paneId) });
      requestRebalance();
      // State may have moved on while the split was in flight.
      if (c.paneId && settled && closable(c)) scheduleClose(c);
    });
    refreshLabel(c);
  }

  function isExcluded(c) {
    try {
      return !!exclude({ id: c.id, title: c.title });
    } catch (err) {
      log("exclude failed", { err: String(err) });
      return false;
    }
  }

  /**
   * A subagent started work: open its pane once it has kept working for
   * openDelayMs. A pane that was open before (e.g. closed by the user) reopens
   * at once, as before.
   */
  function requestOpen(c) {
    cancelClose(c);
    if (c.paneId || openDelayMs <= 0) return ensureOpen(c);
    if (c.openTimer !== undefined) return;
    c.openTimer = timers.setTimeout(() => {
      c.openTimer = undefined;
      if (disposed || !children.has(c.id)) return;
      if (busy(c) || busyBelow(c.id)) ensureOpen(c);
      else log("not opening: finished within the open delay", { child: c.id });
    }, openDelayMs);
  }

  function cancelOpen(c) {
    if (c.openTimer !== undefined) {
      timers.clearTimeout(c.openTimer);
      c.openTimer = undefined;
    }
  }

  function cancelClose(c) {
    if (c.closeTimer !== undefined) {
      log("close cancelled", { child: c.id });
      timers.clearTimeout(c.closeTimer);
      c.closeTimer = undefined;
    }
  }

  /** Debounced close; any activity by the child or its parent cancels it. */
  function scheduleClose(c) {
    cancelClose(c);
    if (!autoClose) return refreshLabel(c); // panes stay open, labelled "done"
    // No pane yet: an open is in flight (it schedules the close when it lands)
    // or the cap stopped it (nothing to close).
    if (!c.paneId) return;
    log("close scheduled", { child: c.id, inMs: closeDelayMs });
    c.closeTimer = timers.setTimeout(() => {
      c.closeTimer = undefined;
      if (disposed || !closable(c)) return refreshLabel(c); // re-check at fire time
      if (isPinned(c.id)) {
        log("close postponed: view expanded", { child: c.id });
        return scheduleClose(c);
      }
      enqueue(() => closePane(c, "idle"));
    }, closeDelayMs);
    refreshLabel(c);
  }

  // ----- summary strip -------------------------------------------------------

  function openStrip() {
    cancelStripClose();
    if (!strip || stripOpen) return;
    stripOpen = true;
    enqueue(async () => {
      await strip.open();
      log("opened summary strip");
    });
  }

  function closeStrip(why) {
    cancelStripClose();
    if (!strip || !stripOpen) return;
    stripOpen = false;
    enqueue(async () => {
      await strip.close();
      log("closed summary strip", { why });
    });
  }

  function cancelStripClose() {
    if (stripTimer !== undefined) {
      timers.clearTimeout(stripTimer);
      stripTimer = undefined;
    }
  }

  /** Close the strip with the panes, once the tree has been quiet for closeDelayMs. */
  function scheduleStripClose() {
    if (!strip || !stripOpen || !autoClose || stripTimer !== undefined) return;
    stripTimer = timers.setTimeout(() => {
      stripTimer = undefined;
      if (disposed || !treeQuiet()) return;
      if (openPanes().some((c) => isPinned(c.id))) return scheduleStripClose(); // an expanded view keeps it
      closeStrip("idle");
    }, closeDelayMs);
  }

  function cancelSettle() {
    if (settleTimer !== undefined) {
      timers.clearTimeout(settleTimer);
      settleTimer = undefined;
    }
  }

  function settle() {
    settled = true;
    log("tree settled; starting close countdowns");
    for (const c of openPanes()) if (c.closeTimer === undefined && closable(c)) scheduleClose(c);
    scheduleStripClose();
  }

  /** Re-evaluate close countdowns and labels after any state change in the tree. */
  function reevaluate() {
    if (treeQuiet()) {
      if (!settled && settleTimer === undefined) {
        if (settleMs <= 0) settle();
        else {
          settleTimer = timers.setTimeout(() => {
            settleTimer = undefined;
            if (!disposed && treeQuiet()) settle();
          }, settleMs);
        }
      }
    } else {
      cancelSettle();
      settled = false;
      cancelStripClose();
      for (const c of children.values()) cancelClose(c);
    }
    for (const c of children.values()) refreshLabel(c);
  }

  function closeAll(why) {
    cancelSettle();
    settled = false;
    for (const c of children.values()) {
      cancelClose(c);
      cancelOpen(c);
      enqueue(() => closePane(c, why));
    }
    children.clear();
    closeStrip(why);
  }

  // ----- public API --------------------------------------------------------

  return {
    /** Set the session shown in this TUI (any session in the tree; resolved to its root). */
    setRoute(sessionID) {
      if (disposed) return;
      const next = sessionID ? rootOf(sessionID) : undefined;
      if (next === root) return;
      log("root changed", { from: root, to: next });
      closeAll("root changed");
      root = next;
      reevaluate();
    },

    /** Feed an opencode v2 event ({ type, data }). */
    handle(type, data) {
      if (disposed || !data) return;

      if (type === "session.created") {
        if (data.parentID) parents.set(data.sessionID, data.parentID);
        if (isOurSubagent(data.sessionID)) {
          const c = child(data.sessionID);
          if (data.title) c.title = data.title;
          requestOpen(c);
          reevaluate();
        }
        return;
      }

      if (type === "session.deleted") {
        const c = children.get(data.sessionID);
        parents.delete(data.sessionID);
        running.delete(data.sessionID);
        if (c) {
          cancelOpen(c);
          children.delete(c.id);
          enqueue(() => closePane(c, "deleted"));
          reevaluate();
        }
        return;
      }

      if (type === "session.renamed") {
        const c = children.get(data.sessionID);
        if (c && data.title) {
          c.title = data.title;
          refreshLabel(c);
        }
        return;
      }

      const sessionID = type === "form.created" ? data.form?.sessionID : data.sessionID;

      // Track run state for every session: parents matter for closing children.
      const isExecution = type === "session.execution.started" || STOP_EVENTS.has(type);
      if (isExecution) running.set(sessionID, type === "session.execution.started");
      if (isExecution && sessionID === root) return reevaluate();

      if (!isOurSubagent(sessionID)) return;
      const c = child(sessionID);

      if (type === "session.execution.started") {
        c.rounds += 1;
        requestOpen(c);
        // A parent's own pane may be waiting on a delay that a busy child now satisfies.
        for (let p = parentOf(c.id); p && p !== root; p = parentOf(p)) {
          const pc = children.get(p);
          if (!pc || pc.paneId || pc.openTimer !== undefined) continue;
          if (!isRunning(p)) requestOpen(pc);
        }
      } else if (type === "permission.asked") {
        c.blockers.add(`permission:${data.id}`);
        ensureOpen(c);
      } else if (type === "permission.replied") {
        c.blockers.delete(`permission:${data.requestID}`);
      } else if (type === "form.created") {
        c.blockers.add(`form:${data.form?.id}`);
        ensureOpen(c);
      } else if (type === "form.replied" || type === "form.cancelled") {
        c.blockers.delete(`form:${data.id}`);
      } else if (!STOP_EVENTS.has(type)) {
        return;
      }
      reevaluate();
    },

    /** Close every viewer this controller opened and stop reacting to events. */
    async dispose() {
      if (disposed) return;
      disposed = true;
      cancelSettle();
      cancelStripClose();
      // opencode may exit soon after: close everything at once, not one by one.
      const all = [...children.values()];
      children.clear();
      for (const c of all) {
        cancelClose(c);
        cancelOpen(c);
      }
      const closes = all.filter((c) => c.paneId).map((c) => panes.close(c.paneId).catch(() => {}));
      if (strip && stripOpen) {
        stripOpen = false;
        closes.push(strip.close().catch(() => {}));
      }
      for (const c of all) c.paneId = undefined;
      await Promise.all(closes);
      await queue;
    },

    /** Resolves when all queued pane operations have finished (for tests). */
    async idle() {
      let last;
      while (last !== queue) {
        last = queue;
        await last;
      }
    },

    /** Parent session of `id` (from events, falling back to the lookup). */
    parentOf(id) {
      return parentOf(id);
    },

    /** Display title of a tracked subagent ("#2" for repeated titles), if known. */
    titleOf(id) {
      const c = children.get(id);
      return c ? displayTitle(c) : undefined;
    },

    /**
     * Track subagents that already existed when this TUI attached (e.g. after a
     * restart): [{ id, parentID, title, running }], in creation order. Running
     * ones open at once; idle ones are tracked without a pane.
     */
    adopt(sessions) {
      if (disposed || !root) return;
      for (const s of sessions) if (s.parentID) parents.set(s.id, s.parentID);
      for (const s of sessions) {
        if (!isOurSubagent(s.id) || children.has(s.id)) continue;
        const c = child(s.id);
        if (s.title) c.title = s.title;
        c.rounds = 1; // it has run before this TUI attached
        if (s.running) running.set(s.id, true);
      }
      for (const s of sessions) {
        const c = children.get(s.id);
        if (c && (busy(c) || busyBelow(c.id))) ensureOpen(c);
      }
      reevaluate();
    },

    /** Is this session one of the subagents this controller tracks? */
    isTracked(id) {
      return children.has(id);
    },

    get root() {
      return root;
    },
    snapshot() {
      return [...children.values()].map((c) => ({
        id: c.id,
        paneId: c.paneId,
        label: c.paneId ? label(c) : undefined,
        rounds: c.rounds,
        closing: c.closeTimer !== undefined,
      }));
    },
  };
}
