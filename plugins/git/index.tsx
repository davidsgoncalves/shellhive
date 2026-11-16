import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { PluginHost, ShellhivePlugin } from "../../src/lib/plugins";
import { useStore } from "../../src/lib/store";
import { RailIcon } from "../../src/components/RailIcon";
import type { HookEvent, Tab } from "../../src/lib/types";
import { api, baseName } from "./api";
import { GitPanel } from "./GitPanel";
import { useGit } from "./state";
import { CloseOfferDialog, WorktreeList } from "./worktrees";
import manifest from "./plugin.json";
import "./git.css";

const POLL_MS = 10_000;

/** Keeps each live tab's branch and pending changes current. */
function useInfoPoll() {
  useEffect(() => {
    const refresh = (tabId: string) => {
      const tab = useStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab?.cwd) return;
      api
        .info(tab.cwd)
        .then((info) => useGit.getState().setInfo(tabId, info))
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
    const id = setInterval(tick, POLL_MS);
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

/** Offers to remove the worktrees a tab created once it closes. */
function useCloseOffers() {
  useEffect(() => {
    void useGit.getState().load();
    return useStore.subscribe((s, prev) => {
      if (s.tabs === prev.tabs) return;
      const ids = new Set(s.tabs.map((t) => t.id));
      for (const gone of prev.tabs.filter((t) => !ids.has(t.id))) {
        useGit.getState().hide(gone.id);
        const mine = useGit.getState().created.filter((c) => c.tabId === gone.id);
        if (mine.length) useGit.getState().offer({ tabTitle: gone.title, worktrees: mine });
      }
    });
  }, []);
}

function GitOverlay({ host }: { host: PluginHost }) {
  const open = useGit((s) => s.open);
  useInfoPoll();
  useCloseOffers();
  return (
    <>
      {Object.entries(open).map(([tabId, panel]) => (
        <GitPanel key={tabId} tabId={tabId} panel={panel} rect={host.paneRect(tabId)} />
      ))}
      <CloseOfferDialog />
    </>
  );
}

/** Branch and pending changes under a tab's name; opens the panel. */
function GitLine({ tab }: { tab: Tab }) {
  const git = useGit((s) => s.info[tab.id]);
  if (!git) return null;
  const dirty = git.files > 0;
  return (
    <span
      className="tab-git"
      title={`${dirty ? `${git.branch} · ${git.files} arquivo(s) alterado(s), +${git.added} −${git.removed}` : `${git.branch} · sem alterações`} · clique para abrir o painel Git`}
      onClick={(e) => {
        e.stopPropagation();
        useStore.getState().activateTab(tab.id);
        useGit.getState().show(tab.id);
      }}
    >
      <span className="git-branch">⎇ {git.branch}</span>
      {dirty && (
        <>
          <span className="git-add">+{git.added}</span>
          <span className="git-del">−{git.removed}</span>
        </>
      )}
    </span>
  );
}

const plugin: ShellhivePlugin = {
  manifest,
  Overlay: GitOverlay,
  TabLine: GitLine,
  tabHint: (tabId) => {
    const branch = useGit.getState().info[tabId]?.branch;
    return branch ? `⎇ ${branch}` : null;
  },
  SideTab: {
    title: "Git",
    Component: WorktreeList,
    icon: (
      <RailIcon>
        <circle cx="6" cy="6" r="2" />
        <circle cx="6" cy="18" r="2" />
        <circle cx="18" cy="8" r="2" />
        <path d="M6 8v8M18 10c0 4-6 3-11.5 6.5" />
      </RailIcon>
    ),
  },
  tools: {
    git_worktrees: async (_args, { tabId }) => {
      if (!tabId) return { text: "Esta chamada não veio de uma aba do Shellhive.", isError: true };
      const s = useStore.getState();
      const tab = s.tabs.find((t) => t.id === tabId);
      await useGit.getState().load();
      const extra = [tab?.cwd, ...useGit.getState().created.filter((c) => c.tabId === tabId).map((c) => c.root)].filter(
        (p): p is string => !!p,
      );
      const roots = await api.tabWorktrees(tabId, extra);
      const lines: string[] = [];
      for (const { root } of roots) {
        const info = await api.worktree(root).catch(() => null);
        if (!info) continue;
        const sync = info.ahead == null ? "" : ` ↑${info.ahead} ↓${info.behind ?? 0}`;
        const where = info.main ? baseName(root) : `${baseName(info.repo)} · worktree ${baseName(root)}`;
        lines.push(`${where} (${info.branch ?? "detached"}) · ${info.files.length} alterado(s)${sync} · ${root}`);
      }
      const onScreen = s.panes.includes(tabId) && !s.detached.includes(tabId);
      if (onScreen && roots.length) useGit.getState().show(tabId);
      const text = lines.length ? lines.join("\n") : "Nenhum repositório git nesta aba ainda.";
      return { text: onScreen && roots.length ? `${text}\n\nPainel Git aberto sobre o terminal desta aba.` : text };
    },
  },
};

export default plugin;
