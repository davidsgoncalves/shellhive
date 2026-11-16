import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { GitInfo } from "./api";

const PLUGIN_ID = "git";

/** A worktree created from the plugin, remembered so it can be offered for removal. */
export interface CreatedWorktree {
  root: string;
  repo: string;
  branch: string;
  base: string | null;
  tabId: string | null;
  tabTitle: string;
  at: number;
}

export type Mode = "changes" | "base" | "turns";

/** The panel open over a tab. */
export interface OpenPanel {
  root: string | null;
  mode: Mode;
}

/** A tab that closed leaving worktrees it created. */
export interface CloseOffer {
  tabTitle: string;
  worktrees: CreatedWorktree[];
}

interface GitStore {
  info: Record<string, GitInfo>;
  open: Record<string, OpenPanel>;
  created: CreatedWorktree[];
  loaded: boolean;
  offers: CloseOffer[];
  /** Base chosen per worktree for the comparison view. */
  bases: Record<string, string>;
  setInfo: (tabId: string, info: GitInfo | null) => void;
  show: (tabId: string, patch?: Partial<OpenPanel>) => void;
  hide: (tabId: string) => void;
  load: () => Promise<void>;
  addCreated: (w: CreatedWorktree) => Promise<void>;
  dropCreated: (root: string) => Promise<void>;
  offer: (o: CloseOffer) => void;
  dismissOffer: () => void;
  setBase: (root: string, base: string) => void;
}

const save = (created: CreatedWorktree[], bases: Record<string, string>) =>
  invoke("plugin_storage_set", { id: PLUGIN_ID, value: { created, bases } }).catch((err) =>
    console.error("git plugin save failed", err),
  );

export const useGit = create<GitStore>()((set, get) => {
  let loading: Promise<void> | null = null;
  return {
    info: {},
    open: {},
    created: [],
    loaded: false,
    offers: [],
    bases: {},
    setInfo: (tabId, info) =>
      set((s) => {
        const prev = s.info[tabId];
        if (!info) {
          if (!prev) return s;
          const { [tabId]: _dropped, ...rest } = s.info;
          return { info: rest };
        }
        const same =
          prev &&
          prev.branch === info.branch &&
          prev.added === info.added &&
          prev.removed === info.removed &&
          prev.files === info.files;
        return same ? s : { info: { ...s.info, [tabId]: info } };
      }),
    show: (tabId, patch = {}) =>
      set((s) => ({
        open: { ...s.open, [tabId]: { ...(s.open[tabId] ?? { root: null, mode: "changes" }), ...patch } },
      })),
    hide: (tabId) =>
      set((s) => {
        const { [tabId]: _dropped, ...open } = s.open;
        return { open };
      }),
    load: () =>
      (loading ??= invoke<{ created?: CreatedWorktree[]; bases?: Record<string, string> } | null>(
        "plugin_storage_get",
        { id: PLUGIN_ID },
      )
        .then((stored) =>
          set({
            created: Array.isArray(stored?.created) ? stored.created : [],
            bases: stored?.bases && typeof stored.bases === "object" ? stored.bases : {},
            loaded: true,
          }),
        )
        .catch(() => set({ loaded: true }))),
    addCreated: async (w) => {
      await get().load();
      const created = [w, ...get().created.filter((c) => c.root !== w.root)];
      set({ created });
      await save(created, get().bases);
    },
    dropCreated: async (root) => {
      await get().load();
      const created = get().created.filter((c) => c.root !== root);
      set({ created });
      await save(created, get().bases);
    },
    offer: (o) => set((s) => ({ offers: [...s.offers, o] })),
    dismissOffer: () => set((s) => ({ offers: s.offers.slice(1) })),
    setBase: (root, base) => {
      const bases = { ...get().bases, [root]: base };
      set({ bases });
      void save(get().created, bases);
    },
  };
});
