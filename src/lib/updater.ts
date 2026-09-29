import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { reportError } from "./errors";
import { useStore } from "./store";

export type Phase = "idle" | "found" | "working" | "ready" | "handed-off" | "restart-failed" | "error";

interface Updater {
  /** Newer version found in the chosen channel. */
  version: string | null;
  phase: Phase;
  progress: number;
  message: string | null;
  /** The top banner was closed; Sobre still offers the update. */
  dismissed: boolean;
  /** Looks for a newer release; resolves to its version, or null when current. */
  look: () => Promise<string | null>;
  install: () => Promise<void>;
  restart: () => Promise<void>;
  dismiss: () => void;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Whether this install follows the beta channel. */
const beta = () => useStore.getState().betaChannel;

/**
 * One update state for the banner and the Sobre tab, so a check made from
 * either one shows up in both. The backend checks the regular or the beta
 * channel, and installs the update bundle, or a .deb for a package install.
 */
export const useUpdater = create<Updater>()((set, get) => ({
  version: null,
  phase: "idle",
  progress: 0,
  message: null,
  dismissed: false,

  look: async () => {
    // A download in progress or a pending restart must not be reset.
    if (get().phase !== "idle" && get().phase !== "found") return get().version;
    const version = await invoke<string | null>("update_check", { beta: beta() });
    if (!version) {
      set({ version: null, phase: "idle" });
      return null;
    }
    set({ version, phase: "found", dismissed: false });
    return version;
  },

  install: async () => {
    set({ phase: "working", progress: 0, dismissed: false });
    const unlisten = await listen<number>("update-progress", (ev) => set({ progress: ev.payload }));
    try {
      const result = await invoke<string>("update_install", { beta: beta() });
      set({ phase: result === "installed" ? "ready" : "handed-off" });
    } catch (err) {
      reportError("update", err);
      set({ phase: "error", message: errorText(err) });
    } finally {
      unlisten();
    }
  },

  // Replacing the bundle can leave the old executable path unusable, so a
  // failed restart says so instead of looking like a dead button.
  restart: async () => {
    try {
      // Reopens the bundle on macOS; falls back to the plugin elsewhere.
      await invoke("restart_app");
    } catch (first) {
      try {
        await relaunch();
      } catch (err) {
        set({ phase: "restart-failed", message: [first, err].map(errorText).join(" · ") });
      }
    }
  },

  dismiss: () => {
    const { phase } = get();
    // Closing an error or a handed-off notice ends it; closing an offer only
    // hides the banner, and Sobre keeps it.
    if (phase === "found" || phase === "ready") set({ dismissed: true });
    else set({ version: null, phase: "idle", message: null, dismissed: false });
  },
}));
