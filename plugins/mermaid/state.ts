import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface Diagram {
  id: string;
  tabId: string | null;
  /** The tab's title when it was made, for when the tab is gone. */
  tabTitle: string;
  title: string;
  source: string;
  /** Milliseconds since the epoch. */
  at: number;
}

const PLUGIN_ID = "mermaid";
/** Oldest ones are dropped past this. */
const KEEP = 50;

interface DiagramStore {
  diagrams: Diagram[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (d: Diagram) => Promise<void>;
  update: (id: string, source: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const save = (diagrams: Diagram[]) =>
  invoke("plugin_storage_set", { id: PLUGIN_ID, value: { diagrams } }).catch((err) =>
    console.error("diagram save failed", err),
  );

/** Every diagram the agent made, newest first, kept across restarts. */
export const useDiagrams = create<DiagramStore>()((set, get) => {
  const change = async (next: (list: Diagram[]) => Diagram[]) => {
    await get().load();
    const diagrams = next(get().diagrams).slice(0, KEEP);
    set({ diagrams });
    await save(diagrams);
  };
  let loading: Promise<void> | null = null;
  return {
    diagrams: [],
    loaded: false,
    load: () =>
      (loading ??= invoke<{ diagrams?: Diagram[] } | null>("plugin_storage_get", { id: PLUGIN_ID })
        .then((stored) => set({ diagrams: Array.isArray(stored?.diagrams) ? stored.diagrams : [], loaded: true }))
        .catch(() => set({ loaded: true }))),
    add: (d) => change((list) => [d, ...list]),
    update: (id, source) => change((list) => list.map((d) => (d.id === id ? { ...d, source } : d))),
    remove: (id) => change((list) => list.filter((d) => d.id !== id)),
  };
});
