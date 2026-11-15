// Pure state machine: decides when subagent viewer panes open and close.
// All side effects go through the injected `panes` adapter and `timers`,
// so this file has no dependency on opencode or herdr and is unit-tested.

export const DEFAULT_CLOSE_DELAY_MS = 20_000;
export const DEFAULT_MAX_PANES = 4;

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
 * @param {number} [opts.closeDelayMs] debounce before closing an idle subagent's pane
 * @param {number} [opts.maxPanes] cap on simultaneously open viewer panes
 * @param {{ setTimeout: Function, clearTimeout: Function }} [opts.timers]
 * @param {(msg: string, extra?: object) => void} [opts.log]
 */
export function createController({
  panes,
  lookupParent = () => undefined,
  closeDelayMs = DEFAULT_CLOSE_DELAY_MS,
  maxPanes = DEFAULT_MAX_PANES,
  timers = globalThis,
  log = () => {},
}) {
  const parents = new Map(); // sessionID -> parentID (from events; the cache lags behind)
  const children = new Map(); // childID -> ChildState
  let root; // root session shown in this TUI
  let disposed = false;
  let queue = Promise.resolve();

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

  /** A descendant (child, grandchild, …) of the session this TUI shows. */
  function isOurSubagent(id) {
    return !!root && typeof id === "string" && id !== root && rootOf(id) === root;
  }

  function child(id, description) {
    let c = children.get(id);
    if (!c) {
      c = { id, paneId: undefined, running: false, blockers: new Set(), closeTimer: undefined, description };
      children.set(id, c);
    } else if (description && !c.description) {
      c.description = description;
    }
    return c;
  }

  function label(c) {
    return c.description ? `subagent: ${c.description}` : `subagent ${c.id.slice(-6)}`;
  }

  function cancelClose(c) {
    if (c.closeTimer !== undefined) {
      log("close cancelled", { child: c.id });
      timers.clearTimeout(c.closeTimer);
      c.closeTimer = undefined;
    }
  }

  function busy(c) {
    return c.running || c.blockers.size > 0;
  }

  function openCount() {
    let n = 0;
    for (const c of children.values()) if (c.paneId) n += 1;
    return n;
  }

  function lastOpenPane(except) {
    let last;
    for (const c of children.values()) if (c.paneId && c !== except) last = c.paneId;
    return last;
  }

  function ensureOpen(c) {
    cancelClose(c);
    return enqueue(async () => {
      if (disposed || !children.has(c.id)) return;
      if (c.paneId && (await panes.exists(c.paneId))) return;
      c.paneId = undefined;
      if (openCount() >= maxPanes) {
        log("max panes reached; not opening viewer", { child: c.id });
        return;
      }
      // First viewer goes to the right of the parent; later ones stack below the last viewer.
      const stackOn = lastOpenPane(c);
      const anchor = stackOn ? { paneId: stackOn, direction: "down" } : { direction: "right" };
      c.paneId = await panes.open(c.id, anchor, label(c));
      log("opened viewer", { child: c.id, pane: c.paneId, anchor });
      // State may have moved on while the split was in flight.
      if (c.paneId && !busy(c)) scheduleClose(c);
    });
  }

  function closeNow(c) {
    cancelClose(c);
    return enqueue(async () => {
      if (!c.paneId) return;
      const paneId = c.paneId;
      c.paneId = undefined;
      await panes.close(paneId);
      log("closed viewer", { child: c.id, pane: paneId });
    });
  }

  /** Debounced close: any new activity before the timer fires cancels it. */
  function scheduleClose(c) {
    cancelClose(c);
    // No pane yet: either an open is in flight (it schedules the close when it
    // lands) or the pane cap stopped it (nothing to close).
    if (!c.paneId) return;
    log("close scheduled", { child: c.id, inMs: closeDelayMs });
    c.closeTimer = timers.setTimeout(() => {
      c.closeTimer = undefined;
      if (disposed || busy(c)) return; // re-check at fire time
      closeNow(c);
    }, closeDelayMs);
  }

  function closeAll() {
    for (const c of children.values()) closeNow(c);
    children.clear();
  }

  return {
    /** Set the session shown in this TUI (any session in the tree; resolved to its root). */
    setRoute(sessionID) {
      if (disposed) return;
      const next = sessionID ? rootOf(sessionID) : undefined;
      if (next === root) return;
      log("root changed", { from: root, to: next });
      closeAll();
      root = next;
    },

    /** Feed an opencode v2 event ({ type, data }). */
    handle(type, data) {
      if (disposed || !data) return;
      if (type === "session.created") {
        if (data.parentID) parents.set(data.sessionID, data.parentID);
        if (isOurSubagent(data.sessionID)) ensureOpen(child(data.sessionID, data.title));
        return;
      }
      if (type === "session.deleted") {
        const c = children.get(data.sessionID);
        parents.delete(data.sessionID);
        if (c) {
          closeNow(c);
          children.delete(c.id);
        }
        return;
      }
      if (type === "session.renamed") {
        const c = children.get(data.sessionID);
        if (c && data.title) {
          c.description = data.title;
          if (c.paneId && panes.rename) enqueue(() => c.paneId && panes.rename(c.paneId, label(c)));
        }
        return;
      }

      const sessionID = type === "form.created" ? data.form?.sessionID : data.sessionID;
      if (!isOurSubagent(sessionID)) return;
      const c = child(sessionID);

      if (type === "session.execution.started") {
        c.running = true;
        ensureOpen(c);
      } else if (STOP_EVENTS.has(type)) {
        c.running = false;
        if (!busy(c)) scheduleClose(c);
      } else if (type === "permission.asked") {
        c.blockers.add(`permission:${data.id}`);
        ensureOpen(c);
      } else if (type === "permission.replied") {
        c.blockers.delete(`permission:${data.requestID}`);
        if (!busy(c)) scheduleClose(c);
      } else if (type === "form.created") {
        c.blockers.add(`form:${data.form?.id}`);
        ensureOpen(c);
      } else if (type === "form.replied" || type === "form.cancelled") {
        c.blockers.delete(`form:${data.id}`);
        if (!busy(c)) scheduleClose(c);
      }
    },

    /** Close every viewer this controller opened and stop reacting to events. */
    async dispose() {
      if (disposed) return;
      closeAll();
      disposed = true;
      await queue;
    },

    /** Resolves when all queued pane operations have finished (for tests). */
    idle() {
      return queue;
    },

    // Introspection for tests/debugging.
    get root() {
      return root;
    },
    snapshot() {
      return [...children.values()].map(({ id, paneId, running, blockers, closeTimer }) => ({
        id,
        paneId,
        running,
        blocked: blockers.size > 0,
        closing: closeTimer !== undefined,
      }));
    },
  };
}
