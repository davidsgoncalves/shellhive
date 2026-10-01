import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "@xterm/xterm/css/xterm.css";
import "./App.css";
import { Sidebar } from "./components/Sidebar";
import { TabStrip } from "./components/TabStrip";
import { TerminalView } from "./components/TerminalView";
import { RightPanel } from "./components/RightPanel";
import { TopBar } from "./components/TopBar";
import { Dialogs } from "./components/Dialogs";
import { GroupMenu } from "./components/GroupMenu";
import { TabMenu } from "./components/TabMenu";
import { UpdateBanner } from "./components/UpdateBanner";
import { ErrorReportsPrompt } from "./components/ErrorReportsPrompt";
import { PaneOverlay } from "./components/PaneOverlay";
import { EmptyPane } from "./components/EmptyPane";
import { PLUGINS, type PluginHost } from "./lib/plugins";
import { reportError } from "./lib/errors";
import { LocalPluginPanel, PluginViewPane } from "./components/LocalPluginPanel";
import { isView, pluginTab, viewOf, type LocalPlugin } from "./lib/localPlugins";
import { allTabs, applyEffects, openSurface, runPluginTool, type PluginEffects } from "./lib/pluginEffects";
import { pluginKeyOf, setClaimedPluginKeys } from "./lib/shortcuts";
import { TerminalSearch } from "./components/TerminalSearch";
import { CommandCard, typeCommand } from "./components/CommandCard";
import { applyLook, shareLook } from "./lib/theme";
import { defaultGroupId, ensureUngrouped, openSession, openSessionInGroup, useStore } from "./lib/store";
import { tabPatchFor } from "./lib/hookState";
import { decodeBase64, serializers, terminals } from "./lib/terminals";
import {
  DETACH_CLOSED,
  DETACH_READY,
  DETACH_RESIZE,
  DETACH_SNAPSHOT,
  closeDetachedWindow,
  detachedLabel,
  setDetachedTitle,
  type DetachSnapshot,
} from "./lib/detach";
import { notify } from "./lib/notify";
import { describeTool } from "./lib/describe";
import { ruleAllows } from "./lib/permRules";
import { nextSubagents } from "./lib/subagents";
import {
  MINI_ACTIVATE,
  MINI_BOUNDS,
  MINI_CLOSED,
  MINI_LABEL,
  MINI_READY,
  MINI_STATE,
  closeMiniWindow,
  openMiniWindow,
  type MiniBounds,
  type MiniRow,
} from "./lib/mini";
import { actionOf, tabNumberOf } from "./lib/shortcuts";
import { syncTabTitle } from "./lib/titles";
import {
  WATCHDOG_MINUTES,
  paneCount,
  paneRect,
  type HookEvent,
  type HookSetup,
  type CommandSuggestion,
  type GitInfo,
  type PermissionRequest,
  type QuestionItem,
  type StatusEnvelope,
} from "./lib/types";

type PtyData = { id: string; data: string };
type PermissionResolved = { id: string; decision: string | null };

const QUESTION_TOOL = "AskUserQuestion";

/**
 * Claude's question tool has no hook of its own, so the queue picks it up from
 * the tool-use events that bracket it.
 */
function trackQuestions(e: HookEvent, tabId: string): void {
  const p = e.payload;
  if (p.tool_name !== QUESTION_TOOL) return;
  const store = useStore.getState();
  const toolUseId = typeof p.tool_use_id === "string" ? p.tool_use_id : null;
  const name = String(p.hook_event_name ?? "");

  if (name === "PreToolUse") {
    const input = (p.tool_input ?? {}) as { questions?: QuestionItem["questions"] };
    if (!Array.isArray(input.questions) || input.questions.length === 0) return;
    store.addQuestion({
      id: `q-${e.received_at}-${toolUseId ?? tabId}`,
      tab_id: tabId,
      received_at: e.received_at,
      tool_use_id: toolUseId,
      questions: input.questions,
    });
    const first = input.questions[0]?.question ?? "Pergunta";
    void notify("Claude perguntou", first);
    return;
  }
  if (name === "PostToolUse") {
    store.dropQuestion(toolUseId ? { toolUseId } : { tabId });
  }
}

function useBackendBridge() {
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    const store = useStore.getState;

    invoke<HookSetup>("hooks_setup").then(store().setSetup).catch(console.error);

    listen<PtyData>("pty-data", (ev) => {
      terminals.get(ev.payload.id)?.write(decodeBase64(ev.payload.data));
    }).then((u) => unlisteners.push(u));

    listen<{ id: string }>("pty-exit", (ev) => {
      const tab = store().tabs.find((t) => t.id === ev.payload.id);
      if (tab) store().patchTab(tab.id, { state: "dormant", pendingMessage: null });
      if (tab) store().setSubagents(tab.id, []);
    }).then((u) => unlisteners.push(u));

    listen<StatusEnvelope>("statusline-event", (ev) => {
      store().applyStatus(ev.payload);
    }).then((u) => unlisteners.push(u));

    listen<HookEvent>("hook-event", (ev) => {
      const e = ev.payload;
      store().pushEvent(e);
      if (!e.tab_id) return;
      const tab = store().tabs.find((t) => t.id === e.tab_id);
      if (!tab) return;
      store().setSubagents(tab.id, nextSubagents(store().subagentsByTab[tab.id] ?? [], e));
      const patch = tabPatchFor(tab, e);
      if (!patch) return;
      store().patchTab(tab.id, patch);
      if (patch.state && patch.state !== tab.state) store().clearAlerted(tab.id);
      if (patch.state === "shell" || patch.state === "dormant") {
        store().dropQuestion({ tabId: tab.id });
      }
      if (patch.state === "waiting" && tab.state === "working") {
        void notify("Sessão terminou", patch.title ?? tab.title);
      }
      trackQuestions(e, tab.id);
      // A /rename inside Claude lands in the transcript; pick it up on the
      // events that bracket a turn rather than on every tool call.
      const name = String(e.payload.hook_event_name ?? "");
      if (name === "SessionStart" || name === "Stop" || name === "UserPromptSubmit") {
        void syncTabTitle(tab.id);
      }
    }).then((u) => unlisteners.push(u));

    listen<PermissionRequest>("permission-request", (ev) => {
      const req = ev.payload;
      const tab = store().tabs.find((t) => t.id === req.tab_id);
      const group = store().groups.find((g) => g.id === tab?.groupId);
      if (group && ruleAllows(group.allowRules, req.payload)) {
        void invoke("permission_decide", { id: req.id, decision: "allow", reason: `Regra do grupo ${group.name}` });
        return;
      }
      store().addPermission(req);
      const summary = describeTool(req.payload.tool_name, req.payload.tool_input);
      store().patchTab(req.tab_id ?? "", {
        state: "permission",
        pendingMessage: `${req.payload.tool_name ?? "ferramenta"}: ${summary}`,
      });
      void notify(`Permissão: ${req.payload.tool_name ?? "ferramenta"}`, `${tab?.title ?? "sessão"} · ${summary}`);
    }).then((u) => unlisteners.push(u));

    listen<CommandSuggestion>("command-suggestion", (ev) => {
      store().addCommand(ev.payload);
      const tab = store().tabs.find((t) => t.id === ev.payload.tab_id);
      void notify("Comando para você rodar", `${tab?.title ?? "sessão"} · ${ev.payload.command}`);
    }).then((u) => unlisteners.push(u));

    listen<PermissionResolved>("permission-resolved", (ev) => {
      store().dropPermission(ev.payload.id);
    }).then((u) => unlisteners.push(u));

    return () => unlisteners.forEach((u) => u());
  }, []);
}

/**
 * `/rename` inside Claude fires no hook, so the transcript is checked on a
 * timer as well as on session events.
 */
function useTitlePoll() {
  useEffect(() => {
    const id = setInterval(() => {
      for (const tab of useStore.getState().tabs) {
        if (tab.state !== "dormant" && tab.transcriptPath) void syncTabTitle(tab.id);
      }
    }, 8_000);
    return () => clearInterval(id);
  }, []);
}

/** Flags a tab that has been waiting on the human for too long. */
function useWatchdog() {
  useEffect(() => {
    const tick = () => {
      const s = useStore.getState();
      const threshold = WATCHDOG_MINUTES * 60_000;
      for (const tab of s.tabs) {
        const idle = tab.state === "permission" || tab.state === "waiting";
        const since = tab.lastEventAt ? Date.now() - tab.lastEventAt : 0;
        if (idle && since > threshold && !s.alerted.includes(tab.id)) {
          s.markAlerted(tab.id);
          const minutes = Math.round(since / 60_000);
          void notify("Sessão parada", `${tab.title} há ${minutes} min sem resposta`, true);
        }
      }
    };
    const id = setInterval(tick, 20_000);
    return () => clearInterval(id);
  }, []);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = actionOf(e);
      const number = tabNumberOf(e);
      if (!action && number === null) return;
      const s = useStore.getState();
      const live = s.tabs.filter((t) => t.state !== "dormant");
      const idx = live.findIndex((t) => t.id === s.activeTabId);
      e.preventDefault();

      if (number !== null) {
        const t = live[number - 1];
        if (t) s.activateTab(t.id);
        return;
      }
      switch (action) {
        case "newTab":
          return void openSessionInGroup(defaultGroupId());
        case "reopenTab":
          return s.reopenClosedTab();
        case "closeTab":
          return void (s.activeTabId && s.closeTab(s.activeTabId));
        case "switcher":
          return s.openModal(s.modal?.kind === "switcher" ? null : { kind: "switcher" });
        case "search": {
          const target = (isView(s.panes[s.focusedPane]) ? null : s.panes[s.focusedPane]) ?? s.activeTabId;
          return void (target && !s.detached.includes(target) && s.openSearch(target));
        }
        case "sidebar":
          return s.toggleSidebar();
        case "events":
          return s.toggleEvents();
        case "settings":
          return s.openModal({ kind: "settings" });
        case "miniPanel":
          return s.setMiniPanel(!s.miniPanel);
        case "nextTab":
        case "prevTab": {
          if (live.length < 2) return;
          const next = (idx + (action === "nextTab" ? 1 : -1) + live.length) % live.length;
          return s.activateTab(live[next].id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Serves the windows that hold a single detached terminal. */
function useDetachedWindows() {
  useEffect(() => {
    const store = useStore.getState;
    const subs = [
      // A new window starts from the screen this window has kept drawing.
      listen<{ id: string }>(DETACH_READY, (ev) => {
        const { id } = ev.payload;
        const term = terminals.get(id);
        const snapshot: DetachSnapshot = {
          id,
          data: serializers.get(id)?.serialize() ?? "",
          cols: term?.cols ?? 80,
          rows: term?.rows ?? 24,
          cwd: store().tabs.find((t) => t.id === id)?.cwd ?? null,
        };
        void emitTo(detachedLabel(id), DETACH_SNAPSHOT, snapshot);
      }),
      // Keep the hidden copy at the window's size so it reads right on return.
      listen<{ id: string; cols: number; rows: number }>(DETACH_RESIZE, (ev) => {
        terminals.get(ev.payload.id)?.resize(ev.payload.cols, ev.payload.rows);
      }),
      listen<{ id: string }>(DETACH_CLOSED, (ev) => store().reattachTab(ev.payload.id)),
      // Detached windows cannot outlive the window that owns their tabs.
      getCurrentWebviewWindow().onCloseRequested(() => store().detached.forEach(closeDetachedWindow)),
    ];

    let titles = new Map<string, string>();
    const unsub = useStore.subscribe((s) => {
      const next = new Map<string, string>();
      for (const id of s.detached) {
        const title = s.tabs.find((t) => t.id === id)?.title ?? "";
        next.set(id, title);
        if (titles.has(id) && titles.get(id) !== title) setDetachedTitle(id, title);
      }
      titles = next;
    });

    return () => {
      unsub();
      subs.forEach((p) => void p.then((u) => u()));
    };
  }, []);
}

const GIT_POLL_MS = 10_000;

/** Keeps each live tab's branch and pending changes current. */
function useGitPoll() {
  useEffect(() => {
    const refresh = (tabId: string) => {
      const tab = useStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab?.cwd) return;
      invoke<GitInfo | null>("git_info", { cwd: tab.cwd })
        .then((info) => useStore.getState().setGitInfo(tabId, info))
        .catch(() => {});
    };
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const soon = (tabId: string) => {
      clearTimeout(timers.get(tabId));
      timers.set(tabId, setTimeout(() => refresh(tabId), 1500));
    };
    const tick = () => {
      for (const tab of useStore.getState().tabs) if (tab.state !== "dormant") refresh(tab.id);
    };
    tick();
    const id = setInterval(tick, GIT_POLL_MS);
    // A finished turn is when files most likely changed.
    const sub = listen<HookEvent>("hook-event", (ev) => {
      const name = ev.payload.payload.hook_event_name;
      if (ev.payload.tab_id && (name === "Stop" || name === "PostToolUse")) soon(ev.payload.tab_id);
    });
    return () => {
      clearInterval(id);
      timers.forEach(clearTimeout);
      void sub.then((u) => u());
    };
  }, []);
}

const MINI_THROTTLE_MS = 250;

function miniRows(): MiniRow[] {
  const s = useStore.getState();
  return s.tabs
    .filter((t) => t.state !== "dormant")
    .map((t) => {
      const group = s.groups.find((g) => g.id === t.groupId);
      return {
        id: t.id,
        title: t.title,
        state: t.state,
        color: group?.color ?? "transparent",
        group: group?.name ?? "",
        agents: s.subagentsByTab[t.id]?.length ?? 0,
      };
    });
}

/** Opens, feeds and answers the floating mini panel while it is switched on. */
function useMiniPanel() {
  const on = useStore((s) => s.miniPanel);

  useEffect(() => {
    if (!on) {
      closeMiniWindow();
      return;
    }
    openMiniWindow(useStore.getState().miniBounds);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = "";
    const send = () => {
      const rows = miniRows();
      const json = JSON.stringify(rows);
      if (json === last) return;
      last = json;
      void emitTo(MINI_LABEL, MINI_STATE, rows);
    };
    const sendSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(send, MINI_THROTTLE_MS);
    };
    const unsub = useStore.subscribe(sendSoon);
    const subs = [
      listen(MINI_READY, () => {
        last = "";
        send();
      }),
      listen<{ id: string }>(MINI_ACTIVATE, (ev) => {
        const main = getCurrentWebviewWindow();
        void main.unminimize().then(() => main.show()).then(() => main.setFocus());
        useStore.getState().activateTab(ev.payload.id);
      }),
      listen(MINI_CLOSED, () => useStore.getState().setMiniPanel(false)),
      listen<MiniBounds>(MINI_BOUNDS, (ev) => useStore.getState().setMiniBounds(ev.payload)),
      getCurrentWebviewWindow().onCloseRequested(() => closeMiniWindow()),
    ];
    return () => {
      clearTimeout(timer);
      unsub();
      subs.forEach((p) => void p.then((u) => u()));
    };
  }, [on]);
}

/** Runs a queued command once its session stops working and waits. */
function useQueuedCommands() {
  useEffect(() => {
    const started = new Set<string>();
    return useStore.subscribe((s) => {
      // One per tab at a time: the next waits for the session to be idle again.
      const typing = new Set<string>();
      for (const c of s.commands) {
        if (!c.queued || started.has(c.id) || !c.tab_id || typing.has(c.tab_id)) continue;
        const tab = s.tabs.find((t) => t.id === c.tab_id);
        if (tab?.state !== "waiting") continue;
        started.add(c.id);
        typing.add(tab.id);
        void typeCommand(tab.id, c.command)
          .catch(() => {})
          .finally(() => useStore.getState().dropCommand(c.id));
      }
    });
  }, []);
}

/** Records the group of every tab's Claude session whenever tabs change. */
function useSessionGroups() {
  useEffect(() => {
    useStore.getState().rememberSessionGroups();
    return useStore.subscribe((s, prev) => {
      if (s.tabs !== prev.tabs) s.rememberSessionGroups();
    });
  }, []);
}

/** Answers agent tools whose handlers live in a plugin's interface. */
function usePluginToolCalls() {
  useEffect(() => {
    const p = listen<{ call_id: string; plugin: string; tool: string; tab_id: string | null; args: Record<string, unknown> }>(
      "plugin-tool-call",
      async ({ payload }) => {
        const reply = (text: string, isError: boolean) =>
          invoke("plugin_tool_result", { callId: payload.call_id, text, isError }).catch(console.error);
        const on = useStore.getState().enabledPlugins.includes(payload.plugin);
        const handler = on ? PLUGINS.find((x) => x.manifest.id === payload.plugin)?.tools?.[payload.tool] : undefined;
        if (!handler) return void reply(`O plugin ${payload.plugin} não trata ${payload.tool}.`, true);
        try {
          const out = await handler(payload.args ?? {}, { tabId: payload.tab_id });
          void reply(out.text, !!out.isError);
        } catch (err) {
          reportError("plugin", err);
          void reply(`Falha em ${payload.tool}: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      },
    );
    return () => {
      void p.then((un) => un());
    };
  }, []);
}

/** Keeps the list of local plugins current and opens their panels on request. */
function useLocalPlugins() {
  useEffect(() => {
    const store = useStore.getState;
    invoke<LocalPlugin[]>("local_plugins").then(store().setLocalPlugins).catch(console.error);
    const subs = [
      listen<LocalPlugin[]>("local-plugins", (ev) => store().setLocalPlugins(ev.payload)),
      // What a tool the agent called asks the app to do: panel, badges, notification.
      listen<{ plugin: string; tab_id: string | null; effects: PluginEffects }>("plugin-effects", ({ payload }) => {
        const plugin = store().localPlugins.find((p) => p.id === payload.plugin);
        if (plugin) applyEffects(plugin, payload.tab_id, payload.effects);
      }),
    ];
    return () => subs.forEach((p) => void p.then((un) => un()));
  }, []);
}

/** Keyboard shortcuts enabled plugins declared. */
function usePluginShortcuts() {
  const localPlugins = useStore((s) => s.localPlugins);
  const enabled = useStore((s) => s.enabledPlugins);
  useEffect(() => {
    const active = localPlugins.filter((p) => p.status === "approved" && enabled.includes(p.id));
    setClaimedPluginKeys(active.flatMap((p) => p.shortcuts.map((k) => k.key)));
    const onKey = (e: KeyboardEvent) => {
      const key = pluginKeyOf(e);
      if (!key) return;
      for (const plugin of active) {
        const hit = plugin.shortcuts.find((k) => k.key === key);
        if (!hit) continue;
        e.preventDefault();
        const s = useStore.getState();
        const tab = s.tabs.find((t) => t.id === s.activeTabId);
        if (hit.open) openSurface(plugin, hit.open, tab?.id ?? null, null);
        else if (hit.tool)
          void runPluginTool(plugin, hit.tool, tab?.id ?? null, { tab: tab ? pluginTab(tab, s.groups) : null }).catch(
            (err) => reportError("plugin", `${plugin.id}/${hit.tool}: ${err}`),
          );
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      setClaimedPluginKeys([]);
    };
  }, [localPlugins, enabled]);
}

/** Runs the tools plugins scheduled, while each plugin is on. */
function usePluginSchedules() {
  const localPlugins = useStore((s) => s.localPlugins);
  const enabled = useStore((s) => s.enabledPlugins);
  const key = JSON.stringify(
    localPlugins
      .filter((p) => p.status === "approved" && enabled.includes(p.id) && p.schedule.length)
      .map((p) => [p.id, p.hash, p.schedule]),
  );
  useEffect(() => {
    const timers: ReturnType<typeof setInterval>[] = [];
    const store = useStore.getState;
    for (const plugin of store().localPlugins) {
      if (plugin.status !== "approved" || !store().enabledPlugins.includes(plugin.id)) continue;
      for (const job of plugin.schedule) {
        const run = () =>
          void runPluginTool(plugin, job.tool, null, { tabs: allTabs() }).catch((err) =>
            reportError("plugin", `${plugin.id}/${job.tool}: ${err}`),
          );
        run();
        timers.push(setInterval(run, job.every * 1000));
      }
    }
    return () => timers.forEach(clearInterval);
  }, [key]);
}

/** Tells the backend which plugins' agent tools to offer. */
function usePluginSync() {
  const enabled = useStore((s) => s.enabledPlugins);
  useEffect(() => {
    void invoke("plugins_set_enabled", { ids: enabled }).catch(console.error);
  }, [enabled]);
}

/** Applies the chosen theme and terminal font and shares them with the other windows. */
function useLook() {
  const theme = useStore((s) => s.theme);
  const terminalFont = useStore((s) => s.terminalFont);
  useEffect(() => {
    applyLook(theme, terminalFont);
    shareLook(theme, terminalFont);
  }, [theme, terminalFont]);
}

function App() {
  useBackendBridge();
  useTitlePoll();
  useSessionGroups();
  useQueuedCommands();
  useWatchdog();
  useShortcuts();
  useDetachedWindows();
  useGitPoll();
  useMiniPanel();
  useLook();
  usePluginSync();
  usePluginToolCalls();
  useLocalPlugins();
  usePluginSchedules();
  usePluginShortcuts();
  const tabs = useStore((s) => s.tabs);

  useEffect(() => {
    ensureUngrouped();
    const s = useStore.getState();
    if (s.tabs.length === 0) {
      openSessionInGroup(defaultGroupId());
      return;
    }
    // Restored tabs all come back dormant; wake the last active one so the app
    // opens on a live terminal instead of the empty state. The rest stay lazy.
    if (!s.tabs.some((t) => t.state !== "dormant")) {
      const target = s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0];
      s.activateTab(target.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = tabs.filter((t) => t.state !== "dormant");
  const layout = useStore((s) => s.layout);
  const barPosition = useStore((s) => s.barPosition);
  const groups = useStore((s) => s.groups);
  const borderWidth = useStore((s) => s.terminalBorder);
  const { splitMode, panes, focusedPane, focusPane, detached, searchTabId, openSearch, commands, questions, enabledPlugins } =
    useStore();
  const localPlugins = useStore((s) => s.localPlugins);
  const slots = paneCount(splitMode);
  const paneOf = (tabId: string) => panes.slice(0, slots).indexOf(tabId);
  const pluginHost: PluginHost = {
    paneRect: (tabId) => {
      // Only a call from outside any tab has no tab to follow.
      if (!tabId) return paneRect(splitMode, focusedPane);
      const slot = paneOf(tabId);
      return slot === -1 || detached.includes(tabId) ? null : paneRect(splitMode, slot);
    },
  };
  const colorOf = (tab: (typeof tabs)[number]) =>
    groups.find((g) => g.id === tab.groupId)?.color ?? "transparent";
  // A slot is empty when nothing is assigned or its tab is no longer running.
  // A pane may hold a plugin's view instead of a terminal, while that plugin is on.
  const viewIn = (i: number) => {
    const id = panes[i];
    if (!isView(id)) return null;
    return localPlugins.find((p) => viewOf(p.id) === id && p.view && p.status === "approved" && enabledPlugins.includes(p.id)) ?? null;
  };
  const emptySlots = Array.from({ length: slots }, (_, i) => i).filter(
    (i) => !viewIn(i) && (!panes[i] || !live.some((t) => t.id === panes[i])),
  );

  return (
    <div className="layout">
      <UpdateBanner />
      <ErrorReportsPrompt />
      {barPosition === "top" && <TopBar />}
      <div className="body">
        {layout === "sidebar" && <Sidebar />}
        <main className="main">
          {layout === "topbar" && <TabStrip />}
          <div
            className="terminals"
            style={{ ["--terminal-border" as string]: `${borderWidth}px` }}
          >
            {live.map((t) => {
              const slot = paneOf(t.id);
              return (
                <TerminalView
                  key={t.id}
                  tab={t}
                  visible={slot !== -1 && !detached.includes(t.id)}
                  focused={slot === focusedPane}
                  rect={paneRect(splitMode, slot === -1 ? 0 : slot)}
                  color={colorOf(t)}
                  onFocus={() => slot !== -1 && focusPane(slot)}
                  onDropTab={(id) => slot !== -1 && id !== t.id && useStore.getState().assignToPane(id, slot)}
                  onDropSession={(ref) => slot !== -1 && openSession(ref, { pane: slot })}
                  attention={
                    t.state === "permission" ||
                    questions.some((q) => q.tab_id === t.id) ||
                    commands.some((c) => c.tab_id === t.id)
                  }
                  onContextMenu={(e) => {
                    e.preventDefault();
                    useStore.getState().openTabMenu({ x: e.clientX, y: e.clientY, tabId: t.id });
                  }}
                />
              );
            })}
            {emptySlots.map((i) => (
              <EmptyPane key={`empty-${i}`} index={i} />
            ))}
            {Array.from({ length: slots }, (_, i) => i).map((i) => {
              const plugin = viewIn(i);
              return plugin ? (
                <PluginViewPane
                  key={`view-${plugin.id}`}
                  plugin={plugin}
                  rect={paneRect(splitMode, i)}
                  focused={focusedPane === i}
                  onFocus={() => focusPane(i)}
                />
              ) : null;
            })}
            {PLUGINS.filter((p) => p.Overlay && enabledPlugins.includes(p.manifest.id)).map((p) => {
              const Overlay = p.Overlay!;
              return <Overlay key={p.manifest.id} host={pluginHost} />;
            })}
            <LocalPluginPanel host={pluginHost} />
            {searchTabId && paneOf(searchTabId) !== -1 && (
              <TerminalSearch
                key={searchTabId}
                tabId={searchTabId}
                rect={paneRect(splitMode, paneOf(searchTabId))}
                onClose={() => openSearch(null)}
              />
            )}
            {Array.from({ length: slots }, (_, slot) => {
              const tabId = panes[slot];
              const here = commands.filter((c) => c.tab_id && c.tab_id === tabId);
              if (!tabId || here.length === 0 || detached.includes(tabId)) return null;
              return (
                <ul key={`cmd-${slot}`} className="pane-commands" style={paneRect(splitMode, slot)}>
                  {here.map((c) => (
                    <CommandCard key={c.id} item={c} overlay />
                  ))}
                </ul>
              );
            })}
            <PaneOverlay />
          </div>
        </main>
        <RightPanel />
      </div>
      {barPosition === "bottom" && <TopBar />}
      <Dialogs />
      <GroupMenu />
      <TabMenu />
    </div>
  );
}

export default App;
