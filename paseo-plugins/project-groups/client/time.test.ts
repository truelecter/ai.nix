import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compactTimeAgo, nextTimeAgoChange } from "./time.ts";

const now = new Date(2026, 10, 17, 12, 0, 0);
const ago = (ms: number) => new Date(now.getTime() - ms);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("compactTimeAgo", () => {
  test("words each step at its boundary", () => {
    assert.equal(compactTimeAgo(ago(59_999), now), "now");
    assert.equal(compactTimeAgo(ago(MINUTE), now), "1m");
    assert.equal(compactTimeAgo(ago(HOUR - 1), now), "59m");
    assert.equal(compactTimeAgo(ago(HOUR), now), "1h");
    assert.equal(compactTimeAgo(ago(DAY - 1), now), "23h");
    assert.equal(compactTimeAgo(ago(DAY), now), "1d");
    assert.equal(compactTimeAgo(ago(7 * DAY - 1), now), "6d");
  });

  test("shows the date after a week", () => {
    assert.equal(compactTimeAgo(new Date(2026, 9, 28, 9, 30), now), "Oct 28");
  });

  test("a clock slightly ahead of the host reads as now", () => {
    assert.equal(compactTimeAgo(new Date(now.getTime() + 5_000), now), "now");
  });
});

describe("nextTimeAgoChange", () => {
  test("wakes when the label changes, and stops once it is a date", () => {
    assert.equal(nextTimeAgoChange(ago(90_000), now), 30_000);
    assert.equal(nextTimeAgoChange(ago(HOUR + 5 * MINUTE), now), 55 * MINUTE);
    assert.equal(nextTimeAgoChange(ago(2 * DAY), now), DAY);
    assert.equal(nextTimeAgoChange(ago(8 * DAY), now), null);
  });
});
