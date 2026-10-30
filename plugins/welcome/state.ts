import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { collect, ymd, type Welcome } from "./collect";

export interface Place {
  name: string;
  latitude: number;
  longitude: number;
}

interface Stored {
  place?: Place | null;
  /** The day, YYYY-MM-DD, the page last opened on its own. */
  shownOn?: string | null;
}

const PLUGIN_ID = "welcome";

interface WelcomeStore {
  place: Place | null;
  shownOn: string | null;
  loaded: boolean;
  data: Welcome | null;
  loading: boolean;
  /** The tab whose terminal the page covers, if any. */
  shownOver: string | null;
  load: () => Promise<void>;
  refresh: () => Promise<Welcome>;
  setPlace: (place: Place) => Promise<void>;
  show: (tabId: string, auto?: boolean) => Promise<void>;
  hide: () => void;
}

const save = (s: Stored) =>
  invoke("plugin_storage_set", { id: PLUGIN_ID, value: s }).catch((err) => console.error("welcome save failed", err));

export const useWelcome = create<WelcomeStore>()((set, get) => {
  let loading: Promise<void> | null = null;
  let refreshing: Promise<Welcome> | null = null;
  const persist = () => save({ place: get().place, shownOn: get().shownOn });
  return {
    place: null,
    shownOn: null,
    loaded: false,
    data: null,
    loading: false,
    shownOver: null,
    load: () =>
      (loading ??= invoke<Stored | null>("plugin_storage_get", { id: PLUGIN_ID })
        .then((s) => set({ place: s?.place ?? null, shownOn: s?.shownOn ?? null, loaded: true }))
        .catch(() => set({ loaded: true }))),
    refresh: () =>
      (refreshing ??= (async () => {
        set({ loading: true });
        try {
          await get().load();
          const data = await collect(get().place);
          set({ data });
          return data;
        } finally {
          set({ loading: false });
          refreshing = null;
        }
      })()),
    setPlace: async (place) => {
      set({ place });
      await persist();
      await get().refresh();
    },
    show: async (tabId, auto = false) => {
      set({ shownOver: tabId });
      if (auto) {
        set({ shownOn: ymd(new Date()) });
        await persist();
      }
      // Older than ten minutes is worth fetching again.
      const data = get().data;
      if (!data || Date.now() - data.at > 10 * 60_000) await get().refresh();
    },
    hide: () => set({ shownOver: null }),
  };
});
