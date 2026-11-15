import { expect, test } from "bun:test";
import { isAlive } from "../plugin/watchdog.js";

test("isAlive: a missing process is gone, EPERM still counts as alive", () => {
  expect(isAlive(process.pid)).toBe(true);
  const fail = (code) => () => { throw Object.assign(new Error(code), { code }); };
  expect(isAlive(123, fail("ESRCH"))).toBe(false);
  expect(isAlive(123, fail("EPERM"))).toBe(true);
});
