import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { fileStorage } from "./persist";
import { markPendingResume } from "./restored";
import { sameRule } from "./permRules";
import type { MiniBounds } from "./mini";
import { THEME_FONT, THEMES, type TerminalFont, type ThemeId } from "./theme";
import { defaultEnabledPlugins } from "./plugins";
import { closeDetachedWindow, focusDetachedWindow, openDetachedWindow } from "./detach";
import {
  DEFAULT_TAB_TITLE,
  UNGROUPED_COLOR,
  UNGROUPED_ID,
  UNGROUPED_NAME,
  type Folder,
  type GitInfo,
  type Subagent,
  type CommandSuggestion,
  type Group,
  type HookEvent,
  type HookSetup,
  type PermissionRequest,
  type PermissionRule,
  paneCount,
  type BarPosition,
  type Layout,
  type QuestionItem,
  type RateLimits,
  type SplitMode,
  type TitleWrap,
  type GroupTint,
  type StatusEnvelope,
  type StatusPayload,
  type Tab,
  type TabState,
} from "./types";

const newId = () => crypto.randomUUID();

const CLOSED_TABS_MAX = 20;
const SESSION_GROUPS_MAX = 2000;

/** What is needed to bring a closed tab back. */
interface ClosedTab {
  groupId: string;
  cwd: string | null;
  claudeSessionId: string | null;
  title: string;
  customTitle: boolean;
}

/** First visible pane with nothing running in it, if the split has one. */
function freePane(s: Pick<Store, "panes" | "tabs" | "splitMode">): number | null {
  for (let i = 0; i < paneCount(s.splitMode); i++) {
    const id = s.panes[i];
    const tab = id ? s.tabs.find((t) => t.id === id) : undefined;
    if (!tab || tab.state === "dormant") return i;
  }
  return null;
}

function rememberClosed(list: ClosedTab[], tabs: Tab[]): ClosedTab[] {
  const added = tabs.map(({ groupId, cwd, claudeSessionId, title, customTitle }) => ({
    groupId,
    cwd,
    claudeSessionId,
    title,
    customTitle,
  }));
  return [...list, ...added].slice(-CLOSED_TABS_MAX);
}

export type SettingsTab = "aparencia" | "pastas" | "plugins" | "sobre";

export type Modal =
  | null
  | { kind: "settings"; tab?: SettingsTab }
  | { kind: "newGroup" }
  | { kind: "switcher" }
  | { kind: "pickFolder"; groupId: string };

interface Store {
  groups: Group[];
  tabs: Tab[];
  activeTabId: string | null;
  sidebarOpen: boolean;
  eventsOpen: boolean;
  events: HookEvent[];
  setup: HookSetup | null;
  /** Latest statusline payload per tab: model, context, cost. */
  statusByTab: Record<string, StatusPayload>;
  /** Account-wide limits; whichever session reported last wins. */
  rateLimits: RateLimits | null;
  /** Permission requests waiting for a decision, oldest first. */
  permissions: PermissionRequest[];
  /** Tabs already announced by the watchdog, so it notifies once per episode. */
  alerted: string[];
  /** Claude session ids pinned to the top of the session list. */
  pinned: string[];
  /** Project folders offered when opening a session. */
  folders: Folder[];
  /** Folder id used when a session opens without an explicit choice. */
  defaultFolderId: string | null;
  /** Which dialog is open, if any. */
  modal: Modal;
  /** Open group context menu, with the cursor position that opened it. */
  groupMenu: { x: number; y: number; groupId: string } | null;
  /** Open tab context menu. */
  tabMenu: { x: number; y: number; tabId: string } | null;
  /** Tab waiting to be dropped into a pane, while the slot overlay is up. */
  paneAssign: string | null;
  /** Where the tab list is drawn. */
  layout: Layout;
  /** Edge of the window holding the limits bar. */
  barPosition: BarPosition;
  /** Thickness in pixels of the terminal frame in the group's colour. */
  terminalBorder: number;
  /** Whether long tab names in the sidebar wrap or get cut with an ellipsis. */
  tabTitleWrap: TitleWrap;
  /** Background tint of each group in the tab list. */
  groupTint: GroupTint;
  /** Colours, fonts and backdrop of the whole app. */
  theme: ThemeId;
  /** Terminal font overrides; null fields follow the theme. */
  terminalFont: TerminalFont;
  /** Official plugins turned on. */
  enabledPlugins: string[];
  /** Ids of the Novidades already shown. */
  seenAnnouncements: string[];
  /** The one-time question about sending error reports was answered. */
  errorReportsAsked: boolean;
  /** Whether the raw hook events tab is shown in the right panel. */
  showEvents: boolean;
  /** Whether the floating mini panel is shown. */
  miniPanel: boolean;
  /** Where the mini panel was last left, in logical pixels. */
  miniBounds: MiniBounds | null;
  /** How the terminal area is divided. */
  splitMode: SplitMode;
  /** Tab shown in each pane, by slot. */
  panes: Array<string | null>;
  /** Slot that receives the next activated tab. */
  focusedPane: number;
  /** Questions Claude is waiting on, shown next to the permissions. */
  questions: QuestionItem[];
  /** Commands Claude asked the user to run, waiting in the queue. */
  commands: CommandSuggestion[];
  /** Tabs whose terminal is shown in a window of its own. */
  detached: string[];
  /** Subagents running in each tab, not persisted. */
  subagentsByTab: Record<string, Subagent[]>;
  /** Tab whose Cmd+F bar is open. */
  searchTabId: string | null;
  /** Last group each Claude session sat in, so reopening it lands there. */
  sessionGroups: Record<string, string>;
  /** Recently closed tabs, newest last, for Cmd+Shift+T. */
  closedTabs: ClosedTab[];
  /** Git state of each tab's folder; absent outside a repository. */
  gitByTab: Record<string, GitInfo>;

  addGroup: (name?: string, folderId?: string | null) => string;
  setGroupFolder: (id: string, folderId: string | null) => void;
  renameGroup: (id: string, name: string) => void;
  cycleGroupColor: (id: string) => void;
  toggleGroupCollapsed: (id: string) => void;
  setGroupHidden: (id: string, hidden: boolean) => void;
  addGroupRule: (id: string, rule: PermissionRule) => void;
  removeGroupRule: (id: string, rule: PermissionRule) => void;
  removeGroup: (id: string) => void;

  addTab: (
    groupId: string,
    opts?: { cwd?: string | null; claudeSessionId?: string; title?: string; customTitle?: boolean },
  ) => string;
  closeTab: (id: string) => void;
  /** Frees the pane showing a tab; the tab and its shell keep running in the list. */
  closePane: (id: string) => void;
  activateTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  moveTab: (id: string, groupId: string) => void;
  detachTab: (id: string, at?: { x: number; y: number }) => void;
  reattachTab: (id: string) => void;
  setGitInfo: (id: string, info: GitInfo | null) => void;
  reopenClosedTab: () => void;
  openSearch: (tabId: string | null) => void;
  setSubagents: (tabId: string, list: Subagent[]) => void;
  rememberSessionGroups: () => void;
  patchTab: (id: string, patch: Partial<Tab>) => void;

  toggleSidebar: () => void;
  toggleEvents: () => void;
  pushEvent: (e: HookEvent) => void;
  clearEvents: () => void;
  setSetup: (s: HookSetup) => void;
  applyStatus: (e: StatusEnvelope) => void;
  addPermission: (p: PermissionRequest) => void;
  dropPermission: (id: string) => void;
  markAlerted: (tabId: string) => void;
  clearAlerted: (tabId: string) => void;
  togglePinned: (sessionId: string) => void;
  addFolder: (name: string, path: string) => string;
  renameFolder: (id: string, name: string) => void;
  removeFolder: (id: string) => void;
  setDefaultFolder: (id: string | null) => void;
  openModal: (m: Modal) => void;
  setLayout: (l: Layout) => void;
  setBarPosition: (p: BarPosition) => void;
  openGroupMenu: (m: { x: number; y: number; groupId: string } | null) => void;
  setGroupColor: (id: string, color: string) => void;
  ungroupTabs: (id: string) => void;
  closeGroup: (id: string) => void;
  setTerminalBorder: (px: number) => void;
  setTabTitleWrap: (w: TitleWrap) => void;
  setGroupTint: (t: GroupTint) => void;
  setTheme: (t: ThemeId) => void;
  setTerminalFont: (f: Partial<TerminalFont>) => void;
  resetTerminalFont: () => void;
  markAnnouncementsSeen: (ids: string[]) => void;
  setPluginEnabled: (id: string, on: boolean) => void;
  setMiniPanel: (on: boolean) => void;
  setShowEvents: (on: boolean) => void;
  setErrorReportsAsked: (asked: boolean) => void;
  setMiniBounds: (b: MiniBounds) => void;
  setSplitMode: (m: SplitMode) => void;
  focusPane: (index: number) => void;
  openTabMenu: (m: { x: number; y: number; tabId: string } | null) => void;
  startPaneAssign: (tabId: string | null) => void;
  assignToPane: (tabId: string, index: number) => void;
  addQuestion: (q: QuestionItem) => void;
  addCommand: (c: CommandSuggestion) => void;
  dropCommand: (id: string) => void;
  setCommandQueued: (id: string, queued: boolean) => void;
  dropQuestion: (match: { id?: string; toolUseId?: string; tabId?: string }) => void;
}

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      groups: [],
      tabs: [],
      activeTabId: null,
      sidebarOpen: true,
      eventsOpen: true,
      events: [],
      setup: null,
      statusByTab: {},
      rateLimits: null,
      permissions: [],
      alerted: [],
      pinned: [],
      folders: [],
      defaultFolderId: null,
      modal: null,
      groupMenu: null,
      tabMenu: null,
      paneAssign: null,
      layout: "sidebar",
      barPosition: "top",
      terminalBorder: 1,
      tabTitleWrap: "wrap",
      groupTint: "subtle",
      theme: "classic",
      terminalFont: THEME_FONT,
      seenAnnouncements: [],
      enabledPlugins: defaultEnabledPlugins(),
      miniPanel: false,
      showEvents: false,
      errorReportsAsked: false,
      miniBounds: null,
      splitMode: "single",
      panes: [null, null, null, null],
      focusedPane: 0,
      questions: [],
      commands: [],
      detached: [],
      gitByTab: {},
      closedTabs: [],
      sessionGroups: {},
      searchTabId: null,
      subagentsByTab: {},

      addGroup: (name, folderId = null) => {
        const id = newId();
        const palette = THEMES[get().theme].groupColors;
        const color = palette[get().groups.length % palette.length];
        set((s) => {
          const created: Group = {
            id,
            name: name ?? `Grupo ${s.groups.filter((g) => !g.fixed).length + 1}`,
            color,
            collapsed: false,
            folderId,
          };
          const at = s.groups.findIndex((g) => g.id === UNGROUPED_ID);
          const groups = [...s.groups];
          groups.splice(at === -1 ? groups.length : at, 0, created);
          return { groups };
        });
        return id;
      },
      setGroupFolder: (id, folderId) =>
        set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, folderId } : g)) })),
      renameGroup: (id, name) =>
        set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)) })),
      cycleGroupColor: (id) =>
        set((s) => ({
          groups: s.groups.map((g) => {
            if (g.id !== id) return g;
            const palette = THEMES[s.theme].groupColors;
            const next = (palette.indexOf(g.color) + 1) % palette.length;
            return { ...g, color: palette[next] };
          }),
        })),
      toggleGroupCollapsed: (id) =>
        set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)) })),
      setGroupHidden: (id, hidden) =>
        set((s) => {
          if (id === UNGROUPED_ID) return s;
          const groups = s.groups.map((g) => (g.id === id ? { ...g, hidden } : g));
          if (!hidden) return { groups };
          // Hidden tabs leave the panes, and focus moves to a tab still in view.
          const gone = new Set(s.tabs.filter((t) => t.groupId === id).map((t) => t.id));
          const panes = s.panes.map((p) => (p && gone.has(p) ? null : p));
          const activeTabId =
            s.activeTabId && gone.has(s.activeTabId) ? (panes.find((p) => p != null) ?? null) : s.activeTabId;
          return { groups, panes, activeTabId };
        }),
      addGroupRule: (id, rule) =>
        set((s) => ({
          groups: s.groups.map((g) => {
            if (g.id !== id || g.allowRules?.some((r) => sameRule(r, rule))) return g;
            return { ...g, allowRules: [...(g.allowRules ?? []), rule] };
          }),
        })),
      removeGroupRule: (id, rule) =>
        set((s) => ({
          groups: s.groups.map((g) =>
            g.id === id ? { ...g, allowRules: (g.allowRules ?? []).filter((r) => !sameRule(r, rule)) } : g,
          ),
        })),
      removeGroup: (id) =>
        set((s) => {
          if (id === UNGROUPED_ID) return s;
          if (s.tabs.some((t) => t.groupId === id)) return s;
          return { groups: s.groups.filter((g) => g.id !== id) };
        }),

      addTab: (groupId, opts = {}) => {
        const id = newId();
        const tab: Tab = {
          id,
          groupId,
          title: opts.title ?? DEFAULT_TAB_TITLE,
          customTitle: opts.customTitle ?? false,
          cwd: opts.cwd ?? null,
          claudeSessionId: opts.claudeSessionId ?? null,
          state: "shell",
          lastEventAt: null,
          pendingMessage: null,
          transcriptPath: null,
          claudeTitle: null,
        };
        set((s) => {
          const panes = [...s.panes];
          // An empty pane takes the new tab before the focused one is replaced.
          const target = freePane(s) ?? s.focusedPane;
          panes[target] = id;
          return { tabs: [...s.tabs, tab], activeTabId: id, panes, focusedPane: target };
        });
        return id;
      },
      closeTab: (id) =>
        set((s) => {
          const tabs = s.tabs.filter((t) => t.id !== id);
          const panes = s.panes.map((p) => (p === id ? null : p));
          const { [id]: _dropped, ...statusByTab } = s.statusByTab;
          const permissions = s.permissions.filter((p) => p.tab_id !== id);
          const questions = s.questions.filter((q) => q.tab_id !== id);
          const commands = s.commands.filter((c) => c.tab_id !== id);
          const alerted = s.alerted.filter((a) => a !== id);
          const { [id]: _agents, ...subagentsByTab } = s.subagentsByTab;
          if (s.detached.includes(id)) closeDetachedWindow(id);
          const detached = s.detached.filter((d) => d !== id);
          const activeTabId =
            s.activeTabId === id ? (tabs.find((t) => t.state !== "dormant") ?? tabs[0])?.id ?? null : s.activeTabId;
          const closed = s.tabs.find((t) => t.id === id);
          const closedTabs = closed ? rememberClosed(s.closedTabs, [closed]) : s.closedTabs;
          return {
            tabs,
            activeTabId,
            panes,
            statusByTab,
            permissions,
            questions,
            commands,
            alerted,
            detached,
            closedTabs,
            subagentsByTab,
          };
        }),
      closePane: (id) =>
        set((s) => {
          const slot = s.panes.indexOf(id);
          if (slot === -1) return {};
          const panes = [...s.panes];
          panes[slot] = null;
          return { panes, activeTabId: s.activeTabId === id ? (panes[s.focusedPane] ?? null) : s.activeTabId };
        }),
      activateTab: (id) => {
        if (get().detached.includes(id)) return focusDetachedWindow(id);
        // Reopening a closed tab continues the session it was running.
        const previous = get().tabs.find((t) => t.id === id);
        if (previous?.state === "dormant" && previous.claudeSessionId) markPendingResume([id]);
        set((s) => {
          const panes = [...s.panes];
          // A tab already on screen keeps its pane and takes focus there;
          // otherwise an empty pane is used before the focused one is replaced.
          const existing = panes.indexOf(id);
          const target =
            existing !== -1 && existing < paneCount(s.splitMode) ? existing : (freePane(s) ?? s.focusedPane);
          panes[target] = id;
          return {
            activeTabId: id,
            focusedPane: target,
            panes,
            tabs: s.tabs.map((t) => (t.id === id && t.state === "dormant" ? { ...t, state: "shell" as TabState } : t)),
          };
        });
      },
      renameTab: (id, title) => {
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, title, customTitle: true } : t)) }));
        // Mirror the rename into Claude Code, but only with a session sitting
        // idle at its prompt: typing into a busy session would queue the line,
        // and into a plain shell would just print an error.
        const tab = get().tabs.find((t) => t.id === id);
        if (!tab?.claudeSessionId || tab.state !== "waiting") return;
        const safe = title.replace(/[\r\n]+/g, " ").trim().slice(0, 80);
        if (!safe) return;
        void invoke("pty_write", { id, data: `/rename ${safe}\r` }).catch(() => {});
      },
      moveTab: (id, groupId) =>
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, groupId } : t)) })),
      detachTab: (id, at) => {
        const s = get();
        const tab = s.tabs.find((t) => t.id === id);
        if (!tab || tab.state === "dormant" || s.detached.includes(id)) return;
        openDetachedWindow(id, tab.title, at);
        set((s) => {
          const panes = s.panes.map((p) => (p === id ? null : p));
          const activeTabId = s.activeTabId === id ? (panes.find((p) => p != null) ?? null) : s.activeTabId;
          return { detached: [...s.detached, id], panes, activeTabId };
        });
      },
      reattachTab: (id) => {
        if (!get().detached.includes(id)) return;
        set((s) => ({ detached: s.detached.filter((d) => d !== id) }));
        const tab = get().tabs.find((t) => t.id === id);
        if (tab && tab.state !== "dormant") get().activateTab(id);
      },
      rememberSessionGroups: () => {
        const s = get();
        let next: Record<string, string> | null = null;
        for (const t of s.tabs) {
          if (!t.claudeSessionId || s.sessionGroups[t.claudeSessionId] === t.groupId) continue;
          next ??= { ...s.sessionGroups };
          next[t.claudeSessionId] = t.groupId;
        }
        if (!next) return;
        // Keep the newest entries only; object keys keep insertion order.
        const keys = Object.keys(next);
        if (keys.length > SESSION_GROUPS_MAX) {
          for (const k of keys.slice(0, keys.length - SESSION_GROUPS_MAX)) delete next[k];
        }
        set({ sessionGroups: next });
      },
      openSearch: (searchTabId) => set({ searchTabId }),
      setSubagents: (tabId, list) =>
        set((s) => {
          const prev = s.subagentsByTab[tabId] ?? [];
          if (prev === list || (prev.length === 0 && list.length === 0)) return s;
          const { [tabId]: _dropped, ...rest } = s.subagentsByTab;
          return { subagentsByTab: list.length ? { ...rest, [tabId]: list } : rest };
        }),
      reopenClosedTab: () => {
        const s = get();
        const last = s.closedTabs[s.closedTabs.length - 1];
        if (!last) return;
        set({ closedTabs: s.closedTabs.slice(0, -1) });
        // The group may have been removed since; the tab then lands ungrouped.
        const kept = s.groups.some((g) => g.id === last.groupId);
        if (!kept) ensureUngrouped();
        const groupId = kept ? last.groupId : UNGROUPED_ID;
        const id = get().addTab(groupId, {
          cwd: last.cwd,
          claudeSessionId: last.claudeSessionId ?? undefined,
          title: last.title,
          customTitle: last.customTitle,
        });
        if (last.claudeSessionId) markPendingResume([id]);
      },
      setGitInfo: (id, info) =>
        set((s) => {
          const prev = s.gitByTab[id];
          if (!info) {
            if (!prev) return s;
            const { [id]: _dropped, ...gitByTab } = s.gitByTab;
            return { gitByTab };
          }
          const same =
            prev &&
            prev.branch === info.branch &&
            prev.added === info.added &&
            prev.removed === info.removed &&
            prev.files === info.files;
          return same ? s : { gitByTab: { ...s.gitByTab, [id]: info } };
        }),
      patchTab: (id, patch) =>
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),

      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleEvents: () => set((s) => ({ eventsOpen: !s.eventsOpen })),
      pushEvent: (e) => set((s) => ({ events: [e, ...s.events].slice(0, 500) })),
      clearEvents: () => set({ events: [] }),
      setSetup: (setup) => set({ setup }),
      applyStatus: (e) =>
        set((s) => {
          const next: Partial<Store> = {};
          if (e.tab_id) next.statusByTab = { ...s.statusByTab, [e.tab_id]: e.payload };
          const rl = e.payload.rate_limits;
          if (rl && (!s.rateLimits || e.received_at >= s.rateLimits.receivedAt)) {
            next.rateLimits = { ...rl, receivedAt: e.received_at, fromTabId: e.tab_id };
          }
          return next;
        }),
      addPermission: (p) => set((s) => ({ permissions: [...s.permissions, p] })),
      dropPermission: (id) => set((s) => ({ permissions: s.permissions.filter((p) => p.id !== id) })),
      markAlerted: (tabId) =>
        set((s) => (s.alerted.includes(tabId) ? s : { alerted: [...s.alerted, tabId] })),
      clearAlerted: (tabId) => set((s) => ({ alerted: s.alerted.filter((a) => a !== tabId) })),
      addFolder: (name, path) => {
        const existing = get().folders.find((f) => f.path === path);
        if (existing) return existing.id;
        const id = newId();
        set((s) => ({
          folders: [...s.folders, { id, name, path }],
          defaultFolderId: s.defaultFolderId ?? id,
        }));
        return id;
      },
      renameFolder: (id, name) =>
        set((s) => ({ folders: s.folders.map((f) => (f.id === id ? { ...f, name } : f)) })),
      removeFolder: (id) =>
        set((s) => ({
          folders: s.folders.filter((f) => f.id !== id),
          defaultFolderId: s.defaultFolderId === id ? null : s.defaultFolderId,
          groups: s.groups.map((g) => (g.folderId === id ? { ...g, folderId: null } : g)),
        })),
      setDefaultFolder: (id) => set({ defaultFolderId: id }),
      openModal: (modal) => set({ modal }),
      setLayout: (layout) => set({ layout }),
      setBarPosition: (barPosition) => set({ barPosition }),
      openGroupMenu: (groupMenu) => set({ groupMenu }),
      setGroupColor: (id, color) =>
        set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, color } : g)) })),
      ungroupTabs: (id) =>
        set((s) => {
          if (id === UNGROUPED_ID) return s;
          return {
            tabs: s.tabs.map((t) => (t.groupId === id ? { ...t, groupId: UNGROUPED_ID } : t)),
            groups: s.groups.filter((g) => g.id !== id),
          };
        }),
      closeGroup: (id) =>
        set((s) => {
          if (id === UNGROUPED_ID) return s;
          const doomed = new Set(s.tabs.filter((t) => t.groupId === id).map((t) => t.id));
          const tabs = s.tabs.filter((t) => !doomed.has(t.id));
          s.detached.filter((d) => doomed.has(d)).forEach(closeDetachedWindow);
          const statusByTab = Object.fromEntries(
            Object.entries(s.statusByTab).filter(([k]) => !doomed.has(k)),
          );
          return {
            tabs,
            groups: s.groups.filter((g) => g.id !== id),
            statusByTab,
            permissions: s.permissions.filter((p) => !p.tab_id || !doomed.has(p.tab_id)),
            questions: s.questions.filter((q) => !q.tab_id || !doomed.has(q.tab_id)),
            commands: s.commands.filter((c) => !c.tab_id || !doomed.has(c.tab_id)),
            alerted: s.alerted.filter((a) => !doomed.has(a)),
            detached: s.detached.filter((d) => !doomed.has(d)),
            closedTabs: rememberClosed(s.closedTabs, s.tabs.filter((t) => doomed.has(t.id))),
            activeTabId: doomed.has(s.activeTabId ?? "") ? (tabs[0]?.id ?? null) : s.activeTabId,
          };
        }),
      setTerminalBorder: (terminalBorder) => set({ terminalBorder }),
      setTabTitleWrap: (tabTitleWrap) => set({ tabTitleWrap }),
      setGroupTint: (groupTint) => set({ groupTint }),
      setTheme: (theme) => set({ theme }),
      setTerminalFont: (f) => set((s) => ({ terminalFont: { ...s.terminalFont, ...f } })),
      resetTerminalFont: () => set({ terminalFont: THEME_FONT }),
      setPluginEnabled: (id, on) =>
        set((s) => ({
          enabledPlugins: on ? [...new Set([...s.enabledPlugins, id])] : s.enabledPlugins.filter((p) => p !== id),
        })),
      markAnnouncementsSeen: (ids) =>
        set((s) => ({ seenAnnouncements: [...new Set([...s.seenAnnouncements, ...ids])] })),
      setMiniPanel: (miniPanel) => set({ miniPanel }),
      setShowEvents: (showEvents) => set({ showEvents }),
      setErrorReportsAsked: (errorReportsAsked) => set({ errorReportsAsked }),
      setMiniBounds: (miniBounds) => set({ miniBounds }),
      setSplitMode: (splitMode) =>
        set((s) => {
          // Fill any pane the new layout exposes with a tab not already shown.
          const panes = [...s.panes];
          const shown = new Set(panes.filter(Boolean) as string[]);
          const spare = s.tabs.filter((t) => t.state !== "dormant" && !shown.has(t.id));
          for (let i = 0; i < paneCount(splitMode); i++) {
            if (!panes[i] || !s.tabs.some((t) => t.id === panes[i])) {
              const next = spare.shift();
              panes[i] = next ? next.id : null;
              if (next) shown.add(next.id);
            }
          }
          const focusedPane = Math.min(s.focusedPane, paneCount(splitMode) - 1);
          return { splitMode, panes, focusedPane, activeTabId: panes[focusedPane] ?? s.activeTabId };
        }),
      focusPane: (index) =>
        set((s) => ({ focusedPane: index, activeTabId: s.panes[index] ?? s.activeTabId })),
      openTabMenu: (tabMenu) => set({ tabMenu }),
      startPaneAssign: (paneAssign) => set({ paneAssign, tabMenu: null }),
      assignToPane: (tabId, index) => {
        const previous = get().tabs.find((t) => t.id === tabId);
        if (previous?.state === "dormant" && previous.claudeSessionId) markPendingResume([tabId]);
        // Placing a tab that lives in its own window brings it back first.
        if (get().detached.includes(tabId)) closeDetachedWindow(tabId);
        set((s) => {
          const panes = [...s.panes];
          // A tab can only be in one pane; free the one it came from.
          const from = panes.indexOf(tabId);
          if (from !== -1) panes[from] = null;
          panes[index] = tabId;
          return {
            panes,
            paneAssign: null,
            detached: s.detached.filter((d) => d !== tabId),
            focusedPane: index,
            activeTabId: tabId,
            tabs: s.tabs.map((t) => (t.id === tabId && t.state === "dormant" ? { ...t, state: "shell" as TabState } : t)),
          };
        });
      },
      addQuestion: (q) => set((s) => ({ questions: [...s.questions, q] })),
      addCommand: (c) => set((s) => ({ commands: [...s.commands, c] })),
      dropCommand: (id) => set((s) => ({ commands: s.commands.filter((c) => c.id !== id) })),
      setCommandQueued: (id, queued) =>
        set((s) => ({ commands: s.commands.map((c) => (c.id === id ? { ...c, queued } : c)) })),
      dropQuestion: ({ id, toolUseId, tabId }) =>
        set((s) => ({
          questions: s.questions.filter(
            (q) =>
              !(
                (id !== undefined && q.id === id) ||
                (toolUseId !== undefined && q.tool_use_id === toolUseId) ||
                (tabId !== undefined && q.tab_id === tabId)
              ),
          ),
        })),
      togglePinned: (sessionId) =>
        set((s) => ({
          pinned: s.pinned.includes(sessionId)
            ? s.pinned.filter((p) => p !== sessionId)
            : [sessionId, ...s.pinned],
        })),
    }),
    {
      name: "claude-terminal-layout",
      version: 2,
      storage: createJSONStorage(() => fileStorage),
      // main.tsx rehydrates before the first render; see persist.ts.
      skipHydration: true,
      // v1 layouts predate pinned sessions; everything else carries over.
      migrate: (persisted) => {
        const prev = (persisted ?? {}) as Record<string, unknown>;
        return {
          ...prev,
          pinned: Array.isArray(prev.pinned) ? prev.pinned : [],
          folders: Array.isArray(prev.folders) ? prev.folders : [],
          groups: (Array.isArray(prev.groups) ? prev.groups : []).map((g: Record<string, unknown>) => ({
            ...g,
            folderId: typeof g.folderId === "string" ? g.folderId : null,
          })),
        } as never;
      },
      // Ptys do not survive a restart, so every tab comes back dormant.
      partialize: (s) => ({
        groups: s.groups,
        tabs: s.tabs.map((t) => ({ ...t, state: "dormant" as TabState, pendingMessage: null })),
        activeTabId: s.activeTabId,
        sidebarOpen: s.sidebarOpen,
        eventsOpen: s.eventsOpen,
        pinned: s.pinned,
        folders: s.folders,
        defaultFolderId: s.defaultFolderId,
        layout: s.layout,
        barPosition: s.barPosition,
        terminalBorder: s.terminalBorder,
        tabTitleWrap: s.tabTitleWrap,
        groupTint: s.groupTint,
        theme: s.theme,
        terminalFont: s.terminalFont,
        seenAnnouncements: s.seenAnnouncements,
        enabledPlugins: s.enabledPlugins,
        miniPanel: s.miniPanel,
        showEvents: s.showEvents,
        errorReportsAsked: s.errorReportsAsked,
        miniBounds: s.miniBounds,
        sessionGroups: s.sessionGroups,
        splitMode: s.splitMode,
        panes: s.panes,
      }),
    },
  ),
);

/** Adds the catch-all group when missing and keeps it last in the list. */
export function ensureUngrouped(): void {
  const s = useStore.getState();
  const existing = s.groups.find((g) => g.id === UNGROUPED_ID);
  const rest = s.groups.filter((g) => g.id !== UNGROUPED_ID);
  const catchAll: Group = existing ?? {
    id: UNGROUPED_ID,
    name: UNGROUPED_NAME,
    color: UNGROUPED_COLOR,
    collapsed: false,
    folderId: null,
    fixed: true,
  };
  if (existing && rest.length === s.groups.length - 1 && s.groups[s.groups.length - 1]?.id === UNGROUPED_ID) {
    return;
  }
  useStore.setState({ groups: [...rest, catchAll] });
}

/**
 * Opens a session in a group: straight into the group's base folder when it has
 * one, otherwise through the folder picker.
 */
export function openSessionInGroup(groupId: string): void {
  const s = useStore.getState();
  const group = s.groups.find((g) => g.id === groupId);
  // The catch-all group has no folder of its own; it always uses the base folder.
  const wanted = group?.fixed ? s.defaultFolderId : group?.folderId;
  const folder = wanted ? s.folders.find((f) => f.id === wanted) : undefined;
  if (folder) {
    s.addTab(groupId, { cwd: folder.path, title: folder.name });
    return;
  }
  s.openModal({ kind: "pickFolder", groupId });
}

/** Ensures at least one group exists and returns the group for new tabs. */
export function defaultGroupId(): string {
  const s = useStore.getState();
  const active = s.tabs.find((t) => t.id === s.activeTabId);
  if (active) return active.groupId;
  if (s.groups.some((g) => g.id === UNGROUPED_ID)) return UNGROUPED_ID;
  if (s.groups[0]) return s.groups[0].id;
  ensureUngrouped();
  return UNGROUPED_ID;
}

/** A Claude session to open, as the sessions list and a drag describe it. */
export interface SessionRef {
  id: string;
  cwd: string | null;
  title: string;
}

/**
 * Opens a saved Claude session. A session already in a tab goes to that tab.
 * Otherwise it lands in the group given, else the last group it sat in, else
 * the group whose base folder is its folder, else the catch-all group. With a
 * pane index, it opens in that pane.
 */
export function openSession(ref: SessionRef, opts: { groupId?: string; pane?: number } = {}): void {
  const s = useStore.getState();
  const existing = s.tabs.find((t) => t.claudeSessionId === ref.id);
  if (existing) {
    if (opts.groupId && opts.groupId !== existing.groupId) s.moveTab(existing.id, opts.groupId);
    if (opts.pane !== undefined) s.assignToPane(existing.id, opts.pane);
    else s.activateTab(existing.id);
    return;
  }
  const exists = (id: string | undefined) => !!id && s.groups.some((g) => g.id === id);
  const remembered = s.sessionGroups[ref.id];
  const byFolder = s.groups.find(
    (g) => !g.fixed && g.folderId && s.folders.find((f) => f.id === g.folderId)?.path === ref.cwd,
  )?.id;
  let groupId = [opts.groupId, remembered, byFolder].find(exists);
  if (!groupId) {
    ensureUngrouped();
    groupId = UNGROUPED_ID;
  }
  const tabId = s.addTab(groupId, { cwd: ref.cwd, claudeSessionId: ref.id, title: ref.title, customTitle: true });
  markPendingResume([tabId]);
  if (opts.pane !== undefined) useStore.getState().assignToPane(tabId, opts.pane);
}

/** Drag payload type for a session from the sessions list. */
export const SESSION_DRAG = "application/x-claude-session";

export function sessionFromDrag(data: DataTransfer): SessionRef | null {
  const raw = data.getData(SESSION_DRAG);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionRef;
  } catch {
    return null;
  }
}
