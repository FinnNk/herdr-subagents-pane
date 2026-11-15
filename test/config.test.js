import { describe, expect, test } from "bun:test";
import { configPaths, loadConfig, makeExclude } from "../plugin/config.js";

const HOME = "/home/u";
const GLOBAL = "/home/u/.config/opencode/herdr-subagents-pane.json";

/** loadConfig with an in-memory file system. */
function load(files = {}, env = {}) {
  return loadConfig({
    env,
    home: HOME,
    readFile: (p) => {
      if (p in files) return files[p];
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
}

describe("configPaths", () => {
  test("OPENCODE_CONFIG_DIR first, then the XDG/global opencode dir", () => {
    expect(configPaths({ OPENCODE_CONFIG_DIR: "/cfg" }, HOME)).toEqual(["/cfg/herdr-subagents-pane.json", GLOBAL]);
    expect(configPaths({ XDG_CONFIG_HOME: "/x" }, HOME)).toEqual(["/x/opencode/herdr-subagents-pane.json"]);
  });

  test("an explicit HERDR_SUBAGENTS_CONFIG is the only candidate", () => {
    expect(configPaths({ HERDR_SUBAGENTS_CONFIG: "/a.json", OPENCODE_CONFIG_DIR: "/cfg" }, HOME)).toEqual(["/a.json"]);
  });
});

describe("loadConfig", () => {
  test("defaults when there is no file", () => {
    expect(load()).toEqual({
      config: {
        enabled: true,
        autoClose: true,
        openDelayMs: 5_000,
        closeDelayMs: 20_000,
        settleMs: 3_000,
        maxPanes: 4,
        summary: true,
        debugLog: null,
        excludeAgents: [],
        excludeTitles: [],
      },
      source: null,
      warnings: [],
    });
  });

  test("reads the file, converting seconds to ms", () => {
    const r = load({ [GLOBAL]: JSON.stringify({ autoClose: false, closeDelaySeconds: 7.5, maxPanes: 6, summary: false, $schema: "x" }) });
    expect(r.source).toBe(GLOBAL);
    expect(r.warnings).toEqual([]);
    expect(r.config).toMatchObject({ autoClose: false, closeDelayMs: 7_500, maxPanes: 6, summary: false });
  });

  test("the first existing file wins", () => {
    const r = load({ "/cfg/herdr-subagents-pane.json": '{"maxPanes": 2}', [GLOBAL]: '{"maxPanes": 9}' }, { OPENCODE_CONFIG_DIR: "/cfg" });
    expect(r.config.maxPanes).toBe(2);
  });

  test("invalid values and unknown keys are ignored with a warning", () => {
    const r = load({ [GLOBAL]: JSON.stringify({ maxPanes: 0, closeDelaySeconds: "soon", colour: "red", enabled: false }) });
    expect(r.config).toMatchObject({ maxPanes: 4, closeDelayMs: 20_000, enabled: false });
    expect(r.warnings).toEqual([
      `${GLOBAL}: "maxPanes" should be a whole number, 1 or more; using 4`,
      `${GLOBAL}: "closeDelaySeconds" should be a number of seconds (0 or more); using 20`,
      `${GLOBAL}: unknown setting "colour"`,
    ]);
  });

  test("broken JSON falls back to defaults with a warning", () => {
    const r = load({ [GLOBAL]: "{ maxPanes: 2 }" });
    expect(r.config.maxPanes).toBe(4);
    expect(r.warnings[0]).toStartWith(`${GLOBAL}: not valid JSON`);
  });

  test("a missing explicit file is reported; a missing default file is not", () => {
    expect(load({}, { HERDR_SUBAGENTS_CONFIG: "/nope.json" }).warnings[0]).toStartWith("/nope.json: can't read it");
    expect(load().warnings).toEqual([]);
  });

  test("environment variables override the file", () => {
    const r = load(
      { [GLOBAL]: JSON.stringify({ maxPanes: 6, autoClose: false, summary: false }) },
      {
        HERDR_SUBAGENTS_MAX_PANES: "3",
        HERDR_SUBAGENTS_AUTO_CLOSE: "on",
        HERDR_SUBAGENTS_CLOSE_DELAY_MS: "30000",
        HERDR_SUBAGENTS_SUMMARY: "1",
        HERDR_SUBAGENTS_DEBUG: "/tmp/log",
      },
    );
    expect(r.config).toMatchObject({ maxPanes: 3, autoClose: true, closeDelayMs: 30_000, summary: true, debugLog: "/tmp/log" });
  });

  test("HERDR_SUBAGENTS_ENABLED=0 turns the plugin off; bad env values are ignored", () => {
    expect(load({}, { HERDR_SUBAGENTS_ENABLED: "0" }).config.enabled).toBe(false);
    const r = load({}, { HERDR_SUBAGENTS_MAX_PANES: "lots" });
    expect(r.config.maxPanes).toBe(4);
    expect(r.warnings).toEqual(["HERDR_SUBAGENTS_MAX_PANES=lots: should be a whole number, 1 or more; ignored"]);
  });

  test("open delay and exclusion lists, with invalid regexes rejected", () => {
    const r = load(
      { [GLOBAL]: JSON.stringify({ openDelaySeconds: 0, excludeAgents: ["explore"], excludeTitles: ["^Echo:", "("] }) },
      { HERDR_SUBAGENTS_OPEN_DELAY_MS: "2500" },
    );
    expect(r.config).toMatchObject({ openDelayMs: 2_500, excludeAgents: ["explore"], excludeTitles: [] });
    expect(r.warnings).toEqual([`${GLOBAL}: "excludeTitles" should be a list of valid regular expressions; using []`]);
  });
});

describe("makeExclude", () => {
  test("matches titles by regex (case-insensitive) and agents by name", () => {
    const agents = { ses_a: "Explore", ses_b: "general" };
    const exclude = makeExclude({ excludeAgents: ["explore"], excludeTitles: ["^echo:"] }, (id) => agents[id]);
    expect(exclude({ id: "ses_a", title: "Research: x" })).toBe(true); // agent
    expect(exclude({ id: "ses_b", title: "Echo: test" })).toBe(true); // title
    expect(exclude({ id: "ses_b", title: "Research: x" })).toBe(false);
    expect(exclude({ id: "ses_unknown" })).toBe(false); // agent not known yet
  });

  test("no lists means nothing is excluded", () => {
    expect(makeExclude({})({ id: "x", title: "anything" })).toBe(false);
  });
});
