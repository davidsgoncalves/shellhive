import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { useStore } from "./store";
import { sendMessage } from "./typing";
import { agentCommand, PROVIDER_NAMES, type Provider } from "./providers";
import type { ChatEntry, Tab } from "./types";

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
    // OpenCode's own interface attaches to this server once it is up.
    const now = useStore.getState().tabs.find((t) => t.id === tabId);
    if (now && provider === "opencode" && now.view !== "chat") void openAgentTerminal(now);
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
 * Whether the app runs the tab's agent process: Codex's app-server only for
 * its chat (in the terminal Codex runs on its own), OpenCode's server in both
 * modes (its terminal interface attaches to it).
 */
function needsProcess(t: Tab): boolean {
  if (!t.provider || t.state === "dormant") return false;
  return t.provider === "opencode" || t.view === "chat";
}

/**
 * Keeps each live agent tab's process running and its chat fed. A tab
 * restored dormant starts when it wakes; a closed tab stops its process.
 */
export function watchAgentTabs(): () => void {
  const sync = () => {
    const tabs = useStore.getState().tabs;
    for (const t of tabs) if (needsProcess(t)) void startAgent(t.id);
    for (const [id, provider] of [...started.entries()])
      if (!tabs.some((t) => t.id === id && t.provider === provider && needsProcess(t))) stopAgent(id);
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

/** Session ids and model names are typed into a shell; anything else stays out. */
const SAFE_ARG = /^[\w.:/-]+$/;

/** The line that opens Codex in a tab's terminal, resuming its session when it has one. */
export function codexLine(tab: Tab): string {
  const args = ["codex"];
  if (tab.agentSessionId && SAFE_ARG.test(tab.agentSessionId)) args.push("resume", tab.agentSessionId);
  if (tab.agentModel && SAFE_ARG.test(tab.agentModel)) args.push("-m", tab.agentModel);
  return `${args.join(" ")}\r`;
}

/** Types into the tab's terminal, waiting for it to exist when the tab is new. */
async function typeInTerminal(tabId: string, data: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      await invoke("pty_write", { id: tabId, data });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** Tabs whose terminal shows OpenCode's interface. */
const attached = new Set<string>();

/** Opens the agent's own interface in the tab's terminal. */
export async function openAgentTerminal(tab: Tab): Promise<void> {
  try {
    if (tab.provider === "codex") {
      // Codex reports to the tab through its hooks; it asks once to trust them.
      await invoke("codex_hooks_install");
      await typeInTerminal(tab.id, codexLine(tab));
    } else if (tab.provider === "opencode") {
      const line = await invoke<string>("opencode_attach_line", { tabId: tab.id });
      attached.add(tab.id);
      await typeInTerminal(tab.id, line);
    }
  } catch (err) {
    void typeInTerminal(tab.id, `# ${String(err).replace(/[\r\n]/g, " ")}\r`);
  }
}

/**
 * Switches an agent tab between its chat and its own terminal interface.
 * Codex runs one of the two at a time, resuming the same session; OpenCode
 * keeps one server and only attaches or detaches its interface.
 */
export async function setAgentView(tabId: string, view: "chat" | "terminal"): Promise<void> {
  const store = useStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab?.provider || (tab.view === "chat") === (view === "chat")) return;
  if (view === "terminal") {
    store.patchTab(tabId, { view: undefined });
    if (tab.provider === "codex") await shellReturns(tabId, 8000);
    const now = useStore.getState().tabs.find((t) => t.id === tabId);
    if (now) await openAgentTerminal(now);
    return;
  }
  if (tab.provider === "codex") {
    if (tab.state !== "shell" && tab.state !== "dormant") {
      await sendMessage(tabId, "/quit");
      await shellReturns(tabId, 8000);
    }
  } else if (attached.delete(tabId)) {
    // Ctrl+C leaves OpenCode's interface; a second one lands harmlessly in the shell.
    await invoke("pty_write", { id: tabId, data: "\x03" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    await invoke("pty_write", { id: tabId, data: "\x03" }).catch(() => {});
  }
  useStore.getState().patchTab(tabId, { view: "chat" });
}
