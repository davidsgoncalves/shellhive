import { create } from "zustand";

export interface Diagram {
  tabId: string | null;
  title: string;
  source: string;
}

/** The diagram on screen; a new one replaces it. Not kept across restarts. */
export const useDiagram = create<{ diagram: Diagram | null; show: (d: Diagram | null) => void }>()((set) => ({
  diagram: null,
  show: (diagram) => set({ diagram }),
}));
