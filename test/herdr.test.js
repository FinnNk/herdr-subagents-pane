import { expect, test } from "bun:test";
import { herdrState } from "../plugin/herdr.js";

test("card statuses map to herdr agent states", () => {
  expect(["starting", "working", "working (run 3)"].map(herdrState)).toEqual(["working", "working", "working"]);
  expect(herdrState("needs input")).toBe("blocked");
  expect(["waiting", "done", "done, closing in 20s"].map(herdrState)).toEqual(["idle", "idle", "idle"]);
});
