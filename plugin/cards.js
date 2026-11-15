// Card state for each subagent, built from opencode v2 events in the parent
// TUI and written out (via the injected `write`) for card.js to render.
// Pure apart from `write` and `timers`, so it is unit-tested.

const SUBAGENT_PREAMBLE = /^You are a subagent spawned by another session\.\s*/;
const MAX_TEXT = 2_000; // keep the tail of the latest assistant text
const MAX_INCOMING = 600;

const tail = (s, n) => (s.length > n ? `…${s.slice(-n)}` : s);
const head = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A short human summary of a tool call's input. */
export function summarizeTool(name, input) {
  if (!input || typeof input !== "object") return name ?? "tool";
  const pick = (...keys) => keys.map((k) => input[k]).find((v) => typeof v === "string" && v);
  const file = pick("filePath", "path", "file");
  const value =
    pick("command") ??
    (file ? file.split("/").pop() : undefined) ??
    pick("pattern", "query", "url", "description", "prompt");
  return value ? `${name ?? "tool"} ${head(value.replace(/\s+/g, " "), 80)}` : name ?? "tool";
}

/**
 * @param {object} opts
 * @param {(id: string, card: object) => void} opts.write persist one card
 * @param {() => number} [opts.now]
 * @param {number} [opts.throttleMs] coalesce streaming updates
 * @param {{ setTimeout: Function, clearTimeout: Function }} [opts.timers]
 */
export function createCardStore({ write, now = Date.now, throttleMs = 200, timers = globalThis }) {
  const cards = new Map();
  const pending = new Map();
  const toolNames = new Map(); // tool call id -> tool name

  function card(id) {
    let c = cards.get(id);
    if (!c) {
      c = {
        id,
        title: null,
        status: "starting",
        rounds: 0,
        startedAt: null, // start of the current round
        endedAt: null, // end of the current round (null while working)
        tool: null, // { name, summary, done }
        text: "", // latest assistant text (tail)
        incoming: null, // latest message the subagent received, e.g. "Driver says: …"
      };
      cards.set(id, c);
    }
    return c;
  }

  function flush(id) {
    pending.delete(id);
    const c = cards.get(id);
    if (c) write(id, { ...c, updatedAt: now() });
  }

  function touch(id, immediate = false) {
    if (immediate || throttleMs <= 0) {
      if (pending.has(id)) timers.clearTimeout(pending.get(id));
      flush(id);
    } else if (!pending.has(id)) {
      pending.set(id, timers.setTimeout(() => flush(id), throttleMs));
    }
  }

  return {
    /** Status/label info from the controller. */
    status(id, { title, status, rounds }) {
      const c = card(id);
      if (title) c.title = title;
      if (status) c.status = status;
      if (typeof rounds === "number") c.rounds = rounds;
      touch(id, true);
    },

    /** Feed an event that belongs to subagent `data.sessionID`. */
    handle(type, data) {
      const id = data?.sessionID;
      if (!id) return;
      const c = card(id);
      switch (type) {
        case "session.execution.started":
          c.startedAt = now();
          c.endedAt = null;
          c.tool = null;
          return touch(id, true);
        case "session.execution.succeeded":
        case "session.execution.interrupted":
        case "session.execution.failed":
          c.endedAt = now();
          if (c.tool) c.tool.done = true;
          return touch(id, true);
        case "session.inbox.enqueued": {
          const text = data.item?.payload?.text;
          if (typeof text === "string" && text.trim()) {
            c.incoming = head(text.replace(SUBAGENT_PREAMBLE, "").trim(), MAX_INCOMING);
            return touch(id, true);
          }
          return;
        }
        case "session.text.started":
          c.text = "";
          return touch(id);
        case "session.text.delta":
          c.text = tail(c.text + (data.delta ?? ""), MAX_TEXT);
          return touch(id);
        case "session.text.ended":
          if (typeof data.text === "string") c.text = tail(data.text, MAX_TEXT);
          return touch(id);
        case "session.tool.input.started":
          toolNames.set(data.id, data.name);
          c.tool = { name: data.name, summary: data.name, done: false };
          return touch(id);
        case "session.tool.called": {
          const name = toolNames.get(data.id) ?? c.tool?.name;
          c.tool = { name, summary: summarizeTool(name, data.input), done: false };
          return touch(id);
        }
        case "session.tool.success":
        case "session.tool.error":
        case "session.tool.failed":
          if (c.tool) c.tool.done = true;
          return touch(id);
        default:
          return;
      }
    },

    get(id) {
      return cards.get(id);
    },

    forget(id) {
      if (pending.has(id)) timers.clearTimeout(pending.get(id));
      pending.delete(id);
      cards.delete(id);
    },

    dispose() {
      for (const t of pending.values()) timers.clearTimeout(t);
      pending.clear();
      cards.clear();
    },
  };
}
