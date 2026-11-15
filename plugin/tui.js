// opencode v2 client plugin: opens a herdr pane for each subagent of the
// session shown in this TUI, and closes it (debounced) once the subagent idles.
//
// Install: add this directory to the "plugins" array in ~/.config/opencode/cli.json.
import fs from "node:fs";
import path from "node:path";
import { createController, DEFAULT_CLOSE_DELAY_MS, DEFAULT_MAX_PANES } from "./controller.js";
import { createHerdrPanes, shellQuote } from "./herdr.js";

const VIEWER_ENV = "HERDR_SUBAGENTS_PANE_VIEWER";
const ROUTE_POLL_MS = 500;

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

function setup(api) {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID || !process.env.HERDR_SOCKET_PATH) return;
  // Viewer panes run this same plugin; they must not open panes of their own.
  if (process.env[VIEWER_ENV] === "1") return;

  const log = makeLogger();
  const server = serverFromArgv(process.argv.slice(2));
  const bin = opencodeBinary();
  const env = { [VIEWER_ENV]: "1" };
  if (process.env.OPENCODE_SERVER_PASSWORD) env.OPENCODE_SERVER_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD;

  const panes = createHerdrPanes({
    parentPaneId: process.env.HERDR_PANE_ID,
    cwd: process.cwd(),
    env,
    viewerCommand: (childId) =>
      ["exec", shellQuote(bin), ...(server ? ["--server", shellQuote(server)] : []), "--session", shellQuote(childId)].join(" "),
  });

  const controller = createController({
    panes,
    lookupParent: (id) => api.data.session.get(id)?.parentID,
    closeDelayMs: intFromEnv("HERDR_SUBAGENTS_CLOSE_DELAY_MS", DEFAULT_CLOSE_DELAY_MS),
    maxPanes: intFromEnv("HERDR_SUBAGENTS_MAX_PANES", DEFAULT_MAX_PANES),
    log,
  });

  function syncRoute() {
    const route = api.ui.router.current();
    controller.setRoute(route?.type === "session" ? route.sessionID : undefined);
  }

  const unsubscribe = api.data.listen(({ details }) => {
    if (!details?.type) return;
    syncRoute(); // route can change without an event of its own
    controller.handle(details.type, details.data);
  });
  syncRoute();
  const poll = setInterval(syncRoute, ROUTE_POLL_MS);
  poll.unref?.();
  log("setup", { pane: process.env.HERDR_PANE_ID, server: server ?? "(service)" });

  return () => {
    clearInterval(poll);
    unsubscribe();
    controller.dispose();
  };
}

export default {
  id: "herdr-subagents-pane",
  setup,
};
