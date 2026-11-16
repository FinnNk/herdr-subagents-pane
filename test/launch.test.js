import { describe, expect, test } from "bun:test";
import { ARGS_ENV, launchArgs, paneLaunch } from "../plugin/launch.js";

describe("paneLaunch", () => {
  test("POSIX: bare names, exec, binary directory first on PATH", () => {
    const l = paneLaunch({
      bin: "/home/me/.opencode/bin/opencode",
      script: "/home/me/my plugins/hsp/plugin/card.js",
      args: { state: "/run/it's here.json", owner: 12, server: undefined },
      platform: "linux",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(l.command).toBe("exec opencode card.js");
    expect(l.cwd).toBe("/home/me/my plugins/hsp/plugin");
    expect(l.env.BUN_BE_BUN).toBe("1");
    expect(l.env.PATH).toBe("/home/me/.opencode/bin:/usr/bin:/bin");
    expect(JSON.parse(l.env[ARGS_ENV])).toEqual({ state: "/run/it's here.json", owner: "12" });
  });

  test("Windows: no exec, .exe dropped, the environment's own Path spelling", () => {
    const l = paneLaunch({
      bin: "C:\\Users\\A B\\.opencode\\bin\\opencode.exe",
      script: "C:\\Users\\A B\\hsp\\plugin\\summary.js",
      args: { state: "C:\\Temp\\s.json" },
      platform: "win32",
      env: { Path: "C:\\Windows;C:\\Windows\\System32" },
    });
    expect(l.command).toBe("opencode summary.js");
    expect(l.cwd).toBe("C:\\Users\\A B\\hsp\\plugin");
    expect(l.env.Path).toBe("C:\\Users\\A B\\.opencode\\bin;C:\\Windows;C:\\Windows\\System32");
    expect(l.env.PATH).toBeUndefined();
  });

  test("a bare binary name stays on the existing PATH; odd names fall back to opencode", () => {
    expect(paneLaunch({ bin: "opencode", script: "/p/card.js", args: {}, platform: "darwin", env: { PATH: "/x" } }).env.PATH).toBeUndefined();
    expect(paneLaunch({ bin: "/o/open code", script: "/p/card.js", args: {}, platform: "linux", env: {} }).command).toBe("exec opencode card.js");
  });
});

describe("launchArgs", () => {
  test("reads the pane environment, with command-line flags taking precedence", () => {
    const env = { [ARGS_ENV]: JSON.stringify({ state: "/a.json", owner: "5" }) };
    expect(launchArgs([], env)).toEqual({ state: "/a.json", owner: "5" });
    expect(launchArgs(["--state", "/b.json"], env)).toEqual({ state: "/b.json", owner: "5" });
    expect(launchArgs(["--state", "/c.json"], {})).toEqual({ state: "/c.json" });
    expect(launchArgs([], { [ARGS_ENV]: "not json" })).toEqual({});
  });
});
