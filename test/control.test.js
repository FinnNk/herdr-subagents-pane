import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listInstances, pickInstance, takeCommands, writeCommand } from "../plugin/control.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hsp-control-"));

describe("command queue", () => {
  test("commands are taken once, oldest first; unknown commands are dropped", () => {
    const dir = tmp();
    writeCommand(dir, { cmd: "toggle" });
    writeCommand(dir, { cmd: "expand", session: "ses_1" });
    writeCommand(dir, { cmd: "rm -rf" });
    expect(takeCommands(dir)).toEqual([{ cmd: "toggle" }, { cmd: "expand", session: "ses_1" }]);
    expect(takeCommands(dir)).toEqual([]);
    expect(takeCommands(path.join(dir, "missing"))).toEqual([]);
  });
});

describe("instances", () => {
  test("lists live instances only", () => {
    const root = tmp();
    for (const [name, pid] of [["a", 11], ["b", 22]]) {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, "instance.json"), JSON.stringify({ pid, pane: `w1:p${pid}`, tab: "w1:t1", startedAt: pid }));
    }
    fs.mkdirSync(path.join(root, "junk"));
    expect(listInstances(root, (pid) => pid === 22).map((i) => i.pid)).toEqual([22]);
  });

  test("picks the instance for the focused pane, then the focused tab, then the newest", () => {
    const a = { pid: 1, pane: "w1:p1", tab: "w1:t1", startedAt: 1 };
    const b = { pid: 2, pane: "w1:p9", tab: "w1:t2", startedAt: 2 };
    expect(pickInstance([a, b], { pane: "w1:p1", tab: "w1:t2" })).toBe(a);
    expect(pickInstance([a, b], { pane: "w1:p5", tab: "w1:t1" })).toBe(a);
    expect(pickInstance([a, b], { pane: "w2:p1", tab: "w2:t1" })).toBe(b);
    expect(pickInstance([], {})).toBeUndefined();
  });
});
