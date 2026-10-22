import type { Tab } from "./types";

/**
 * Claude Code redraws its spinner several times a second for as long as a
 * turn runs, tools included, and prints nothing once it stops. No hook
 * reports a turn cut short with Esc (Stop does not run then), so a tab still
 * marked working whose terminal and hooks have been quiet this long is idle.
 */
export const QUIET_MS = 15_000;

/** When each tab's terminal last printed anything. */
const lastOutput = new Map<string, number>();

export function noteOutput(tabId: string): void {
  lastOutput.set(tabId, Date.now());
}

export function forgetOutput(tabId: string): void {
  lastOutput.delete(tabId);
}

/** Tabs marked working that have printed nothing and sent no hook for QUIET_MS. */
export function quietWorkingTabs(tabs: Tab[], now = Date.now()): Tab[] {
  return tabs.filter(
    (t) => t.state === "working" && now - Math.max(lastOutput.get(t.id) ?? 0, t.lastEventAt ?? 0) > QUIET_MS,
  );
}
