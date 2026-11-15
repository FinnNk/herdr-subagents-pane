// Even sizing for viewer panes: works out the `herdr pane resize` calls that
// give every column the same width and every stacked card the same height.
//
// herdr only reports splits (direction, ratio, rect) and pane rects, so each
// split's two sides are recovered from geometry. Only splits whose panes are
// all viewer panes are touched; the orchestrator's share, the summary strip and
// other plugins' panes (e.g. a sidebar) keep their sizes. Ratios are relative
// to their split, so the resizes are independent of each other.
//
// herdr's `pane resize` moves the edge on the given side of a pane by `amount`
// and ignores its sign, so growing a split's first side is "right"/"down" from
// a first-side pane, and shrinking it is "left"/"up" from a second-side pane.

const inside = (r, R) => r.x >= R.x && r.y >= R.y && r.x + r.width <= R.x + R.width && r.y + r.height <= R.y + R.height;

/**
 * @param {{ splits: {direction: "right"|"down", ratio: number, rect: object}[],
 *           panes: {pane_id: string, rect: object}[] }} layout  from `herdr pane layout`
 * @param {Set<string>|string[]} managed  viewer pane ids
 * @param {number} [tolerance] ignore ratio differences smaller than this
 * @returns {{ paneId: string, direction: "right"|"down"|"left"|"up", amount: number }[]}  amount > 0
 */
export function rebalanceActions(layout, managed, tolerance = 0.02) {
  const ours = managed instanceof Set ? managed : new Set(managed);
  const actions = [];
  const splits = [...(layout?.splits ?? [])].sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
  for (const s of splits) {
    const R = s.rect;
    const within = (layout.panes ?? []).filter((p) => inside(p.rect, R));
    if (within.length < 2 || !within.every((p) => ours.has(p.pane_id))) continue;
    const right = s.direction === "right";
    const boundary = right ? R.x + R.width * s.ratio : R.y + R.height * s.ratio;
    const centre = (p) => (right ? p.rect.x + p.rect.width / 2 : p.rect.y + p.rect.height / 2);
    const first = within.filter((p) => centre(p) < boundary);
    const second = within.filter((p) => centre(p) >= boundary);
    if (!first.length || !second.length) continue;
    // Columns (or rows) on each side: distinct starting positions.
    const units = (ps) => new Set(ps.map((p) => (right ? p.rect.x : p.rect.y))).size;
    const target = units(first) / (units(first) + units(second));
    if (Math.abs(target - s.ratio) < tolerance) continue;
    // Resize from a pane that touches the boundary, so herdr moves this split.
    const delta = Number((target - s.ratio).toFixed(4));
    if (delta > 0) {
      const far = (p) => (right ? p.rect.x + p.rect.width : p.rect.y + p.rect.height);
      const mover = first.reduce((a, b) => (far(b) > far(a) ? b : a));
      actions.push({ paneId: mover.pane_id, direction: right ? "right" : "down", amount: delta });
    } else {
      const near = (p) => (right ? p.rect.x : p.rect.y);
      const mover = second.reduce((a, b) => (near(b) < near(a) ? b : a));
      actions.push({ paneId: mover.pane_id, direction: right ? "left" : "up", amount: -delta });
    }
  }
  return actions;
}
