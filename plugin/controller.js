// Pure state machine: decides when subagent viewer panes open, close and how
// they are labelled. All side effects go through the injected `panes` adapter
// and `timers`, so this file has no dependency on opencode or herdr.
//
// Rules:
// - A pane opens when a descendant of the TUI's root session is created or
//   starts work (or asks for input).
// - Close countdowns start only when the whole tree is quiet: nothing under the
//   TUI's root session (root included) is running or waiting for input, for at
//   least `settleMs`. Orchestrators end their turn after launching background
//   subagents and are woken by their results, so "parent idle" alone is not a
//   reliable "done" signal (e.g. a driver/navigator loop relayed via the parent).
// - Any activity anywhere in the tree cancels pending closes.
// - At the pane cap, the oldest idle viewer is closed to make room.
// - New viewers stack below the most recently opened one, so the column stays
//   in the order things happened.
// - Labels carry status: "· working (round 2)", "· waiting", "· needs input",
//   "· done, closing in 30s".

export const DEFAULT_CLOSE_DELAY_MS = 20_000;
export const DEFAULT_MAX_PANES = 4;
export const DEFAULT_SETTLE_MS = 3_000;

const STOP_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.interrupted",
  "session.execution.failed",
]);

/**
 * @param {object} opts
 * @param {{ open(childId: string, anchor: {paneId?: string, direction: "right"|"down"}, label: string): Promise<string|undefined>,
 *           exists(paneId: string): Promise<boolean>,
 *           close(paneId: string): Promise<void>,
 *           rename?(paneId: string, label: string): Promise<void> }} opts.panes
 * @param {(id: string) => string|undefined} [opts.lookupParent] fallback parent lookup (e.g. opencode cache)
 * @param {(id: string) => boolean|undefined} [opts.lookupRunning] fallback "is this session running" (e.g. opencode cache)
 * @param {number} [opts.closeDelayMs] debounce before closing an idle subagent's pane
 * @param {number} [opts.settleMs] how long the tree must stay quiet before countdowns start
 * @param {number} [opts.maxPanes] cap on simultaneously open viewer panes
 * @param {{ setTimeout: Function, clearTimeout: Function }} [opts.timers]
 * @param {(msg: string, extra?: object) => void} [opts.log]
 */
export function createController({
  panes,
  lookupParent = () => undefined,
  lookupRunning = () => undefined,
  closeDelayMs = DEFAULT_CLOSE_DELAY_MS,
  settleMs = DEFAULT_SETTLE_MS,
  maxPanes = DEFAULT_MAX_PANES,
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
        paneId: undefined,
        openedSeq: 0, // order in which the current pane was opened (stacking)
        rounds: 0, // number of times the subagent started work
        blockers: new Set(),
        closeTimer: undefined,
        shownLabel: undefined,
      };
      children.set(id, c);
    }
    return c;
  }

  // ----- state -------------------------------------------------------------

  function busy(c) {
    return isRunning(c.id) || c.blockers.size > 0;
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
    if (isRunning(c.id)) return c.rounds > 1 ? `working (round ${c.rounds})` : "working";
    if (c.closeTimer !== undefined) return `done, closing in ${Math.round(closeDelayMs / 1000)}s`;
    return "waiting";
  }

  function label(c) {
    return `${c.title ?? `subagent ${c.id.slice(-6)}`} · ${status(c)}`;
  }

  /** Push the current label to the pane if it changed. */
  function refreshLabel(c) {
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

  function openPanes() {
    return [...children.values()].filter((c) => c.paneId);
  }

  /** The most recently opened viewer: new viewers stack below it. */
  function bottomPane(except) {
    let best;
    for (const c of openPanes()) if (c !== except && (!best || c.openedSeq > best.openedSeq)) best = c;
    return best?.paneId;
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
  }

  function ensureOpen(c) {
    cancelClose(c);
    enqueue(async () => {
      if (disposed || !children.has(c.id)) return;
      if (c.paneId && (await panes.exists(c.paneId))) return;
      c.paneId = undefined;
      if (openPanes().length >= maxPanes) {
        const victim = evictionCandidate(c);
        if (!victim) {
          log("max panes reached and all viewers busy; not opening", { child: c.id });
          return;
        }
        await closePane(victim, "evicted for a newer subagent");
      }
      const stackOn = bottomPane(c);
      const anchor = stackOn ? { paneId: stackOn, direction: "down" } : { direction: "right" };
      c.shownLabel = label(c);
      c.paneId = await panes.open(c.id, anchor, c.shownLabel);
      c.openedSeq = ++openSeq;
      log("opened viewer", { child: c.id, pane: c.paneId, anchor });
      // State may have moved on while the split was in flight.
      if (c.paneId && settled && closable(c)) scheduleClose(c);
    });
    refreshLabel(c);
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
    // No pane yet: an open is in flight (it schedules the close when it lands)
    // or the cap stopped it (nothing to close).
    if (!c.paneId) return;
    log("close scheduled", { child: c.id, inMs: closeDelayMs });
    c.closeTimer = timers.setTimeout(() => {
      c.closeTimer = undefined;
      if (disposed || !closable(c)) return refreshLabel(c); // re-check at fire time
      enqueue(() => closePane(c, "idle"));
    }, closeDelayMs);
    refreshLabel(c);
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
      for (const c of children.values()) cancelClose(c);
    }
    for (const c of children.values()) refreshLabel(c);
  }

  function closeAll(why) {
    cancelSettle();
    settled = false;
    for (const c of children.values()) {
      cancelClose(c);
      enqueue(() => closePane(c, why));
    }
    children.clear();
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
          ensureOpen(c);
          reevaluate();
        }
        return;
      }

      if (type === "session.deleted") {
        const c = children.get(data.sessionID);
        parents.delete(data.sessionID);
        running.delete(data.sessionID);
        if (c) {
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
        ensureOpen(c);
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
      closeAll("dispose");
      cancelSettle();
      disposed = true;
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
