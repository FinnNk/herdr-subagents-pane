// Compact "card" for one subagent, shown in its herdr pane. Zoom is the toggle:
// click the card, press Enter, or zoom the pane (herdr prefix+z, default
// ctrl+b z) to expand into the full opencode view; un-zoom (ctrl+b z again) or
// quit the full view (ctrl+c) to come back to the card. While expanded, a
// marker file next to the state file tells the plugin not to close the pane.
//
// Run by the plugin as: BUN_BE_BUN=1 opencode card.js --state <file> --session <id>
//                       [--server <url>] [--bin <opencode binary>]
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const color = (n) => `${ESC}${n}m`;

const STATUS_STYLE = [
  [/^needs input/, color(31), "▲"],
  [/^working/, color(32), "●"],
  [/^done/, color(90), "✓"],
  [/^waiting/, color(33), "◌"],
  [/^starting/, color(36), "○"],
];

/** Wrap plain text to `width` columns (simple, whitespace-based). */
export function wrap(text, width) {
  const out = [];
  for (const para of String(text).split(/\n+/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export function formatElapsed(ms) {
  if (!(ms >= 0)) return "";
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

const stripMarkdown = (s) =>
  s
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/[*_`#>]+/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1");

/**
 * Render a card to lines (with ANSI styling) for a `cols` x `rows` pane.
 * @returns {string[]}
 */
export function renderCard(state, { cols, rows, now = Date.now() }) {
  const width = Math.max(10, cols - 2);
  const lines = [];
  const push = (s = "", style = "") => lines.push(style ? `${style}${s}${RESET}` : s);

  if (!state) {
    push(" waiting for subagent…", DIM);
    return lines;
  }

  const [, style, icon] = STATUS_STYLE.find(([re]) => re.test(state.status)) ?? [null, "", "·"];
  const elapsed =
    state.startedAt != null ? formatElapsed((state.endedAt ?? now) - state.startedAt) : "";
  push(` ${state.title ?? state.id}`.slice(0, cols), BOLD);
  push(` ${icon} ${state.status}${elapsed ? `  ·  ${elapsed}` : ""}`.slice(0, cols), style);
  push();

  const footer = " ⏎ / click / ctrl+b z: expand   ·   ctrl+b z again to return";
  const budget = Math.max(0, rows - lines.length - 2); // keep a blank line + footer

  const body = [];
  if (state.incoming) {
    const inc = wrap(`← ${state.incoming.replace(/\s+/g, " ")}`, width).slice(0, 2);
    for (const l of inc) body.push([` ${l}`, color(36)]);
  }
  if (state.tool) {
    body.push([` ${state.tool.done ? "✓" : "⚙"} ${state.tool.summary}`.slice(0, cols), DIM]);
  }
  if (state.text) {
    if (body.length) body.push(["", ""]);
    const textLines = wrap(stripMarkdown(state.text), width);
    const room = Math.max(0, budget - body.length);
    for (const l of textLines.slice(-room)) body.push([` ${l}`, ""]);
  }
  for (const [l, s] of body.slice(0, budget)) push(l, s);

  while (lines.length < rows - 1) push();
  push(footer.slice(0, cols), DIM);
  return lines.slice(0, rows);
}

// ----- interactive process -------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  return args;
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function herdr(args) {
  return new Promise((resolve) =>
    execFile("herdr", args, { timeout: 5_000 }, (err, stdout) => {
      try {
        resolve(err ? undefined : JSON.parse(stdout));
      } catch {
        resolve(undefined);
      }
    }),
  );
}

/** Is this pane the zoomed one? (Zooming a pane focuses it.) */
async function zoomedSelf(pane) {
  const layout = (await herdr(["pane", "layout", "--pane", pane]))?.result?.layout;
  if (!layout) return undefined; // unknown: don't act on it
  return layout.zoomed === true && layout.focused_pane_id === pane;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { stdin, stdout } = process;
  const pane = process.env.HERDR_PANE_ID;
  const MOUSE_ON = `${ESC}?1000h${ESC}?1006h`;
  const MOUSE_OFF = `${ESC}?1000l${ESC}?1006l`;
  let expanded = false;
  let lastFrame = "";

  function draw(force = false) {
    if (expanded) return;
    const frame = renderCard(readState(args.state), { cols: stdout.columns || 60, rows: stdout.rows || 20 }).join("\r\n");
    if (!force && frame === lastFrame) return;
    lastFrame = frame;
    stdout.write(`${ESC}H${ESC}2J${frame}`);
  }

  function enterCardMode() {
    stdout.write(`${ESC}?25l${MOUSE_ON}`);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    draw(true);
  }

  function leaveCardMode() {
    stdout.write(`${MOUSE_OFF}${ESC}?25h${ESC}H${ESC}2J`);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  }

  const marker = `${args.state}.expanded`;
  let child;

  async function expand({ alreadyZoomed = false } = {}) {
    if (expanded) return;
    expanded = true;
    try {
      fs.writeFileSync(marker, String(Date.now()));
    } catch {}
    leaveCardMode();
    if (pane && !alreadyZoomed) await herdr(["pane", "zoom", pane, "--on"]);
    const env = { ...process.env, HERDR_SUBAGENTS_PANE_VIEWER: "1" };
    delete env.BUN_BE_BUN; // otherwise the opencode binary would act as bun
    const cmd = [...(args.server ? ["--server", args.server] : []), "--session", args.session];
    let unzoomedByUser = false;
    await new Promise((resolve) => {
      child = spawn(args.bin || "opencode", cmd, { stdio: "inherit", env });
      child.on("exit", resolve);
      child.on("error", resolve);
      // Un-zooming the pane (ctrl+b z) collapses back to the card.
      const watch = setInterval(async () => {
        if (!pane || !child || child.exitCode !== null) return;
        if ((await zoomedSelf(pane)) === false) {
          unzoomedByUser = true;
          clearInterval(watch);
          child.kill("SIGTERM");
        }
      }, 700);
      child.on("exit", () => clearInterval(watch));
    });
    child = undefined;
    if (pane && !unzoomedByUser) await herdr(["pane", "zoom", pane, "--off"]);
    try {
      fs.rmSync(marker, { force: true });
    } catch {}
    expanded = false;
    enterCardMode();
  }

  // Zooming the card's pane (ctrl+b z) expands it too.
  setInterval(async () => {
    if (expanded || !pane) return;
    if ((await zoomedSelf(pane)) === true && !expanded) expand({ alreadyZoomed: true });
  }, 700);

  stdin.on("data", (buf) => {
    if (expanded) return;
    const s = buf.toString("utf8");
    if (s === "\x03") {
      leaveCardMode();
      process.exit(0);
    }
    // Enter, or a left-button press (SGR mouse: ESC [ < 0 ; x ; y M)
    if (s === "\r" || s === "\n" || /\x1b\[<0;\d+;\d+M/.test(s)) expand();
  });
  stdout.on("resize", () => draw(true));
  process.on("exit", () => {
    stdout.write(`${MOUSE_OFF}${ESC}?25h`);
    try {
      fs.rmSync(marker, { force: true });
    } catch {}
    child?.kill("SIGTERM");
  });
  // While expanded, ctrl+c belongs to the full view (its process group gets the
  // same SIGINT); in card mode raw input delivers it as a key instead.
  process.on("SIGINT", () => {
    if (!expanded) process.exit(0);
  });
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGHUP", () => process.exit(0));

  enterCardMode();
  setInterval(draw, 250); // state file updates + elapsed clock
}

if (import.meta.main) main();
