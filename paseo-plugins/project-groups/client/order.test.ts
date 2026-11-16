import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLayout, type SidebarProject } from "./groups.ts";
import {
  compareOrdered,
  entryId,
  moveItem,
  moveSibling,
  orderIndex,
  siblingMoves,
} from "./order.ts";

const projects: SidebarProject[] = [
  { key: "a", name: "alpha" },
  { key: "b", name: "work/beta" },
  { key: "c", name: "gamma" },
  { key: "d", name: "work/aws/delta" },
  { key: "e", name: "work/epsilon" },
];

function layoutFor(order: readonly string[], collapsed: Set<string> = new Set()) {
  const byKey = new Map(projects.map((project) => [project.key, project]));
  return buildLayout(
    order.map((key) => byKey.get(key)!),
    {},
    collapsed,
  );
}

function rows(order: readonly string[]) {
  return layoutFor(order).map((entry) => `${"  ".repeat(entry.depth)}${entryId(entry)}`);
}

describe("compareOrdered", () => {
  it("puts ordered keys first, then falls back", () => {
    const index = orderIndex(["c", "a"]);
    const sorted = ["a", "b", "c", "d"].sort((x, y) =>
      compareOrdered(index, x, y, x.localeCompare(y)),
    );
    assert.deepEqual(sorted, ["c", "a", "b", "d"]);
  });
});

describe("moveSibling", () => {
  const order = ["a", "b", "c", "d", "e"];

  it("swaps a project with the group above it, keeping the group whole", () => {
    assert.deepEqual(rows(order), [
      "project:a",
      "group:work",
      "  project:b",
      "  group:work/aws",
      "    project:d",
      "  project:e",
      "project:c",
    ]);
    const next = moveSibling(layoutFor(order), "project:c", -1, order);
    assert.deepEqual(next, ["a", "c", "b", "d", "e"]);
    assert.deepEqual(rows(next!), [
      "project:a",
      "project:c",
      "group:work",
      "  project:b",
      "  group:work/aws",
      "    project:d",
      "  project:e",
    ]);
  });

  it("moves a group with everything in it", () => {
    assert.deepEqual(moveSibling(layoutFor(order), "group:work", -1, order), [
      "b",
      "d",
      "e",
      "a",
      "c",
    ]);
  });

  it("moves within a group only", () => {
    assert.deepEqual(moveSibling(layoutFor(order), "group:work/aws", 1, order), [
      "a",
      "b",
      "e",
      "d",
      "c",
    ]);
    assert.equal(moveSibling(layoutFor(order), "project:b", -1, order), null);
  });

  it("moves collapsed groups and keeps keys of projects not shown", () => {
    const layout = layoutFor(order, new Set(["work"]));
    assert.deepEqual(moveSibling(layout, "project:a", 1, [...order, "gone"]), [
      "b",
      "d",
      "e",
      "a",
      "c",
      "gone",
    ]);
  });
});

describe("siblingMoves", () => {
  it("reports which rows can move up and down", () => {
    const moves = siblingMoves(layoutFor(["a", "b", "c", "d", "e"]));
    assert.deepEqual(moves.get("project:a"), { up: false, down: true });
    assert.deepEqual(moves.get("group:work"), { up: true, down: true });
    assert.deepEqual(moves.get("project:c"), { up: true, down: false });
    assert.deepEqual(moves.get("project:b"), { up: false, down: true });
    assert.deepEqual(moves.get("project:d"), { up: false, down: false });
    assert.deepEqual(moves.get("project:e"), { up: true, down: false });
  });
});

describe("moveItem", () => {
  it("swaps with a neighbour", () => {
    assert.deepEqual(moveItem(["x", "y", "z"], "z", -1), ["x", "z", "y"]);
    assert.equal(moveItem(["x", "y"], "x", -1), null);
    assert.equal(moveItem(["x"], "missing", 1), null);
  });
});
