import type { RateLimits, RateWindow, StatusPayload } from "./types";

type ReportedLimits = NonNullable<StatusPayload["rate_limits"]>;

const WINDOWS = ["five_hour", "seven_day", "spend_limit"] as const;

/**
 * Each tab reports the usage from its own last reply, so an idle tab redrawing its
 * statusline resends an old figure. A later window wins, and within one window usage
 * only grows.
 */
function fresher(current: RateWindow | undefined, incoming: RateWindow | undefined): RateWindow | undefined {
  if (!incoming) return current;
  if (!current || incoming.resets_at > current.resets_at) return incoming;
  if (incoming.resets_at < current.resets_at) return current;
  return incoming.used_percentage >= current.used_percentage ? incoming : current;
}

/** The usage shown after a tab's report, or the same object when the report is older. */
export function mergeRateLimits(
  current: RateLimits | null,
  incoming: ReportedLimits,
  receivedAt: number,
  tabId: string | null,
): RateLimits {
  const next: RateLimits = { ...current, receivedAt, fromTabId: tabId };
  let accepted = false;
  for (const key of WINDOWS) {
    const win = fresher(current?.[key], incoming[key]);
    if (win) next[key] = win;
    if (win && win === incoming[key]) accepted = true;
  }
  return accepted || !current ? next : current;
}
