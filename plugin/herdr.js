// Thin adapter over the herdr CLI. The CLI inherits HERDR_SOCKET_PATH from the
// opencode TUI process, so it talks to the herdr session hosting this pane.
import { execFile } from "node:child_process";
import { rebalanceActions } from "./layout.js";

const HERDR_TIMEOUT_MS = 10_000;

function herdr(args) {
  return new Promise((resolve, reject) => {
    execFile("herdr", args, { timeout: HERDR_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`herdr ${args[0]} ${args[1] ?? ""} failed: ${(stderr || err.message).trim()}`));
        return;
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : {});
      } catch {
        resolve({ raw: stdout });
      }
    });
  });
}

/** herdr agent state for a card status. */
export function herdrState(status) {
  if (/^needs input/.test(status)) return "blocked";
  if (/^(working|starting)/.test(status)) return "working";
  return "idle"; // waiting, done, closing
}

/** @typedef {{ command: string, cwd?: string, env?: Record<string,string> }} Launch  see launch.js */

/**
 * @param {object} opts
 * @param {string} opts.parentPaneId pane hosting the parent opencode TUI
 * @param {string} opts.cwd working directory for panes whose launch doesn't set one
 * @param {(childId: string) => Launch} opts.viewerLaunch how a viewer pane shows a child session
 * @param {Record<string,string>} [opts.env] extra env for all our panes (passed via --env, not argv)
 * @param {string} [opts.overflowLabel] label of the overflow tab
 * @param {(msg: string, extra?: object) => void} [opts.log]
 */
export function createHerdrPanes({ parentPaneId, cwd, viewerLaunch, env = {}, overflowLabel = "subagents", log = () => {} }) {
  // Overflow tab: created (unfocused) for the first overflow viewer, closed with
  // the last one. Closing its panes isn't enough: other plugins (e.g. a sidebar)
  // may have added panes of their own to it.
  let overflowTab;
  const overflowPanes = new Set();
  let reportSeq = 0;

  /** --cwd and --env flags for a new pane running `launch`. */
  function spawnFlags(launch) {
    const flags = ["--cwd", launch?.cwd ?? cwd];
    for (const [k, v] of Object.entries({ ...env, ...launch?.env })) flags.push("--env", `${k}=${v}`);
    return flags;
  }

  async function openInNewTab(childId, label) {
    // The overflow tab goes in the TUI's workspace, not whichever one is active.
    const workspace = (await herdr(["pane", "get", parentPaneId]).catch(() => undefined))?.result?.pane?.workspace_id;
    const launch = viewerLaunch(childId);
    const args = ["tab", "create", "--label", overflowLabel, "--no-focus", ...spawnFlags(launch)];
    if (workspace) args.push("--workspace", workspace);
    const focusedBefore = await focusedTab();
    const res = await herdr(args);
    const tabId = res?.result?.tab?.tab_id;
    const paneId = res?.result?.root_pane?.pane_id;
    if (!tabId || !paneId) throw new Error("herdr tab create returned no tab or pane id");
    overflowTab = tabId;
    if (focusedBefore) keepFocus(tabId, focusedBefore);
    await herdr(["pane", "rename", paneId, label]).catch(() => {});
    await herdr(["pane", "run", paneId, launch.command]);
    return paneId;
  }

  async function focusedTab() {
    const tabs = (await herdr(["tab", "list"]).catch(() => undefined))?.result?.tabs ?? [];
    return tabs.find((t) => t.focused)?.tab_id;
  }

  /**
   * The new tab is created without focus, but another plugin reacting to it
   * (e.g. a sidebar adding its pane) can move focus there. For a few seconds,
   * move focus back to where it was if that happens.
   */
  function keepFocus(newTab, previous) {
    let checks = 0;
    const timer = setInterval(async () => {
      checks += 1;
      if (checks > 20) return clearInterval(timer);
      if ((await focusedTab()) === newTab) {
        clearInterval(timer);
        await herdr(["tab", "focus", previous]).catch(() => {});
        log("restored focus after opening the overflow tab", { tab: previous });
      }
    }, 200);
    timer.unref?.();
  }

  return {
    async open(childId, anchor, label) {
      if (anchor.area === "overflow" && !anchor.paneId) {
        const paneId = await openInNewTab(childId, label);
        overflowPanes.add(paneId);
        return paneId;
      }
      const target = anchor.paneId ?? parentPaneId;
      const launch = viewerLaunch(childId);
      const args = ["pane", "split", target, "--direction", anchor.direction, "--no-focus", ...spawnFlags(launch)];
      if (anchor.ratio) args.push("--ratio", String(anchor.ratio));
      const res = await herdr(args);
      const paneId = res?.result?.pane?.pane_id;
      if (!paneId) throw new Error("herdr pane split returned no pane id");
      await herdr(["pane", "rename", paneId, label]).catch(() => {});
      await herdr(["pane", "run", paneId, launch.command]);
      if (anchor.area === "overflow") overflowPanes.add(paneId);
      return paneId;
    },
    /** Split the parent pane downward for the summary strip; the parent keeps `ratio` of its height. */
    async openStrip({ ratio, label, launch }) {
      const args = ["pane", "split", parentPaneId, "--direction", "down", "--ratio", String(ratio), "--no-focus", ...spawnFlags(launch)];
      const res = await herdr(args);
      const paneId = res?.result?.pane?.pane_id;
      if (!paneId) throw new Error("herdr pane split returned no pane id");
      await herdr(["pane", "rename", paneId, label]).catch(() => {});
      await herdr(["pane", "run", paneId, launch.command]);
      return paneId;
    },
    async exists(paneId) {
      try {
        await herdr(["pane", "get", paneId]);
        return true;
      } catch {
        return false;
      }
    },
    async close(paneId) {
      await herdr(["pane", "close", paneId]).catch(() => {}); // already closed by the user is fine
      if (overflowPanes.delete(paneId) && overflowPanes.size === 0 && overflowTab) {
        const tab = overflowTab;
        overflowTab = undefined;
        await herdr(["tab", "close", tab]).catch(() => {});
      }
    },
    /**
     * Even out column widths and card heights among `paneIds` (our viewers),
     * in the main tab and the overflow tab.
     */
    async rebalance(paneIds) {
      const ours = new Set(paneIds);
      const anchors = [parentPaneId, [...overflowPanes].find((p) => ours.has(p))].filter(Boolean);
      for (const anchor of anchors) {
        const layout = (await herdr(["pane", "layout", "--pane", anchor]).catch(() => undefined))?.result?.layout;
        if (!layout || layout.zoomed) continue; // don't fight a zoomed (expanded) view
        for (const a of rebalanceActions(layout, ours)) {
          await herdr(["pane", "resize", "--pane", a.paneId, "--direction", a.direction, "--amount", String(a.amount)]).catch((err) =>
            log("resize failed", { err: String(err) }),
          );
        }
      }
    },
    async rename(paneId, label) {
      await herdr(["pane", "rename", paneId, label]).catch(() => {});
    },
    /** Tell herdr the viewer pane's agent state, so its tab and sidebar indicators show it. */
    async report(paneId, status, title, sessionId) {
      const args = ["pane", "report-agent", paneId, "--source", "herdr-subagents-pane", "--agent", "opencode"];
      args.push("--state", herdrState(status), "--message", `${title} · ${status}`, "--seq", String(++reportSeq));
      // The opencode session shown in the pane, so herdr (and tools built on it) know it.
      if (sessionId) args.push("--agent-session-id", sessionId);
      await herdr(args).catch((err) => log("report-agent failed", { err: String(err) }));
    },
    /**
     * Show `launch` in its own focused tab (the agent graph), or focus that tab
     * if it is still open. Returns the tab id.
     */
    async openTab(existingTab, { label, launch }) {
      if (existingTab) {
        const ok = await herdr(["tab", "focus", existingTab]).then(() => true, () => false);
        if (ok) return existingTab;
      }
      const workspace = (await herdr(["pane", "get", parentPaneId]).catch(() => undefined))?.result?.pane?.workspace_id;
      const args = ["tab", "create", "--label", label, "--focus", ...spawnFlags(launch)];
      if (workspace) args.push("--workspace", workspace);
      const res = await herdr(args);
      const tabId = res?.result?.tab?.tab_id;
      const paneId = res?.result?.root_pane?.pane_id;
      if (!tabId || !paneId) throw new Error("herdr tab create returned no tab or pane id");
      await herdr(["pane", "rename", paneId, label]).catch(() => {});
      await herdr(["pane", "run", paneId, launch.command]);
      return tabId;
    },
    async closeTab(tabId) {
      if (tabId) await herdr(["tab", "close", tabId]).catch(() => {});
    },
    /** Tab a pane is in. */
    async tabOf(paneId) {
      return (await herdr(["pane", "get", paneId]).catch(() => undefined))?.result?.pane?.tab_id;
    },
    /** Bring a pane to the front: focus its tab, then zoom it (the card expands when zoomed). */
    async zoom(paneId) {
      const tab = await this.tabOf(paneId);
      if (tab) await herdr(["tab", "focus", tab]).catch(() => {});
      await herdr(["pane", "zoom", paneId, "--on"]);
    },
    /** Focus the pane next to `paneId` in `direction` (herdr can't focus a pane by id). */
    async focusNeighbour(paneId, direction) {
      const tab = await this.tabOf(paneId);
      if (tab) await herdr(["tab", "focus", tab]).catch(() => {});
      await herdr(["pane", "focus", "--pane", paneId, "--direction", direction]);
    },
    /** A herdr notification (shown whichever tab is focused). */
    async notify(title, body, sound = "request") {
      const args = ["notification", "show", title, "--sound", sound];
      if (body) args.push("--body", body);
      await herdr(args).then(
        () => log("notification shown", { title }),
        (err) => log("notification failed", { err: String(err) }),
      );
    },
  };
}
