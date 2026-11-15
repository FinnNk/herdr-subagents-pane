// Settings: defaults, then a JSON config file, then environment variables.
//
// The file is the first that exists of:
//   $HERDR_SUBAGENTS_CONFIG                         (explicit path; nothing else is tried)
//   $OPENCODE_CONFIG_DIR/herdr-subagents-pane.json
//   ${XDG_CONFIG_HOME:-~/.config}/opencode/herdr-subagents-pane.json
//
// Pure apart from the injected readFile, so it is easy to test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_FILE_NAME = "herdr-subagents-pane.json";

/** File keys and their defaults (seconds in the file; the resolved config uses ms). */
export const DEFAULTS = Object.freeze({
  enabled: true,
  autoClose: true,
  closeDelaySeconds: 20,
  settleSeconds: 3,
  maxPanes: 4,
  summary: true,
  debugLog: null,
});

const isBool = (v) => typeof v === "boolean";
const isSeconds = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isPaneCount = (v) => Number.isInteger(v) && v >= 1;
const isPathOrNull = (v) => v === null || (typeof v === "string" && v.length > 0);

const FILE_KEYS = {
  enabled: [isBool, "true or false"],
  autoClose: [isBool, "true or false"],
  closeDelaySeconds: [isSeconds, "a number of seconds (0 or more)"],
  settleSeconds: [isSeconds, "a number of seconds (0 or more)"],
  maxPanes: [isPaneCount, "a whole number, 1 or more"],
  summary: [isBool, "true or false"],
  debugLog: [isPathOrNull, "a file path or null"],
};

function parseBool(raw) {
  const s = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return undefined;
}

function parseMs(raw) {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return undefined;
  return Number(s) / 1000;
}

function parseCount(raw) {
  const s = raw.trim();
  return /^\d+$/.test(s) && Number(s) >= 1 ? Number(s) : undefined;
}

/** Environment overrides: variable -> [file key, parser, expected]. */
const ENV_KEYS = {
  HERDR_SUBAGENTS_ENABLED: ["enabled", parseBool, "1 or 0"],
  HERDR_SUBAGENTS_AUTO_CLOSE: ["autoClose", parseBool, "1 or 0"],
  HERDR_SUBAGENTS_CLOSE_DELAY_MS: ["closeDelaySeconds", parseMs, "milliseconds"],
  HERDR_SUBAGENTS_SETTLE_MS: ["settleSeconds", parseMs, "milliseconds"],
  HERDR_SUBAGENTS_MAX_PANES: ["maxPanes", parseCount, "a whole number, 1 or more"],
  HERDR_SUBAGENTS_SUMMARY: ["summary", parseBool, "1 or 0"],
  HERDR_SUBAGENTS_DEBUG: ["debugLog", (raw) => raw || undefined, "a file path"],
};

/** Candidate config file paths, in order. */
export function configPaths(env = process.env, home = os.homedir()) {
  if (env.HERDR_SUBAGENTS_CONFIG) return [env.HERDR_SUBAGENTS_CONFIG];
  const paths = [];
  if (env.OPENCODE_CONFIG_DIR) paths.push(path.join(env.OPENCODE_CONFIG_DIR, CONFIG_FILE_NAME));
  const base = env.XDG_CONFIG_HOME || path.join(home, ".config");
  paths.push(path.join(base, "opencode", CONFIG_FILE_NAME));
  return paths;
}

/**
 * Resolve settings. Invalid values are ignored (the default or file value is
 * kept) and reported in `warnings`; nothing here throws.
 * @returns {{ config: { enabled: boolean, autoClose: boolean, closeDelayMs: number,
 *   settleMs: number, maxPanes: number, summary: boolean, debugLog: string|null },
 *   source: string|null, warnings: string[] }}
 */
export function loadConfig({ env = process.env, home = os.homedir(), readFile = (p) => fs.readFileSync(p, "utf8") } = {}) {
  const values = { ...DEFAULTS };
  const warnings = [];
  let source = null;

  const explicit = Boolean(env.HERDR_SUBAGENTS_CONFIG);
  for (const file of configPaths(env, home)) {
    let raw;
    try {
      raw = readFile(file);
    } catch (err) {
      if (explicit || err?.code !== "ENOENT") warnings.push(`${file}: can't read it (${err?.code ?? err}); using defaults`);
      continue;
    }
    source = file;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      warnings.push(`${file}: not valid JSON (${err.message}); using defaults`);
      break;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      warnings.push(`${file}: expected a JSON object; using defaults`);
      break;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith("$")) continue; // e.g. "$schema"
      const rule = FILE_KEYS[key];
      if (!rule) {
        warnings.push(`${file}: unknown setting "${key}"`);
        continue;
      }
      const [valid, expected] = rule;
      if (valid(value)) values[key] = value;
      else warnings.push(`${file}: "${key}" should be ${expected}; using ${JSON.stringify(values[key])}`);
    }
    break;
  }

  for (const [name, [key, parse, expected]] of Object.entries(ENV_KEYS)) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const value = parse(raw);
    if (value === undefined) warnings.push(`${name}=${raw}: should be ${expected}; ignored`);
    else values[key] = value;
  }

  return {
    config: {
      enabled: values.enabled,
      autoClose: values.autoClose,
      closeDelayMs: Math.round(values.closeDelaySeconds * 1000),
      settleMs: Math.round(values.settleSeconds * 1000),
      maxPanes: values.maxPanes,
      summary: values.summary,
      debugLog: values.debugLog,
    },
    source,
    warnings,
  };
}
