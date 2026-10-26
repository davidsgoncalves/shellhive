import { useState } from "react";
import { useStore } from "../lib/store";
import { PermissionQueue, useQueued } from "./PermissionQueue";
import { PluginSidePanel } from "./LocalPluginPanel";
import { SessionsBrowser } from "./SessionsBrowser";
import { EventsList } from "./EventsPanel";
import { SessionsPanel } from "./Sidebar";
import { shortcutLabel } from "../lib/shortcuts";
import { PLUGINS } from "../lib/plugins";
import { ColumnResizer } from "./ColumnResizer";
import { RailIcon } from "./RailIcon";
import { BeePanel, NewBeeButton, useBeeWaiting } from "./WorkerBee";

type PanelTab = "tabs" | "queue" | "sessions" | "bees" | "events" | `plugin:${string}` | `official:${string}`;

/** Drag payload type for an icon of the rail. */
const PANEL_TAB_DRAG = "application/x-panel-tab";

/** Icons in the order the user set; icons never moved keep their place after them. */
function inOrder<T extends { key: string }>(tabs: T[], order: string[]): T[] {
  const rank = (key: string) => {
    const i = order.indexOf(key);
    return i === -1 ? order.length : i;
  };
  return tabs.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t.key) - rank(b.t.key) || a.i - b.i).map(({ t }) => t);
}

interface RailTab {
  key: PanelTab;
  label: string;
  icon: React.ReactNode;
  badge?: number;
  hint?: string;
}

const ICONS = {
  tabs: <RailIcon><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 9v11" /></RailIcon>,
  queue: <RailIcon><path d="M4 13h4l2 3h4l2-3h4" /><path d="M4 13l2.5-7h11L20 13v6H4z" /></RailIcon>,
  sessions: <RailIcon><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></RailIcon>,
  events: <RailIcon><path d="M3 12h4l3-7 4 14 3-7h4" /></RailIcon>,
  bees: <RailIcon><path d="M12 3l7.5 4.5v9L12 21l-7.5-4.5v-9z" /><path d="M9 10.5h6M9 13.5h6" /></RailIcon>,
};

/** Up to two letters standing for a plugin that has no icon of its own. */
function initials(title: string): string {
  const words = title.split(/\s+/).filter(Boolean);
  const text = words.length > 1 ? words[0][0] + words[1][0] : title.slice(0, 2);
  return text.toUpperCase();
}

/**
 * The rail of icons on the left and the one panel it switches. Clicking the
 * open icon closes the panel; icons are dragged to reorder them.
 */
export function SidePanel() {
  const { panelOpen, togglePanel, showEvents, groupTint } = useStore();
  const layout = useStore((s) => s.layout);
  const queued = useQueued();
  const pending = queued.permissions.length + queued.questions.length + queued.commands.length + queued.approvals;
  const beeWaiting = useBeeWaiting();
  const localPlugins = useStore((s) => s.localPlugins);
  const enabledPlugins = useStore((s) => s.enabledPlugins);
  const sidePlugins = localPlugins.filter(
    (p) => p.status === "approved" && p.sidePanel && enabledPlugins.includes(p.id),
  );
  const officialTabs = PLUGINS.filter((p) => p.SideTab && enabledPlugins.includes(p.manifest.id));
  // In the store, so a plugin can bring its own panel forward.
  const panel = useStore((s) => s.panelTab) as PanelTab;
  const setPanel = useStore((s) => s.setPanelTab);
  const width = useStore((s) => s.columnWidths.sidebar);
  const order = useStore((s) => s.panelTabOrder);
  const setOrder = useStore((s) => s.setPanelTabOrder);
  const [dragging, setDragging] = useState<PanelTab | null>(null);
  const [over, setOver] = useState<PanelTab | "end" | null>(null);

  const TABS: RailTab[] = inOrder<RailTab>([
    // With tabs on top, the strip already lists the sessions.
    ...(layout === "sidebar"
      ? [{ key: "tabs" as const, label: "Sessões", icon: ICONS.tabs, hint: shortcutLabel("sidebar") }]
      : []),
    { key: "queue", label: "Fila", icon: ICONS.queue, badge: pending, hint: shortcutLabel("events") },
    { key: "sessions", label: "Histórico", icon: ICONS.sessions },
    {
      key: "bees",
      label: "Worker bee",
      icon: ICONS.bees,
      badge: beeWaiting.permissions.length + beeWaiting.questions.length + beeWaiting.clean.length,
    },
    // Raw hook traffic, only for diagnosing the app; switched on under Sobre.
    ...(showEvents ? [{ key: "events" as const, label: "Eventos", icon: ICONS.events }] : []),
    ...officialTabs.map((p) => ({
      key: `official:${p.manifest.id}` as const,
      label: p.SideTab!.title,
      icon: p.SideTab!.icon ?? <span className="rail-initials">{initials(p.SideTab!.title)}</span>,
    })),
    ...sidePlugins.map((p) => ({
      key: `plugin:${p.id}` as const,
      label: p.sidePanel!.title,
      icon: <span className="rail-initials">{initials(p.sidePanel!.title)}</span>,
    })),
  ], order);

  // Puts `from` where `to` is, or last when `to` is null. Icons of plugins
  // turned off keep their place in the saved order for when they come back.
  const move = (from: PanelTab, to: PanelTab | null) => {
    if (from === to) return;
    const keys: string[] = TABS.map((t) => t.key).filter((k) => k !== from);
    const at = to === null ? keys.length : keys.indexOf(to);
    keys.splice(at === -1 ? keys.length : at, 0, from);
    setOrder([...keys, ...order.filter((k) => !keys.includes(k))]);
  };
  // An icon whose plugin was turned off or hid its panel falls back to the queue.
  const current = TABS.some((t) => t.key === panel) ? panel : "queue";
  const currentTab = TABS.find((t) => t.key === current);
  const sidePlugin = sidePlugins.find((p) => `plugin:${p.id}` === current);
  const OfficialTab = officialTabs.find((p) => `official:${p.manifest.id}` === current)?.SideTab?.Component;

  const pick = (key: PanelTab) => (panelOpen && key === current ? togglePanel() : setPanel(key));

  return (
    <>
      <nav
        className={"activity-rail" + (over === "end" ? " drop-end" : "")}
        // The empty space under the icons sends a dropped icon last.
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(PANEL_TAB_DRAG)) return;
          e.preventDefault();
          if (over !== "end") setOver("end");
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(null)}
        onDrop={(e) => {
          const from = e.dataTransfer.getData(PANEL_TAB_DRAG) as PanelTab;
          e.preventDefault();
          setOver(null);
          if (from) move(from, null);
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            className={
              "rail-btn" +
              (panelOpen && current === t.key ? " active" : "") +
              (over === t.key && dragging !== t.key ? " drop-target" : "")
            }
            title={t.hint ? `${t.label} (${t.hint})` : t.label}
            aria-label={t.label}
            onClick={() => pick(t.key)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(PANEL_TAB_DRAG, t.key);
              e.dataTransfer.effectAllowed = "move";
              setDragging(t.key);
            }}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(PANEL_TAB_DRAG)) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              if (over !== t.key) setOver(t.key);
            }}
            onDrop={(e) => {
              const from = e.dataTransfer.getData(PANEL_TAB_DRAG) as PanelTab;
              e.preventDefault();
              e.stopPropagation();
              setOver(null);
              if (from) move(from, t.key);
            }}
          >
            {t.icon}
            {t.badge ? <span className="badge">{t.badge}</span> : null}
          </button>
        ))}
      </nav>

      {panelOpen && (
        <aside className={`sidebar side-panel tint-${groupTint}`} style={width ? { width } : undefined}>
          <ColumnResizer column="sidebar" />
          <header className="sidebar-header">
            <h1>{currentTab?.label}</h1>
            {current === "bees" && <NewBeeButton />}
            <button className="icon-btn" title={`Recolher (${shortcutLabel("sidebar")})`} onClick={togglePanel}>
              «
            </button>
          </header>

          {current === "tabs" && <SessionsPanel />}
          {current === "queue" && (
            <div className="panel-body">
              <PermissionQueue />
            </div>
          )}
          {current === "bees" && (
            <div className="panel-body">
              <BeePanel />
            </div>
          )}
          {current === "sessions" && (
            <div className="panel-body">
              <SessionsBrowser />
            </div>
          )}
          {OfficialTab && (
            <div className="panel-body">
              <OfficialTab />
            </div>
          )}
          {sidePlugin && (
            <div className="panel-body">
              <PluginSidePanel key={sidePlugin.id} plugin={sidePlugin} onClose={() => setPanel("queue")} />
            </div>
          )}
          {current === "events" && (
            <div className="panel-body">
              <EventsList />
            </div>
          )}
        </aside>
      )}
    </>
  );
}
