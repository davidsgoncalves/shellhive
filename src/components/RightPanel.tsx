import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { PermissionQueue } from "./PermissionQueue";
import { pendingApprovals } from "./PluginApprovals";
import { PluginSidePanel } from "./LocalPluginPanel";
import { SessionsBrowser } from "./SessionsBrowser";
import { EventsList } from "./EventsPanel";
import { shortcutLabel } from "../lib/shortcuts";
import { PLUGINS } from "../lib/plugins";
import { ColumnResizer } from "./ColumnResizer";

type PanelTab = "queue" | "sessions" | "pinned" | "events" | `plugin:${string}` | `official:${string}`;

/** Drag payload type for a tab of the right column. */
const PANEL_TAB_DRAG = "application/x-panel-tab";

/** Tabs in the order the user set; tabs never moved keep their place after them. */
function inOrder<T extends { key: string }>(tabs: T[], order: string[]): T[] {
  const rank = (key: string) => {
    const i = order.indexOf(key);
    return i === -1 ? order.length : i;
  };
  return tabs.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t.key) - rank(b.t.key) || a.i - b.i).map(({ t }) => t);
}

export function RightPanel() {
  const { eventsOpen, toggleEvents, permissions, questions, commands, showEvents } = useStore();
  const approvals = useStore((s) => pendingApprovals(s.localPlugins, s.deferredApprovals).length);
  const pending = permissions.length + questions.length + commands.length + approvals;
  const localPlugins = useStore((s) => s.localPlugins);
  const enabledPlugins = useStore((s) => s.enabledPlugins);
  const sidePlugins = localPlugins.filter(
    (p) => p.status === "approved" && p.sidePanel && enabledPlugins.includes(p.id),
  );
  const officialTabs = PLUGINS.filter((p) => p.SideTab && enabledPlugins.includes(p.manifest.id));
  // In the store, so a plugin can bring its own tab forward.
  const panel = useStore((s) => s.rightPanelTab) as PanelTab;
  const setPanel = useStore((s) => s.setRightPanelTab);
  const width = useStore((s) => s.columnWidths.events);
  const order = useStore((s) => s.panelTabOrder);
  const setOrder = useStore((s) => s.setPanelTabOrder);

  if (!eventsOpen) {
    return (
      <aside className="events-panel collapsed">
        <button className="icon-btn" title={`Mostrar painel (${shortcutLabel("events")})`} onClick={toggleEvents}>
          «
        </button>
        {pending > 0 && (
          <span className="badge">{pending}</span>
        )}
      </aside>
    );
  }

  const TABS: Array<{ key: PanelTab; label: string; badge?: number }> = inOrder([
    { key: "queue", label: "Fila", badge: pending },
    { key: "sessions", label: "Histórico" },
    { key: "pinned", label: "Fixadas" },
    // Raw hook traffic, only for diagnosing the app; switched on under Sobre.
    ...(showEvents ? [{ key: "events" as const, label: "Eventos" }] : []),
    ...officialTabs.map((p) => ({ key: `official:${p.manifest.id}` as const, label: p.SideTab!.title })),
    ...sidePlugins.map((p) => ({ key: `plugin:${p.id}` as const, label: p.sidePanel!.title })),
  ], order);

  // Puts `from` where `to` is, or last when `to` is null. Tabs of plugins
  // turned off keep their place in the saved order for when they come back.
  const move = (from: PanelTab, to: PanelTab | null) => {
    if (from === to) return;
    const keys: string[] = TABS.map((t) => t.key).filter((k) => k !== from);
    const at = to === null ? keys.length : keys.indexOf(to);
    keys.splice(at === -1 ? keys.length : at, 0, from);
    setOrder([...keys, ...order.filter((k) => !keys.includes(k))]);
  };
  // A tab whose plugin was turned off or hid its panel falls back to the queue.
  const current = TABS.some((t) => t.key === panel) ? panel : "queue";
  const sidePlugin = sidePlugins.find((p) => `plugin:${p.id}` === current);
  const OfficialTab = officialTabs.find((p) => `official:${p.manifest.id}` === current)?.SideTab?.Component;

  return (
    <aside className="events-panel" style={width ? { width } : undefined}>
      <ColumnResizer column="events" />
      <TabStrip tabs={TABS} current={current} onPick={setPanel} onMove={move}>
        <button className="icon-btn" title={`Recolher (${shortcutLabel("events")})`} onClick={toggleEvents}>
          »
        </button>
      </TabStrip>

      {current === "queue" && (
        <div className="panel-body">
          <PermissionQueue />
        </div>
      )}
      {current === "sessions" && (
        <div className="panel-body">
          <SessionsBrowser />
        </div>
      )}
      {current === "pinned" && (
        <div className="panel-body">
          <SessionsBrowser onlyPinned />
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
  );
}

interface StripTab {
  key: PanelTab;
  label: string;
  badge?: number;
}

const MORE_WIDTH = 34;

/**
 * The column's tabs, as many as fit; the rest go into a "⋯" menu. The open
 * tab always stays in view. Tabs are dragged to reorder them, in the strip and
 * in the menu alike; dropping on "⋯" sends one to the end.
 */
function TabStrip({
  tabs,
  current,
  onPick,
  onMove,
  children,
}: {
  tabs: StripTab[];
  current: PanelTab;
  onPick: (key: PanelTab) => void;
  onMove: (from: PanelTab, to: PanelTab | null) => void;
  children: React.ReactNode;
}) {
  const header = useRef<HTMLElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const tail = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [widths, setWidths] = useState<number[]>([]);
  const [menu, setMenu] = useState<{ right: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<PanelTab | null>(null);
  const [over, setOver] = useState<PanelTab | "more" | "end" | null>(null);

  const openMenu = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({ right: window.innerWidth - r.right, top: r.bottom + 4 });
  };

  // Each tab, in the strip or in the menu, is both something to drag and a
  // place to drop another.
  const dragProps = (key: PanelTab | "more") => ({
    draggable: key !== "more",
    onDragStart: (e: React.DragEvent) => {
      if (key === "more") return;
      e.dataTransfer.setData(PANEL_TAB_DRAG, key);
      e.dataTransfer.effectAllowed = "move";
      setDragging(key);
    },
    onDragEnd: () => {
      setDragging(null);
      setOver(null);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(PANEL_TAB_DRAG)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      if (over !== key) setOver(key);
    },
    onDrop: (e: React.DragEvent) => {
      const from = e.dataTransfer.getData(PANEL_TAB_DRAG) as PanelTab;
      e.preventDefault();
      e.stopPropagation();
      setOver(null);
      if (from) onMove(from, key === "more" ? null : key);
    },
  });
  const dropClass = (key: PanelTab | "more") => (over === key && dragging !== key ? " drop-target" : "");

  useLayoutEffect(() => {
    const el = header.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Widths come from an invisible copy, so they hold whichever tabs are shown.
  const signature = tabs.map((t) => `${t.key}:${t.label}:${t.badge ?? 0}`).join("|");
  useLayoutEffect(() => {
    const row = measure.current;
    if (row) setWidths(Array.from(row.children, (c) => (c as HTMLElement).offsetWidth));
  }, [signature]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const GAP = 2;
  const room = width - 14 - (tail.current?.offsetWidth ?? 28);
  const total = widths.reduce((a, w) => a + w + GAP, 0);
  let shown = tabs.map((_, i) => i);
  if (widths.length === tabs.length && width > 0 && total > room) {
    const budget = room - MORE_WIDTH;
    const active = tabs.findIndex((t) => t.key === current);
    const reserve = active >= 0 ? widths[active] + GAP : 0;
    shown = [];
    let used = reserve;
    for (let i = 0; i < tabs.length; i++) {
      if (i === active) continue;
      if (used + widths[i] + GAP > budget) break;
      shown.push(i);
      used += widths[i] + GAP;
    }
    if (active >= 0) shown = [...shown, active].sort((a, b) => a - b);
  }
  const hidden = tabs.filter((_, i) => !shown.includes(i));
  const hiddenBadge = hidden.reduce((a, t) => a + (t.badge ?? 0), 0);

  const tabButton = (t: StripTab) => (
    <button
      key={t.key}
      className={(current === t.key ? "active" : "") + dropClass(t.key)}
      onClick={() => onPick(t.key)}
      {...dragProps(t.key)}
    >
      {t.label}
      {t.badge ? <span className="badge">{t.badge}</span> : null}
    </button>
  );

  return (
    <header
      className={"panel-tabs" + (over === "end" ? " drop-end" : "")}
      ref={header}
      // The empty space after the tabs sends a dropped tab last.
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
        if (from) onMove(from, null);
      }}
    >
      <div className="panel-tabs-measure" ref={measure} aria-hidden>
        {tabs.map((t) => (
          <button key={t.key} className={current === t.key ? "active" : ""} tabIndex={-1}>
            {t.label}
            {t.badge ? <span className="badge">{t.badge}</span> : null}
          </button>
        ))}
      </div>
      {shown.map((i) => tabButton(tabs[i]))}
      {hidden.length > 0 && (
        <button
          className={`panel-tabs-more ${menu ? "active" : ""}${dropClass("more")}`}
          title="Mais abas · arraste uma aba para cá para mandá-la ao fim"
          onClick={(e) => (menu ? setMenu(null) : openMenu(e.currentTarget))}
          // Opens while a tab is dragged over it, to drop among the hidden ones.
          onDragEnter={(e) => {
            if (!menu && e.dataTransfer.types.includes(PANEL_TAB_DRAG)) openMenu(e.currentTarget);
          }}
          {...dragProps("more")}
        >
          ⋯{hiddenBadge ? <span className="badge">{hiddenBadge}</span> : null}
        </button>
      )}
      <div className="panel-tabs-tail" ref={tail}>
        {children}
      </div>
      {menu && (
        <div ref={menuRef} className="group-menu panel-tabs-menu" style={{ right: menu.right, top: menu.top }}>
          {hidden.map((t) => (
            <button
              key={t.key}
              className={"menu-item" + dropClass(t.key)}
              onClick={() => {
                onPick(t.key);
                setMenu(null);
              }}
              {...dragProps(t.key)}
            >
              {t.label}
              {t.badge ? <span className="badge">{t.badge}</span> : null}
            </button>
          ))}
        </div>
      )}
    </header>
  );
}
