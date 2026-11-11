import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { useStore } from "./store";
import { agentCommand, PROVIDER_NAMES, type Provider } from "./providers";
import type { ChatEntry } from "./types";

interface StartInfo {
  session_id: string;
  model: string;
  models: string[];
}

/** Chat entries of each agent tab, as its process reports them. Not saved: a resumed session brings its history back. */
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

/** Models each agent tab can switch to. */
export const useAgentModels = create<{ byTab: Record<string, string[]> }>(() => ({ byTab: {} }));

/** Tabs whose agent process was started, with its provider. */
const started = new Map<string, Provider>();

/** Starts the agent process of a tab, resuming its session when it has one. */
async function startAgent(tabId: string): Promise<void> {
  const tab = useStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab?.provider || started.has(tabId)) return;
  const provider = tab.provider;
  started.set(tabId, provider);
  try {
    const info = await invoke<StartInfo>(agentCommand(provider, "start"), {
      tabId,
      cwd: tab.cwd ?? ".",
      sessionId: tab.agentSessionId ?? null,
      model: tab.agentModel ?? null,
    });
    useStore.getState().patchTab(tabId, { agentSessionId: info.session_id, agentModel: info.model });
    useAgentModels.setState((s) => ({ byTab: { ...s.byTab, [tabId]: info.models } }));
  } catch (err) {
    started.delete(tabId);
    const text = `O ${PROVIDER_NAMES[provider]} não abriu: ${String(err)}`;
    pushEntries(tabId, [{ kind: "error", id: `start:${Date.now()}`, text }]);
  }
}

function stopAgent(tabId: string): void {
  const provider = started.get(tabId);
  started.delete(tabId);
  useAgentEntries.setState((s) => {
    const { [tabId]: _gone, ...byTab } = s.byTab;
    return { byTab };
  });
  if (provider) void invoke(agentCommand(provider, "stop"), { tabId }).catch(() => {});
}

/**
 * Keeps each live agent tab's process running and its chat fed. A tab
 * restored dormant starts when it wakes; a closed tab stops its process.
 */
export function watchAgentTabs(): () => void {
  const sync = () => {
    const tabs = useStore.getState().tabs;
    for (const t of tabs) if (t.provider && t.state !== "dormant") void startAgent(t.id);
    for (const id of [...started.keys()]) if (!tabs.some((t) => t.id === id && t.state !== "dormant")) stopAgent(id);
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
