// How panes start our scripts (card, summary strip, agent graph), the same way
// in every shell a herdr pane might run: sh, bash, zsh, fish, nushell,
// PowerShell, cmd.
//
// `herdr pane run` types its text into the pane's shell, so anything that
// needs quoting (paths with spaces, a server URL) is shell-specific. Instead:
//   - the pane starts in the script's own directory, so the script is named
//     by its bare file name;
//   - the opencode binary's directory goes first on the pane's PATH, so the
//     bare `opencode` resolves to the same binary as the TUI's;
//   - BUN_BE_BUN and the script's arguments travel in the pane's environment
//     (`herdr pane split --env`, which isn't parsed by a shell).
// The typed text is then just `opencode card.js` (`exec`-prefixed outside
// Windows, so the pane's shell doesn't stay around once the script exits).
import path from "node:path";

/** Pane environment variable holding the script's arguments, as JSON. */
export const ARGS_ENV = "HERDR_SUBAGENTS_PANE_ARGS";

/**
 * @param {object} opts
 * @param {string} opts.bin opencode binary (absolute path, or a bare name on PATH)
 * @param {string} opts.script absolute path of the script to run
 * @param {Record<string, string|number|undefined>} opts.args script arguments (undefined ones dropped)
 * @param {string} [opts.platform]
 * @param {Record<string,string|undefined>} [opts.env] environment to take PATH from
 * @returns {{ command: string, cwd: string, env: Record<string,string> }}
 */
export function paneLaunch({ bin, script, args, platform = process.platform, env = process.env }) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
  const launchEnv = { BUN_BE_BUN: "1", [ARGS_ENV]: JSON.stringify(clean) };
  // The executable's own name, as long as every shell can type it unquoted.
  const name = p.basename(bin).replace(/\.exe$/i, "");
  const exe = /^[\w.-]+$/.test(name) ? name : "opencode";
  if (p.isAbsolute(bin)) {
    // Windows spells it "Path"; keep whichever spelling the environment uses.
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    launchEnv[key] = [p.dirname(bin), env[key]].filter(Boolean).join(platform === "win32" ? ";" : ":");
  }
  const run = `${exe} ${p.basename(script)}`;
  return { command: platform === "win32" ? run : `exec ${run}`, cwd: p.dirname(script), env: launchEnv };
}

/**
 * A script's arguments: those from the pane environment (see paneLaunch),
 * overridden by any `--name value` pairs on the command line (handy when
 * running a script by hand).
 */
export function launchArgs(argv = process.argv.slice(2), env = process.env) {
  let args = {};
  try {
    if (env[ARGS_ENV]) args = JSON.parse(env[ARGS_ENV]) ?? {};
  } catch {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && argv[i + 1] !== undefined) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}
