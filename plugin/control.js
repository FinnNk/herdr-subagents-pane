// Control channel: lets the summary strip and herdr plugin actions send
// commands to the running plugin inside an opencode TUI.
//
// Each plugin instance has a runtime dir ($XDG_RUNTIME_DIR/herdr-subagents-pane/<pid>)
// holding instance.json ({ pid, pane, tab, startedAt }) and a commands/ dir.
// Senders drop one JSON file per command there; the plugin picks them up.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const COMMANDS = ["toggle", "focus-strip", "expand", "open", "graph"];

export function runtimeRoot(env = process.env) {
  return path.join(env.XDG_RUNTIME_DIR || os.tmpdir(), "herdr-subagents-pane");
}

let sent = 0;

/** Queue a command for the instance whose runtime dir is `dir`. */
export function writeCommand(dir, command) {
  const commands = path.join(dir, "commands");
  fs.mkdirSync(commands, { recursive: true, mode: 0o700 });
  // Sortable: time, then a per-sender counter (same-millisecond commands keep their order).
  const name = `${Date.now()}-${String(++sent).padStart(6, "0")}-${process.pid}.json`;
  const tmp = path.join(commands, `.${name}`);
  fs.writeFileSync(tmp, JSON.stringify(command));
  fs.renameSync(tmp, path.join(commands, name));
}

/** Take (read and delete) queued commands, oldest first. */
export function takeCommands(dir) {
  const commands = path.join(dir, "commands");
  let names;
  try {
    names = fs.readdirSync(commands).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const file = path.join(commands, n);
    try {
      const cmd = JSON.parse(fs.readFileSync(file, "utf8"));
      if (cmd && COMMANDS.includes(cmd.cmd)) out.push(cmd);
    } catch {}
    fs.rmSync(file, { force: true });
  }
  return out;
}

/**
 * Remove runtime dirs of instances whose process is gone (opencode can exit
 * before the plugin's own cleanup runs). Dirs are named after the pid.
 */
export function sweepStale(root = runtimeRoot(), isAlive = defaultIsAlive) {
  let removed = 0;
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {}
  for (const d of dirs) {
    const pid = Number(d);
    if (!Number.isInteger(pid) || pid <= 0 || isAlive(pid)) continue;
    fs.rmSync(path.join(root, d), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/** Running instances: [{ dir, pid, pane, tab, startedAt }]. */
export function listInstances(root = runtimeRoot(), isAlive = defaultIsAlive) {
  let dirs;
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(root, d, "instance.json"), "utf8"));
      if (Number.isInteger(info.pid) && isAlive(info.pid)) out.push({ ...info, dir: path.join(root, d) });
    } catch {}
  }
  return out;
}

/**
 * Which instance a command from herdr is for: the one whose TUI pane is the
 * focused pane or is in the focused tab, else the only one, else the newest.
 */
export function pickInstance(instances, { pane, tab } = {}) {
  if (instances.length === 0) return undefined;
  const exact = instances.find((i) => pane && (i.pane === pane || i.panes?.includes(pane)));
  if (exact) return exact;
  const sameTab = instances.filter((i) => tab && (i.tab === tab || i.tabs?.includes(tab)));
  const pool = sameTab.length ? sameTab : instances;
  return [...pool].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
}
