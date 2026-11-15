import { describe, expect, test } from "bun:test";
import { rebalanceActions } from "../plugin/layout.js";

const rect = (x, y, width, height) => ({ x, y, width, height });

describe("rebalanceActions", () => {
  // Captured from herdr: sidebar | orchestrator (1/3) | A | B | C, where C was split off B.
  const threeColumns = {
    splits: [
      { direction: "right", ratio: 0.187, rect: rect(0, 0, 171, 62) }, // sidebar | rest
      { direction: "right", ratio: 0.333, rect: rect(32, 0, 139, 62) }, // orchestrator | columns
      { direction: "right", ratio: 0.5, rect: rect(78, 0, 93, 62) }, // A | (B | C)
      { direction: "right", ratio: 0.5, rect: rect(125, 0, 46, 62) }, // B | C
    ],
    panes: [
      { pane_id: "side", rect: rect(0, 0, 32, 62) },
      { pane_id: "orch", rect: rect(32, 0, 46, 62) },
      { pane_id: "A", rect: rect(78, 0, 47, 62) },
      { pane_id: "B", rect: rect(125, 0, 23, 62) },
      { pane_id: "C", rect: rect(148, 0, 23, 62) },
    ],
  };

  test("three columns get a third each; sidebar and orchestrator untouched", () => {
    // Shrink A's side: move the boundary left, from B (the pane just right of it).
    expect(rebalanceActions(threeColumns, ["A", "B", "C"])).toEqual([{ paneId: "B", direction: "left", amount: 0.1667 }]);
  });

  test("a stacked column gets equal heights", () => {
    // A over (B over C): herdr's default 0.5 splits give 1/2, 1/4, 1/4.
    const layout = {
      splits: [
        { direction: "right", ratio: 0.333, rect: rect(0, 0, 120, 60) },
        { direction: "down", ratio: 0.5, rect: rect(40, 0, 80, 60) },
        { direction: "down", ratio: 0.5, rect: rect(40, 30, 80, 30) },
      ],
      panes: [
        { pane_id: "orch", rect: rect(0, 0, 40, 60) },
        { pane_id: "A", rect: rect(40, 0, 80, 30) },
        { pane_id: "B", rect: rect(40, 30, 80, 15) },
        { pane_id: "C", rect: rect(40, 45, 80, 15) },
      ],
    };
    expect(rebalanceActions(layout, ["A", "B", "C"])).toEqual([{ paneId: "B", direction: "up", amount: 0.1667 }]);
  });

  test("columns of different heights: widths by column count, heights within each column", () => {
    // (A over B) | (C over D over E), the restacked cipher layout with an extra solver.
    const layout = {
      splits: [
        { direction: "right", ratio: 0.5, rect: rect(0, 0, 100, 60) },
        { direction: "down", ratio: 0.5, rect: rect(0, 0, 50, 60) },
        { direction: "down", ratio: 0.5, rect: rect(50, 0, 50, 60) },
        { direction: "down", ratio: 0.5, rect: rect(50, 30, 50, 30) },
      ],
      panes: [
        { pane_id: "A", rect: rect(0, 0, 50, 30) },
        { pane_id: "B", rect: rect(0, 30, 50, 30) },
        { pane_id: "C", rect: rect(50, 0, 50, 30) },
        { pane_id: "D", rect: rect(50, 30, 50, 15) },
        { pane_id: "E", rect: rect(50, 45, 50, 15) },
      ],
    };
    expect(rebalanceActions(layout, ["A", "B", "C", "D", "E"])).toEqual([{ paneId: "D", direction: "up", amount: 0.1667 }]);
  });

  test("a two-row overflow grid evens out each row", () => {
    const layout = {
      splits: [
        { direction: "down", ratio: 0.5, rect: rect(0, 0, 120, 60) },
        { direction: "right", ratio: 0.5, rect: rect(0, 0, 120, 30) },
        { direction: "right", ratio: 0.5, rect: rect(60, 0, 60, 30) },
        { direction: "right", ratio: 0.5, rect: rect(0, 30, 120, 30) },
      ],
      panes: [
        { pane_id: "1", rect: rect(0, 0, 60, 30) },
        { pane_id: "3", rect: rect(60, 0, 30, 30) },
        { pane_id: "5", rect: rect(90, 0, 30, 30) },
        { pane_id: "2", rect: rect(0, 30, 60, 30) },
        { pane_id: "4", rect: rect(60, 30, 60, 30) },
      ],
    };
    expect(rebalanceActions(layout, ["1", "2", "3", "4", "5"])).toEqual([{ paneId: "3", direction: "left", amount: 0.1667 }]);
  });

  test("growing the first side resizes from a first-side pane, rightwards", () => {
    // A (1/4) | B | C (3/4 for two columns): A should get 1/3.
    const layout = {
      splits: [
        { direction: "right", ratio: 0.25, rect: rect(0, 0, 120, 10) },
        { direction: "right", ratio: 0.5, rect: rect(30, 0, 90, 10) },
      ],
      panes: [
        { pane_id: "A", rect: rect(0, 0, 30, 10) },
        { pane_id: "B", rect: rect(30, 0, 45, 10) },
        { pane_id: "C", rect: rect(75, 0, 45, 10) },
      ],
    };
    expect(rebalanceActions(layout, ["A", "B", "C"])).toEqual([{ paneId: "A", direction: "right", amount: 0.0833 }]);
  });

  test("nothing to do when already even or when other panes are involved", () => {
    const even = {
      splits: [{ direction: "right", ratio: 0.5, rect: rect(0, 0, 100, 10) }],
      panes: [
        { pane_id: "A", rect: rect(0, 0, 50, 10) },
        { pane_id: "B", rect: rect(50, 0, 50, 10) },
      ],
    };
    expect(rebalanceActions(even, ["A", "B"])).toEqual([]);
    expect(rebalanceActions(threeColumns, ["B", "C"])).toEqual([]); // A isn't ours: leave A | (B|C) alone
    expect(rebalanceActions(undefined, [])).toEqual([]);
  });
});
