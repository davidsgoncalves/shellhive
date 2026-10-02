import { useState, type DragEvent } from "react";
import { openSession, openSessionInGroup, sessionFromDrag, useStore } from "../lib/store";
import { droppedOutside } from "../lib/detach";
import { HiddenGroups } from "./HiddenGroups";
import { STATE_LABEL, type GitInfo, type Group, type StatusPayload, type Subagent, type Tab } from "../lib/types";
import { shortcutLabel } from "../lib/shortcuts";
import { ColumnResizer } from "./ColumnResizer";

function ctxClass(pct: number): string {
  if (pct >= 90) return "crit";
  if (pct >= 70) return "warn";
  return "ok";
}

/** Context gauge for one tab: a thin ring plus the percentage. */
function ContextGauge({ status }: { status: StatusPayload | undefined }) {
  const pct = status?.context_window?.used_percentage;
  if (status == null || pct == null) return null;
  const rounded = Math.round(pct);
  const size = status.context_window?.context_window_size;
  const tokens = status.context_window?.total_input_tokens;
  const title = [
    `Contexto ${rounded}% usado`,
    tokens != null && size ? `${(tokens / 1000).toFixed(0)}k de ${(size / 1000).toFixed(0)}k tokens` : null,
    status.cost?.total_cost_usd != null ? `$${status.cost.total_cost_usd.toFixed(2)} nesta sessão` : null,
    status.model?.display_name,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className={`ctx-gauge ${ctxClass(rounded)}`} title={title}>
      <span className="ctx-ring" style={{ ["--pct" as string]: `${Math.min(100, rounded)}%` }} />
      <span className="ctx-num">{rounded}%</span>
    </span>
  );
}

function InlineName({ value, onCommit, className }: { value: string; onCommit: (v: string) => void; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing) {
    return (
      <span
        className={className}
        title="Duplo clique para renomear"
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDraft(value);
          setEditing(true);
        }}
      >
        {value}
      </span>
    );
  }
  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== value) onCommit(v);
  };
  return (
    <input
      className="inline-edit"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

const SUBAGENT_LINES = 3;

/** Subagents the session is running, under the tab's name. */
function SubagentLines({ agents }: { agents: Subagent[] }) {
  const extra = agents.length - SUBAGENT_LINES;
  return (
    <span className="tab-agents">
      {agents.slice(0, SUBAGENT_LINES).map((a) => (
        <span key={a.id} className="tab-agent" title={a.type ? `${a.type}: ${a.description}` : a.description}>
          <span className="agent-mark">⑂</span>
          {a.type && <span className="agent-type">{a.type}</span>}
          <span className="agent-desc">{a.description}</span>
        </span>
      ))}
      {extra > 0 && <span className="tab-agent more">+{extra} subagente(s)</span>}
    </span>
  );
}

/** Branch and pending changes under a tab's name. */
function GitLine({ git }: { git: GitInfo }) {
  const dirty = git.files > 0;
  return (
    <span
      className="tab-git"
      title={dirty ? `${git.branch} · ${git.files} arquivo(s) alterado(s), +${git.added} −${git.removed}` : `${git.branch} · sem alterações`}
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

function TabRow({ tab, active }: { tab: Tab; active: boolean }) {
  const { activateTab, closeTab, renameTab, openTabMenu, detachTab } = useStore();
  const isDetached = useStore((s) => s.detached.includes(tab.id));
  const status = useStore((s) => s.statusByTab[tab.id]);
  const stale = useStore((s) => s.alerted.includes(tab.id));
  const wrap = useStore((s) => s.tabTitleWrap === "wrap");
  const git = useStore((s) => s.gitByTab[tab.id]);
  const agents = useStore((s) => s.subagentsByTab[tab.id]);
  const pinned = useStore((s) => !!tab.claudeSessionId && s.pinned.includes(tab.claudeSessionId));
  const badges = useStore((s) => s.pluginBadges[tab.id]);
  const badgeList = badges ? Object.entries(badges) : [];
  return (
    <li
      className={`tab-row state-${tab.state} ${active ? "active" : ""} ${stale ? "stale" : ""} ${wrap ? "wrap" : ""}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/tab-id", tab.id)}
      onDragEnd={(e) => {
        if (e.dataTransfer.dropEffect === "none" && droppedOutside(e)) detachTab(tab.id, { x: e.screenX, y: e.screenY });
      }}
      onClick={() => activateTab(tab.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openTabMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
      }}
      title={tab.pendingMessage ?? STATE_LABEL[tab.state]}
    >
      <span className="dot" />
      {pinned && (
        <span className="tab-pin" title="Sessão fixada">
          ★
        </span>
      )}
      <span className="tab-main">
        <InlineName value={tab.title} onCommit={(v) => renameTab(tab.id, v)} className="tab-title" />
        {git && <GitLine git={git} />}
        {badgeList.length > 0 && (
          <span className="tab-badges">
            {badgeList.map(([plugin, text]) => (
              <span key={plugin} className="tab-badge" title={`${text} · ${plugin}`}>
                {text}
              </span>
            ))}
          </span>
        )}
        {agents && agents.length > 0 && <SubagentLines agents={agents} />}
      </span>
      <span className="tab-trailing">
        {isDetached && (
          <span className="detached-mark" title="Em outra janela · clique para trazer à frente">
            ↗
          </span>
        )}
        <ContextGauge status={status} />
        <button
          className="icon-btn close"
          title="Fechar aba"
          onClick={(e) => {
            e.stopPropagation();
            closeTab(tab.id);
          }}
        >
          ×
        </button>
      </span>
    </li>
  );
}

function GroupSection({ group, tabs, activeTabId }: { group: Group; tabs: Tab[]; activeTabId: string | null }) {
  const { renameGroup, toggleGroupCollapsed, moveTab, folders, defaultFolderId, openGroupMenu } = useStore();
  const folder = folders.find((f) => f.id === group.folderId);
  const baseFolder = folders.find((f) => f.id === defaultFolderId);
  const [over, setOver] = useState(false);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const id = e.dataTransfer.getData("text/tab-id");
    if (id) return moveTab(id, group.id);
    const session = sessionFromDrag(e.dataTransfer);
    if (session) openSession(session, { groupId: group.id });
  };

  const pending = tabs.filter((t) => t.state === "permission").length;

  return (
    <section
      className={`group ${group.fixed ? "fixed" : ""} ${over ? "drag-over" : ""}`}
      style={{ ["--group-color" as string]: group.color }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      onContextMenu={(e) => {
        if (group.fixed) return;
        e.preventDefault();
        openGroupMenu({ x: e.clientX, y: e.clientY, groupId: group.id });
      }}
    >
      <header className="group-header" title={group.fixed ? undefined : "Botão direito abre o menu do grupo"}>
        <button className="icon-btn chevron" onClick={() => toggleGroupCollapsed(group.id)}>
          {group.collapsed ? "›" : "⌄"}
        </button>
        <span className={`swatch ${group.fixed ? "fixed" : ""}`} title={group.fixed ? "Grupo fixo" : undefined} />
        {group.fixed ? (
          <span className="group-name">{group.name}</span>
        ) : (
          <InlineName value={group.name} onCommit={(v) => renameGroup(group.id, v)} className="group-name" />
        )}
        {folder && !group.fixed && (
          <span className="group-folder" title={folder.path}>
            {folder.name}
          </span>
        )}
        {group.fixed && baseFolder && (
          <span className="group-folder" title={`Pasta base: ${baseFolder.path}`}>
            {baseFolder.name}
          </span>
        )}
        {pending > 0 && <span className="badge">{pending}</span>}
        <span className="count">{tabs.length}</span>
        <button
          className="icon-btn"
          title={folder ? `Nova sessão em ${folder.path}` : "Nova sessão neste grupo"}
          onClick={() => openSessionInGroup(group.id)}
        >
          +
        </button>

      </header>
      {!group.collapsed && (
        <ul className="tab-list">
          {tabs.map((t) => (
            <TabRow key={t.id} tab={t} active={t.id === activeTabId} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function Sidebar() {
  const { tabs, activeTabId, sidebarOpen, toggleSidebar, openModal, groupTint } = useStore();
  const groups = useStore((s) => s.groups).filter((g) => !g.hidden);
  const width = useStore((s) => s.columnWidths.sidebar);

  if (!sidebarOpen) {
    return (
      <aside className="sidebar collapsed">
        <button className="icon-btn" title={`Mostrar sessões (${shortcutLabel("sidebar")})`} onClick={toggleSidebar}>
          »
        </button>
        <div className="rail">
          {groups.map((g) => {
            const gt = tabs.filter((t) => t.groupId === g.id);
            const pending = gt.some((t) => t.state === "permission");
            return (
              <div
                key={g.id}
                className={`rail-group ${pending ? "pending" : ""}`}
                style={{ background: g.color }}
                title={`${g.name} · ${gt.length}`}
              >
                {gt.length}
              </div>
            );
          })}
        </div>
      </aside>
    );
  }

  return (
    <aside className={`sidebar tint-${groupTint}`} style={width ? { width } : undefined}>
      <ColumnResizer column="sidebar" />
      <header className="sidebar-header">
        <h1>Sessões</h1>
        <button className="icon-btn" title={`Recolher (${shortcutLabel("sidebar")})`} onClick={toggleSidebar}>
          «
        </button>
      </header>
      <div className="groups">
        {groups.map((g) => (
          <GroupSection key={g.id} group={g} tabs={tabs.filter((t) => t.groupId === g.id)} activeTabId={activeTabId} />
        ))}
      </div>
      <footer className="sidebar-footer">
        <HiddenGroups variant="sidebar" />
        <button className="ghost" onClick={() => openModal({ kind: "newGroup" })}>
          + Novo grupo
        </button>
      </footer>
    </aside>
  );
}
