// Send a command to the plugin running in an opencode TUI, e.g. from a herdr
// plugin action:   node plugin/ctl.js toggle | focus-strip | expand <session> | open <session>
// The target is picked from HERDR_PANE_ID / HERDR_TAB_ID (set by herdr).
import { COMMANDS, listInstances, pickInstance, writeCommand } from "./control.js";

const [cmd, session] = process.argv.slice(2);
if (!COMMANDS.includes(cmd) || ((cmd === "expand" || cmd === "open") && !session)) {
  console.error(`usage: ctl.js ${COMMANDS.join("|")} [session]`);
  process.exit(2);
}
const target = pickInstance(listInstances(), { pane: process.env.HERDR_PANE_ID, tab: process.env.HERDR_TAB_ID });
if (!target) {
  console.error("herdr-subagents-pane: no opencode TUI with the plugin is running");
  process.exit(1);
}
writeCommand(target.dir, session ? { cmd, session } : { cmd });
console.log(JSON.stringify({ sent: cmd, to: target.pid, tab: target.tab }));
