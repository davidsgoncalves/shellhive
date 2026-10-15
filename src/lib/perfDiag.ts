import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { terminals } from "./terminals";

/**
 * How late the interface answers. A one-second timer that fires late means
 * the page was busy; each 30-second window keeps its worst and average delay,
 * for the last 30 minutes, to go with the process history the backend keeps.
 */
interface LagWindow {
  at: number;
  maxMs: number;
  avgMs: number;
}

const TICK_MS = 1000;
const WINDOW_TICKS = 30;
const KEEP = 60;
const windows: LagWindow[] = [];
let started = false;

export function startLagTracker(): void {
  if (started) return;
  started = true;
  let last = performance.now();
  let delays: number[] = [];
  setInterval(() => {
    const now = performance.now();
    delays.push(Math.max(0, now - last - TICK_MS));
    last = now;
    if (delays.length < WINDOW_TICKS) return;
    windows.push({
      at: Math.round(Date.now() / 1000),
      maxMs: Math.round(Math.max(...delays)),
      avgMs: Math.round(delays.reduce((a, b) => a + b, 0) / delays.length),
    });
    if (windows.length > KEEP) windows.shift();
    delays = [];
  }, TICK_MS);
}

/** What the interface knows about itself: no titles, paths or terminal text. */
function interfaceState(version: string) {
  const s = useStore.getState();
  let scrollback = 0;
  for (const term of terminals.values()) scrollback += term.buffer.active.length;
  return {
    version,
    theme: s.theme,
    vibrancy: document.documentElement.dataset.vibrancy ?? "off",
    hidden: document.documentElement.dataset.hidden === "on",
    layout: s.layout,
    splitMode: s.splitMode,
    tabs: s.tabs.length,
    liveTabs: s.tabs.filter((t) => t.state !== "dormant").length,
    terminals: terminals.size,
    detached: s.detached.length,
    scrollbackLines: scrollback,
    officialPlugins: s.enabledPlugins,
    localPlugins: s.localPlugins.filter((p) => p.status === "approved" && s.enabledPlugins.includes(p.id)).length,
    devicePixelRatio: window.devicePixelRatio,
    screen: `${window.innerWidth}x${window.innerHeight}`,
    lag: windows,
  };
}

/** Sends the diagnostic and returns the Sentry event id. */
export function sendPerfReport(version: string): Promise<string> {
  return invoke<string>("perf_report", { ui: interfaceState(version) });
}
