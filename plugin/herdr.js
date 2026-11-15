// Thin adapter over the herdr CLI. The CLI inherits HERDR_SOCKET_PATH from the
// opencode TUI process, so it talks to the herdr session hosting this pane.
import { execFile } from "node:child_process";

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

/** POSIX single-quote a value for a shell command line. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {object} opts
 * @param {string} opts.parentPaneId pane hosting the parent opencode TUI
 * @param {string} opts.cwd working directory for viewer panes
 * @param {(childId: string) => string} opts.viewerCommand shell command that attaches to a child session
 * @param {Record<string,string>} [opts.env] extra env for viewer panes (passed via --env, not argv)
 */
export function createHerdrPanes({ parentPaneId, cwd, viewerCommand, env = {} }) {
  return {
    async open(childId, anchor, label) {
      const target = anchor.paneId ?? parentPaneId;
      const args = ["pane", "split", target, "--direction", anchor.direction, "--cwd", cwd, "--no-focus"];
      if (anchor.ratio) args.push("--ratio", String(anchor.ratio));
      for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
      const res = await herdr(args);
      const paneId = res?.result?.pane?.pane_id;
      if (!paneId) throw new Error("herdr pane split returned no pane id");
      await herdr(["pane", "rename", paneId, label]).catch(() => {});
      await herdr(["pane", "run", paneId, viewerCommand(childId)]);
      return paneId;
    },
    /** Split the parent pane downward for the summary strip; the parent keeps `ratio` of its height. */
    async openStrip({ ratio, label, command }) {
      const args = ["pane", "split", parentPaneId, "--direction", "down", "--ratio", String(ratio), "--cwd", cwd, "--no-focus"];
      for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
      const res = await herdr(args);
      const paneId = res?.result?.pane?.pane_id;
      if (!paneId) throw new Error("herdr pane split returned no pane id");
      await herdr(["pane", "rename", paneId, label]).catch(() => {});
      await herdr(["pane", "run", paneId, command]);
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
    },
    async rename(paneId, label) {
      await herdr(["pane", "rename", paneId, label]).catch(() => {});
    },
  };
}
