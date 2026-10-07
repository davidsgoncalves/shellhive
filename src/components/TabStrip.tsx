import { useState, type DragEvent } from "react";
import { openSession, openSessionInGroup, sessionFromDrag, useStore } from "../lib/store";
import { droppedOutside } from "../lib/detach";
import { HiddenGroups } from "./HiddenGroups";
import { STATE_LABEL, type Group, type Tab } from "../lib/types";

function StripTab({ tab, active }: { tab: Tab; active: boolean }) {
  const { activateTab, closeTab, openTabMenu, detachTab } = useStore();
  const isDetached = useStore((s) => s.detached.includes(tab.id));
  const branch = useStore((s) => s.gitByTab[tab.id]?.branch);
  const stale = useStore((s) => s.alerted.includes(tab.id));
  const pct = useStore((s) => s.statusByTab[tab.id]?.context_window?.used_percentage);
  const showPct = pct != null && (active || pct >= 70);
  return (
    <div
      className={`strip-tab state-${tab.state} ${active ? "active" : ""} ${stale ? "stale" : ""}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/tab-id", tab.id)}
      onDragEnd={(e) => {
        if (e.dataTransfer.dropEffect === "none" && droppedOutside(e)) detachTab(tab.id, { x: e.screenX, y: e.screenY });
      }}
      onClick={() => activateTab(tab.id)}
      onAuxClick={(e) => {
        if (e.button === 1) closeTab(tab.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openTabMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
      }}
      title={tab.pendingMessage ?? [tab.title, STATE_LABEL[tab.state], branch && `⎇ ${branch}`].filter(Boolean).join(" · ")}
    >
      <span className="dot" />
      <span className="strip-title">{tab.title}</span>
      {isDetached && (
        <span className="detached-mark" title="Em outra janela">
          ↗
        </span>
      )}
      {showPct && <span className="strip-ctx">{Math.round(pct)}%</span>}
      <button
        className="strip-close"
        title="Fechar aba"
        onClick={(e) => {
          e.stopPropagation();
          closeTab(tab.id);
        }}
      >
        ×
      </button>
    </div>
  );
}

function GroupLabel({ group, count }: { group: Group; count: number }) {
  const { toggleGroupCollapsed, openGroupMenu } = useStore();
  return (
    <button
      className="group-pill"
      title="Clique recolhe · botão direito abre o menu"
      onClick={() => toggleGroupCollapsed(group.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        openGroupMenu({ x: e.clientX, y: e.clientY, groupId: group.id });
      }}
    >
      {group.emoji && <span className="group-emoji">{group.emoji}</span>}
      {group.name}
      {group.collapsed && <span className="pill-count">{count}</span>}
    </button>
  );
}

function GroupSegment({ group, tabs, activeTabId }: { group: Group; tabs: Tab[]; activeTabId: string | null }) {
  const moveTab = useStore((s) => s.moveTab);
  const [over, setOver] = useState(false);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const id = e.dataTransfer.getData("text/tab-id");
    if (id) return moveTab(id, group.id);
    const session = sessionFromDrag(e.dataTransfer);
    if (session) openSession(session, { groupId: group.id });
  };
  const dropProps = {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop,
  };

  // Ungrouped tabs sit bare in the strip, as in a browser with no group.
  if (group.fixed) {
    return (
      <div className={`strip-loose ${over ? "drag-over" : ""}`} {...dropProps}>
        {tabs.map((t) => (
          <StripTab key={t.id} tab={t} active={t.id === activeTabId} />
        ))}
        <button className="strip-plus" title="Nova sessão" onClick={() => openSessionInGroup(group.id)}>
          +
        </button>
      </div>
    );
  }

  return (
    <div
      className={`strip-group ${over ? "drag-over" : ""} ${group.collapsed ? "collapsed" : ""}`}
      style={{ ["--group-color" as string]: group.color }}
      {...dropProps}
    >
      <GroupLabel group={group} count={tabs.length} />
      {!group.collapsed && (
        <>
          {tabs.map((t) => (
            <StripTab key={t.id} tab={t} active={t.id === activeTabId} />
          ))}
          <button className="strip-plus in-group" title="Nova sessão neste grupo" onClick={() => openSessionInGroup(group.id)}>
            +
          </button>
        </>
      )}
    </div>
  );
}

/** Horizontal tab bar with Chrome-style groups, chosen in settings. */
export function TabStrip() {
  const { groups, tabs, activeTabId, openModal, groupTint } = useStore();
  const ordered = [
    ...groups.filter((g) => !g.fixed && !g.hidden && tabs.some((t) => t.groupId === g.id)),
    ...groups.filter((g) => g.fixed),
  ];
  return (
    <div className={`tab-strip tint-${groupTint}`}>
      <div className="strip-scroll">
        {ordered.map((g) => (
          <GroupSegment key={g.id} group={g} tabs={tabs.filter((t) => t.groupId === g.id)} activeTabId={activeTabId} />
        ))}
      </div>
      <HiddenGroups variant="strip" />
      <button className="strip-new-group" title="Novo grupo" onClick={() => openModal({ kind: "newGroup" })}>
        + Novo grupo
      </button>
    </div>
  );
}
