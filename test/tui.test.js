import { expect, test } from "bun:test";
import { serverFromArgv } from "../plugin/tui.js";

test("serverFromArgv reads --server in both forms and stops at --", () => {
  expect(serverFromArgv(["--server", "http://127.0.0.1:4199"])).toBe("http://127.0.0.1:4199");
  expect(serverFromArgv(["--server=http://h:1", "-s", "x"])).toBe("http://h:1");
  expect(serverFromArgv(["--session", "x"])).toBeUndefined();
  expect(serverFromArgv(["--", "--server", "nope"])).toBeUndefined();
});

