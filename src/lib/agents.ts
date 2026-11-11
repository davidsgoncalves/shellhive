import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { useStore } from "./store";
import { sendMessage } from "./typing";
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
    for (const [id, provider] of [...started.entries()])
      if (!tabs.some((t) => t.id === id && t.state !== "dormant" && t.provider === provider)) stopAgent(id);
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

/** Resolves once the tab is back at its shell, or after `ms`. */
function shellReturns(tabId: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsub();
      resolve();
    };
    const atShell = () => {
      const state = useStore.getState().tabs.find((t) => t.id === tabId)?.state;
      return state === undefined || state === "shell" || state === "dormant";
    };
    const timer = setTimeout(done, ms);
    const unsub = useStore.subscribe(() => atShell() && done());
    if (atShell()) done();
  });
}

/**
 * Changes the agent of a tab whose chat is still empty. The current agent
 * ends first, so its end is never taken for the new one's.
 */
export async function switchAgent(tabId: string, to: Provider | "claude"): Promise<void> {
  const store = useStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab || (tab.provider ?? "claude") === to) return;
  if (tab.provider) {
    store.patchTab(tabId, { provider: undefined, agentSessionId: undefined, agentModel: undefined });
  } else if (tab.state !== "shell" && tab.state !== "dormant") {
    // Claude runs in the tab's terminal and leaves it for the other agent.
    await sendMessage(tabId, "/exit");
  }
  await shellReturns(tabId, 8000);
  const title = tab.customTitle ? tab.title : to === "claude" ? tab.title : PROVIDER_NAMES[to];
  if (to === "claude") {
    useStore.getState().patchTab(tabId, { view: "chat", title });
    void invoke("pty_write", { id: tabId, data: "claude\r" }).catch(() => {});
  } else {
    // The tab's Claude session is gone; it must not resume when the app reopens.
    useStore.getState().patchTab(tabId, { provider: to, view: "chat", title, claudeSessionId: null, transcriptPath: null });
  }
}
