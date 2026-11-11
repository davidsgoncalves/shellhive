import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { useStore } from "./store";
import type { ChatEntry } from "./types";

interface StartInfo {
  thread_id: string;
  model: string;
  models: string[];
}

/** Chat entries of each Codex tab, as the app-server reports them. Not saved: a resumed thread brings its history back. */
export const useAgentEntries = create<{ byTab: Record<string, ChatEntry[]> }>(() => ({ byTab: {} }));

/**
 * Adds entries to a tab's chat. An entry with the kind and id of one already
 * there replaces it, so streamed text and a step's result update in place.
 */
export function pushEntries(tabId: string, entries: ChatEntry[]): void {
  useAgentEntries.setState((s) => {
    const list = [...(s.byTab[tabId] ?? [])];
    for (const e of entries) {
      const at = list.findIndex((x) => x.kind === e.kind && x.id === e.id);
      if (at === -1) list.push(e);
      else list[at] = e;
    }
    return { byTab: { ...s.byTab, [tabId]: list } };
  });
}

/** Models each Codex tab can switch to, from its app-server. */
export const useCodexModels = create<{ byTab: Record<string, string[]> }>(() => ({ byTab: {} }));

const started = new Set<string>();

/** Starts the Codex app-server of a tab, resuming its thread when it has one. */
export async function startCodex(tabId: string): Promise<void> {
  const tab = useStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab || tab.provider !== "codex" || started.has(tabId)) return;
  started.add(tabId);
  try {
    const info = await invoke<StartInfo>("codex_start", {
      tabId,
      cwd: tab.cwd ?? ".",
      threadId: tab.codexThreadId ?? null,
      model: tab.codexModel ?? null,
    });
    useStore.getState().patchTab(tabId, { codexThreadId: info.thread_id, codexModel: info.model });
    useCodexModels.setState((s) => ({ byTab: { ...s.byTab, [tabId]: info.models } }));
  } catch (err) {
    started.delete(tabId);
    pushEntries(tabId, [{ kind: "error", id: `start:${Date.now()}`, text: `O Codex não abriu: ${String(err)}` }]);
  }
}

export function stopCodex(tabId: string): void {
  started.delete(tabId);
  useAgentEntries.setState((s) => {
    const { [tabId]: _gone, ...byTab } = s.byTab;
    return { byTab };
  });
  void invoke("codex_stop", { tabId }).catch(() => {});
}

/**
 * Keeps each live Codex tab's app-server running and its chat fed. A tab
 * restored dormant starts when it wakes; a closed tab stops its process.
 */
export function watchCodexTabs(): () => void {
  const sync = () => {
    const tabs = useStore.getState().tabs;
    for (const t of tabs) if (t.provider === "codex" && t.state !== "dormant") void startCodex(t.id);
    for (const id of started) if (!tabs.some((t) => t.id === id && t.state !== "dormant")) stopCodex(id);
  };
  sync();
  const unsub = useStore.subscribe(sync);
  const sub = listen<{ tab_id: string; entries: ChatEntry[] }>("agent-entries", (ev) =>
    pushEntries(ev.payload.tab_id, ev.payload.entries),
  );
  return () => {
    unsub();
    void sub.then((u) => u());
  };
}
