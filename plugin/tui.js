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
import { createController, DEFAULT_CLOSE_DELAY_MS, DEFAULT_MAX_PANES, DEFAULT_SETTLE_MS } from "./controller.js";
import { createCardStore } from "./cards.js";
import { createHerdrPanes, shellQuote } from "./herdr.js";
import { createSummaryStore } from "./summary.js";

const VIEWER_ENV = "HERDR_SUBAGENTS_PANE_VIEWER";
const ROUTE_POLL_MS = 500;
const CARD_SCRIPT = fileURLToPath(new URL("./card.js", import.meta.url));
const SUMMARY_SCRIPT = fileURLToPath(new URL("./summary.js", import.meta.url));
/** Share of its height the orchestrator pane keeps when the summary strip opens below it. */
const STRIP_RATIO = 0.84;

function intFromEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

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

function makeLogger() {
  const file = process.env.HERDR_SUBAGENTS_DEBUG;
  if (!file) return () => {};
  return (msg, extra) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${msg} ${extra ? JSON.stringify(extra) : ""}\n`);
    } catch {}
  };
}

/** Shell command that runs the card for one subagent (falls back to the full view). */
export function cardCommand({ bin, cardScript, stateFile, childId, server }) {
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
  ].join(" ");
}

/** Shell command that runs the summary strip. */
export function summaryCommand({ bin, summaryScript, stateFile }) {
  const q = shellQuote;
  return ["exec env BUN_BE_BUN=1", q(bin), q(summaryScript), "--state", q(stateFile)].join(" ");
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

  const log = makeLogger();
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
    viewerCommand: (childId) =>
      cardCommand({ bin, cardScript: CARD_SCRIPT, stateFile: stateFile(childId), childId, server }),
  });

  // Summary strip: a full-width pane along the bottom with the agent tree. It is
  // split off the orchestrator's pane before the first column so it spans the
  // whole width, and closed together with the last viewer.
  const stripEnabled = process.env.HERDR_SUBAGENTS_SUMMARY !== "0";
  const summaryFile = path.join(cardDir, "summary.json");
  let stripPane;
  const viewerPanes = new Set();
  const panes = {
    async open(childId, anchor, label) {
      if (stripEnabled && !stripPane) {
        try {
          stripPane = await herdrPanes.openStrip({
            ratio: STRIP_RATIO,
            label: "agents",
            command: summaryCommand({ bin, summaryScript: SUMMARY_SCRIPT, stateFile: summaryFile }),
          });
          log("opened summary strip", { pane: stripPane });
        } catch (err) {
          log("summary strip failed", { err: String(err) });
        }
      }
      const paneId = await herdrPanes.open(childId, anchor, label);
      viewerPanes.add(paneId);
      return paneId;
    },
    async exists(paneId) {
      const ok = await herdrPanes.exists(paneId);
      if (!ok) viewerPanes.delete(paneId);
      return ok;
    },
    rename: herdrPanes.rename,
    async close(paneId) {
      await herdrPanes.close(paneId);
      viewerPanes.delete(paneId);
      if (viewerPanes.size === 0 && stripPane) {
        const strip = stripPane;
        stripPane = undefined;
        await herdrPanes.close(strip);
        log("closed summary strip", { pane: strip });
      }
    },
  };

  controller = createController({
    panes,
    lookupParent: (id) => api.data.session.get(id)?.parentID,
    lookupRunning: (id) => api.data.session.status(id) === "running",
    onStatus: (id, info) => cards.status(id, info),
    isPinned: (id) => fs.existsSync(`${stateFile(id)}.expanded`),
    closeDelayMs: intFromEnv("HERDR_SUBAGENTS_CLOSE_DELAY_MS", DEFAULT_CLOSE_DELAY_MS),
    maxPanes: intFromEnv("HERDR_SUBAGENTS_MAX_PANES", DEFAULT_MAX_PANES),
    settleMs: intFromEnv("HERDR_SUBAGENTS_SETTLE_MS", DEFAULT_SETTLE_MS),
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
  });

  function syncRoute() {
    const route = api.ui.router.current();
    controller.setRoute(route?.type === "session" ? route.sessionID : undefined);
  }

  const unsubscribe = api.data.listen(({ details }) => {
    if (!details?.type) return;
    syncRoute(); // route can change without an event of its own
    controller.handle(details.type, details.data);
    const id = details.data?.sessionID;
    if (id && controller.isTracked(id)) cards.handle(details.type, details.data);
    summary.handle(details.type, details.data);
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
