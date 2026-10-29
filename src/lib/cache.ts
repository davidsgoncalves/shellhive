import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useStore, type CacheStyle } from "./store";
import { isBeeTab, type Tab } from "./types";

/** Context below this size costs little either way, so its tab shows no card. */
export const CACHE_CARD_MIN_TOKENS = 50_000;
/** Height the cache takes over a terminal, in pixels, for each style. */
export const CACHE_CARD_HEIGHT: Record<CacheStyle, number> = { expressive: 50, minimal: 0 };

/** The prompt cache left by a session's last request. */
export interface CacheInfo {
  /** When the cache was last written or read, in ms. */
  at: number;
  /** How long it lives after that, in ms. */
  ttl: number;
  tokens: number;
}

interface CacheStore {
  byTab: Record<string, CacheInfo>;
  put: (tabId: string, info: CacheInfo | null) => void;
}

export const useCache = create<CacheStore>()((set) => ({
  byTab: {},
  put: (tabId, info) =>
    set((s) => {
      const byTab = { ...s.byTab };
      if (info) byTab[tabId] = info;
      else delete byTab[tabId];
      return { byTab };
    }),
}));

/** Reads the tab's transcript again; called when a turn starts or ends. */
export async function refreshCache(tabId: string): Promise<void> {
  const tab = useStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab?.transcriptPath) return;
  const raw = await invoke<{ at: string; ttl: number; tokens: number } | null>("session_cache", {
    path: tab.transcriptPath,
  }).catch(() => null);
  const at = raw ? Date.parse(raw.at) : NaN;
  useCache.getState().put(tabId, raw && !Number.isNaN(at) ? { at, ttl: raw.ttl * 1000, tokens: raw.tokens } : null);
}

/** Delays of the reads after a turn ends; the reply can reach the transcript after the hook. */
const LATE_READS_MS = [1500, 5000, 15000];

/** Reads the cache now and a few times more, for a turn that just ended. */
export function refreshCacheAfterTurn(tabId: string): void {
  void refreshCache(tabId);
  for (const ms of LATE_READS_MS) setTimeout(() => void refreshCache(tabId), ms);
}

/** The cache a tab's card shows: a session waiting on the user, with context worth keeping. */
export function cacheCardOf(tab: Tab, byTab: Record<string, CacheInfo>): CacheInfo | null {
  const info = byTab[tab.id];
  if (!info || tab.state !== "waiting" || isBeeTab(tab) || info.tokens < CACHE_CARD_MIN_TOKENS) return null;
  return info;
}
