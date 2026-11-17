// The compact "last interaction" label of a workspace row, worded as Paseo's sidebar words it
// (`describeCompactTimeAgo` in Paseo's app): "now" under a minute, then minutes, hours and days,
// and the date itself after a week.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export function compactTimeAgo(date: Date, now: Date): string {
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  if (elapsed < WEEK_MS) return `${Math.floor(elapsed / DAY_MS)}d`;
  return `${date.toLocaleDateString("en-US", { month: "short" })} ${date.getDate()}`;
}

/** Milliseconds until the label of `date` can next change, or null once it is a date. */
export function nextTimeAgoChange(date: Date, now: Date): number | null {
  const elapsed = now.getTime() - date.getTime();
  if (elapsed >= WEEK_MS) return null;
  const step = elapsed < HOUR_MS ? MINUTE_MS : elapsed < DAY_MS ? HOUR_MS : DAY_MS;
  return step - (Math.max(0, elapsed) % step);
}
