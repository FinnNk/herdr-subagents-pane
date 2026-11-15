// opencode v2 client plugin: shows a herdr pane per subagent of the session in
// this TUI. Each pane is a compact card (status, latest message, current tool,
// latest text); zooming the pane (ctrl+b z) or Enter expands it into the full
// opencode view.
//
// Install: add this directory to the "plugins" array in ~/.config/opencode/cli.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createController } from "./controller.js";
import { loadConfig, makeExclude } from "./config.js";
import { createCardStore } from "./cards.js";
import { createHerdrPanes, shellQuote } from "./herdr.js";
import { createSummaryStore } from "./summary.js";

const VIEWER_ENV = "HERDR_SUBAGENTS_PANE_VIEWER";
const ROUTE_POLL_MS = 500;
const CARD_SCRIPT = fileURLToPath(new URL("./card.js", import.meta.url));
const SUMMARY_SCRIPT = fileURLToPath(new URL("./summary.js", import.meta.url));
/** Share of its height the orchestrator pane keeps when the summary strip opens below it. */
const STRIP_RATIO = 0.84;

/** The --server URL this TUI was started with, if any (default: background service). */
export function serverFromArgv(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") break;
    if (argv[i] === "--server") return argv[i + 1];
    if (argv[i].startsWith("--server=")) return argv[i].slice("--server=".length);
  }
  return undefined;
}

function opencodeBinary() {
  const exe = process.execPath;
  return exe && path.basename(exe).startsWith("opencode") ? exe : "opencode";
}

function makeLogger(file) {
  if (!file) return () => {};
  return (msg, extra) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${msg} ${extra ? JSON.stringify(extra) : ""}\n`);
    } catch {}
  };
}

/** Shell command that runs the card for one subagent (falls back to the full view). */
export function cardCommand({ bin, cardScript, stateFile, childId, server, owner }) {
  const q = shellQuote;
  const serverArgs = server ? ["--server", q(server)] : [];
  return [
    "exec env BUN_BE_BUN=1",
    q(bin),
    q(cardScript),
    "--state", q(stateFile),
    "--session", q(childId),
    "--bin", q(bin),
    ...serverArgs,
    ...(owner ? ["--owner", String(owner)] : []),
  ].join(" ");
}

/** Shell command that runs the summary strip. */
export function summaryCommand({ bin, summaryScript, stateFile, owner }) {
  const q = shellQuote;
  const ownerArgs = owner ? ["--owner", String(owner)] : [];
  return ["exec env BUN_BE_BUN=1", q(bin), q(summaryScript), "--state", q(stateFile), ...ownerArgs].join(" ");
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function setup(api) {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID || !process.env.HERDR_SOCKET_PATH) return;
  // Viewer panes run this same plugin; they must not open panes of their own.
  if (process.env[VIEWER_ENV] === "1") return;

  const { config, source, warnings } = loadConfig();
  if (!config.enabled) return;
  const log = makeLogger(config.debugLog);
  log("config", { source: source ?? "(defaults)", config });
  if (warnings.length) {
    for (const w of warnings) log("config warning", { w });
    try {
      api.ui?.toast?.show({ variant: "warning", title: "herdr-subagents-pane config", message: warnings.join("\n") });
    } catch {}
  }
  const server = serverFromArgv(process.argv.slice(2));
  const bin = opencodeBinary();
  const env = { [VIEWER_ENV]: "1" };
  if (process.env.OPENCODE_SERVER_PASSWORD) env.OPENCODE_SERVER_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD;

  // Card state lives in a private runtime dir, one JSON file per subagent.
  const cardDir = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), "herdr-subagents-pane", String(process.pid));
  fs.mkdirSync(cardDir, { recursive: true, mode: 0o700 });
  const stateFile = (id) => path.join(cardDir, `${id}.json`);
  // Declared before the card store needs it; assigned once the controller exists.
  let controller;
  const cards = createCardStore({
    parentLabel(id) {
      const parent = controller?.parentOf(id);
      if (!parent || parent === controller.root) return "orchestrator";
      return controller.titleOf(parent) ?? "parent";
    },
    write(id, card) {
      try {
        const tmp = `${stateFile(id)}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(card));
        fs.renameSync(tmp, stateFile(id));
      } catch (err) {
        log("card write failed", { err: String(err) });
      }
    },
  });

  const herdrPanes = createHerdrPanes({
    parentPaneId: process.env.HERDR_PANE_ID,
    cwd: process.cwd(),
    env,
    log,
    viewerCommand: (childId) =>
      cardCommand({ bin, cardScript: CARD_SCRIPT, stateFile: stateFile(childId), childId, server, owner: process.pid }),
  });

  // Summary strip: a full-width pane along the bottom with the agent tree. The
  // controller opens it with the first subagent (before any column, so it spans
  // the whole width) and closes it once the workflow has been quiet for the
  // close delay, so it shows even when no subagent works long enough for a pane.
  const summaryFile = path.join(cardDir, "summary.json");
  let stripPane;
  const strip = config.summary
    ? {
        async open() {
          if (stripPane && (await herdrPanes.exists(stripPane))) return;
          stripPane = await herdrPanes.openStrip({
            ratio: STRIP_RATIO,
            label: "agents",
            command: summaryCommand({ bin, summaryScript: SUMMARY_SCRIPT, stateFile: summaryFile, owner: process.pid }),
          });
        },
        async close() {
          const id = stripPane;
          stripPane = undefined;
          if (id) await herdrPanes.close(id);
        },
      }
    : undefined;
  // Without status reporting, leave herdr's own idea of the viewer panes alone.
  const panes = config.reportStatus ? herdrPanes : { ...herdrPanes, report: undefined };

  controller = createController({
    panes,
    strip,
    lookupParent: (id) => api.data.session.get(id)?.parentID,
    lookupRunning: (id) => api.data.session.status(id) === "running",
    onStatus: (id, info) => cards.status(id, info),
    onNeedsInput(id, { title, kind, detail }) {
      if (!config.notifyInput) return;
      const what = kind === "permission" ? "a permission reply" : "an answer";
      const where = api.data.session.get(controller.root)?.title;
      const body = [detail, where && `in ${where}`].filter(Boolean).join(" · ");
      herdrPanes.notify(`${title} is waiting for ${what}`, body);
    },
    isPinned: (id) => fs.existsSync(`${stateFile(id)}.expanded`),
    autoClose: config.autoClose,
    openDelayMs: config.openDelayMs,
    exclude: makeExclude(config, (id) => api.data.session.get(id)?.agent),
    closeDelayMs: config.closeDelayMs,
    maxPanes: config.maxPanes,
    overflow: config.overflow,
    overflowMaxPanes: config.overflowMaxPanes,
    settleMs: config.settleMs,
    log,
  });

  const summary = createSummaryStore({
    write(snapshot) {
      try {
        writeJson(summaryFile, snapshot);
      } catch (err) {
        log("summary write failed", { err: String(err) });
      }
    },
    inTree: (id) => id === controller.root || controller.isTracked(id),
    parentOf: (id) => controller.parentOf(id),
    root: () => controller.root,
    titleOf: (id) => controller.titleOf(id),
  });

  /** Model and cost for the strip, from opencode's cache. */
  function updateMeta(id) {
    const d = api.data.session.get(id);
    if (d) summary.meta(id, { model: d.model?.id, cost: d.cost });
  }

  // Subagents that already exist when this TUI shows a session (e.g. after a
  // restart, or when opening a session mid-run) never send session.created
  // here, so look them up once per root.
  // Subagents that already exist when this TUI shows a session (e.g. after a
  // restart, or when opening a session mid-run) never send session.created
  // here. Load the tree into opencode's cache, the way opencode does itself:
  // session.sync(id, { children: true }) is read-only (it fetches the session
  // and lists its children), and session.family(root) then holds every known
  // member, so repeat for new members until the tree is complete.
  let adoptedRoot;
  async function adoptExisting() {
    const r = controller.root;
    if (!r || r === adoptedRoot) return;
    adoptedRoot = r;
    try {
      const synced = new Set();
      let pending = [r];
      while (pending.length && controller.root === r) {
        await Promise.all(pending.map((id) => api.data.session.sync(id, { children: true })));
        for (const id of pending) synced.add(id);
        pending = (api.data.session.family(r) ?? []).filter((id) => !synced.has(id));
      }
      if (controller.root !== r) return;
      const info = (id) => api.data.session.get(id);
      const isRunning = (id) => api.data.session.status(id) === "running";
      const sessions = [...synced]
        .filter((id) => id !== r)
        .map((id) => ({ id, parentID: info(id)?.parentID, title: info(id)?.title, running: isRunning(id), created: info(id)?.time?.created ?? 0 }))
        .sort((a, b) => a.created - b.created);
      log("adopting existing subagents", { root: r, count: sessions.length });
      if (sessions.length) controller.adopt(sessions);
      summary.title(r, info(r)?.title);
      for (const id of [r, ...sessions.map((x) => x.id)]) {
        const d = info(id);
        const t = d?.tokens ?? {};
        summary.seed(id, {
          title: id === r ? undefined : d?.title,
          running: isRunning(id),
          runStart: d?.time?.busy,
          tokensIn: (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0),
          tokensOut: (t.output ?? 0) + (t.reasoning ?? 0),
        });
        updateMeta(id);
      }
    } catch (err) {
      log("adopting existing subagents failed", { err: String(err) });
    }
  }

  function syncRoute() {
    const route = api.ui.router.current();
    controller.setRoute(route?.type === "session" ? route.sessionID : undefined);
    if (controller.root !== adoptedRoot) adoptExisting();
  }

  const unsubscribe = api.data.listen(({ details }) => {
    if (!details?.type) return;
    syncRoute(); // route can change without an event of its own
    controller.handle(details.type, details.data);
    const id = details.data?.sessionID;
    if (id && controller.isTracked(id)) cards.handle(details.type, details.data);
    summary.handle(details.type, details.data);
    if (id && (id === controller.root || controller.isTracked(id))) updateMeta(id);
    if (controller.root) summary.title(controller.root, api.data.session.get(controller.root)?.title);
  });
  syncRoute();
  const poll = setInterval(syncRoute, ROUTE_POLL_MS);
  poll.unref?.();
  log("setup", { pane: process.env.HERDR_PANE_ID, server: server ?? "(service)", cardDir });

  return () => {
    clearInterval(poll);
    unsubscribe();
    controller.dispose().finally(() => {
      cards.dispose();
      summary.dispose();
      fs.rmSync(cardDir, { recursive: true, force: true });
    });
  };
}

export default {
  id: "herdr-subagents-pane",
  setup,
};
