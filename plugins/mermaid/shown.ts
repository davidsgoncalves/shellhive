import { create } from "zustand";
import type { Diagram } from "./state";

interface ShownStore {
  /** The diagram covering each tab's terminal, by tab id. */
  shown: Record<string, Diagram>;
  show: (tabId: string, diagram: Diagram) => void;
  hide: (tabId: string) => void;
}

/** Diagrams open in place of a tab's terminal, until closed. */
export const useShown = create<ShownStore>()((set) => ({
  shown: {},
  show: (tabId, diagram) => set((s) => ({ shown: { ...s.shown, [tabId]: diagram } })),
  hide: (tabId) =>
    set((s) => {
      const { [tabId]: _gone, ...rest } = s.shown;
      return { shown: rest };
    }),
}));
