// Safety net for pane processes (cards, summary strip): if the opencode TUI
// that opened the pane is gone, close the pane. opencode may exit before the
// plugin's cleanup has closed every pane, and leftovers would duplicate the
// panes of the next TUI that shows the same session.
import { execFile } from "node:child_process";

/** Is a process with this pid still alive? (EPERM means it exists but isn't ours.) */
export function isAlive(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Close this pane (HERDR_PANE_ID) and exit once `ownerPid` has gone.
 * @returns {() => void} stop watching
 */
export function watchOwner(ownerPid, { intervalMs = 1_000, onGone } = {}) {
  const pid = Number(ownerPid);
  if (!Number.isInteger(pid) || pid <= 0) return () => {};
  const timer = setInterval(() => {
    if (isAlive(pid)) return;
    clearInterval(timer);
    onGone?.();
    const pane = process.env.HERDR_PANE_ID;
    if (!pane) return process.exit(0);
    execFile("herdr", ["pane", "close", pane], { timeout: 5_000 }, () => process.exit(0));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
