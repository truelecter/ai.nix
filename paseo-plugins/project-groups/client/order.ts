// Pure ordering model for the sidebar's projects, groups and workspaces. The order lives on the
// device as a list of keys; anything missing from it follows by name.

import type { LayoutEntry } from "./groups.ts";

/** Stable id of a layout row, for menus, editors and move controls. */
export function entryId(entry: LayoutEntry): string {
  return entry.kind === "group" ? `group:${entry.path}` : `project:${entry.key}`;
}

export function orderIndex(order: readonly string[]): Map<string, number> {
  return new Map(order.map((key, index) => [key, index]));
}

/** Keys in `index` first, in that order; then the rest by `fallback`. */
export function compareOrdered(
  index: ReadonlyMap<string, number>,
  left: string,
  right: string,
  fallback: number,
): number {
  const a = index.get(left);
  const b = index.get(right);
  if (a !== undefined && b !== undefined) return a - b;
  if (a !== undefined) return -1;
  if (b !== undefined) return 1;
  return fallback;
}

export function compareNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

interface Block {
  start: number;
  end: number;
}

/** The blocks of `index`'s siblings (a row with every row nested under it) and its position. */
function siblingBlocks(
  layout: readonly LayoutEntry[],
  index: number,
): { blocks: Block[]; position: number } {
  const depth = layout[index].depth;
  let first = index;
  while (first > 0 && layout[first - 1].depth >= depth) first -= 1;
  const blocks: Block[] = [];
  let position = -1;
  for (let at = first; at < layout.length && layout[at].depth >= depth; at++) {
    if (layout[at].depth !== depth) continue;
    const previous = blocks.at(-1);
    if (previous) previous.end = at;
    if (at === index) position = blocks.length;
    blocks.push({ start: at, end: layout.length });
  }
  const last = blocks.at(-1);
  if (last) {
    let end = last.start + 1;
    while (end < layout.length && layout[end].depth > depth) end += 1;
    last.end = end;
  }
  return { blocks, position };
}

function projectKeys(layout: readonly LayoutEntry[], block: Block): string[] {
  return layout
    .slice(block.start, block.end)
    .flatMap((entry) => (entry.kind === "project" ? [entry.key] : []));
}

/** For every row: whether it has a sibling above and below to swap with. */
export function siblingMoves(
  layout: readonly LayoutEntry[],
): Map<string, { up: boolean; down: boolean }> {
  const moves = new Map<string, { up: boolean; down: boolean }>();
  layout.forEach((entry, index) => {
    const { blocks, position } = siblingBlocks(layout, index);
    moves.set(entryId(entry), { up: position > 0, down: position < blocks.length - 1 });
  });
  return moves;
}

/**
 * The project order after swapping row `id` (a group moves with everything in it) with its
 * sibling above (-1) or below (1). Keys of projects not shown now keep their place at the end.
 * Null when there is no such sibling.
 */
export function moveSibling(
  layout: readonly LayoutEntry[],
  id: string,
  direction: -1 | 1,
  previousOrder: readonly string[],
): string[] | null {
  const index = layout.findIndex((entry) => entryId(entry) === id);
  if (index < 0) return null;
  const { blocks, position } = siblingBlocks(layout, index);
  const other = blocks[position + direction];
  if (!other) return null;
  const [upper, lower] = direction < 0 ? [other, blocks[position]] : [blocks[position], other];
  const before = layout.slice(0, upper.start);
  const after = layout.slice(lower.end);
  const keys = [
    ...projectKeys(before, { start: 0, end: before.length }),
    ...projectKeys(layout, lower),
    ...projectKeys(layout, { start: upper.end, end: lower.start }),
    ...projectKeys(layout, upper),
    ...projectKeys(after, { start: 0, end: after.length }),
  ];
  const shown = new Set(keys);
  return [...keys, ...previousOrder.filter((key) => !shown.has(key))];
}

/** `keys` with `key` swapped with its neighbour above (-1) or below (1); null at either end. */
export function moveItem(keys: readonly string[], key: string, direction: -1 | 1): string[] | null {
  const index = keys.indexOf(key);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= keys.length) return null;
  const next = [...keys];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
