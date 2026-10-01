import { useState } from "react";
import { useStore } from "../lib/store";
import { PermissionQueue } from "./PermissionQueue";
import { pendingApprovals } from "./PluginApprovals";
import { PluginSidePanel } from "./LocalPluginPanel";
import { SessionsBrowser } from "./SessionsBrowser";
import { EventsList } from "./EventsPanel";
import { shortcutLabel } from "../lib/shortcuts";

type PanelTab = "queue" | "sessions" | "pinned" | "events" | `plugin:${string}`;

export function RightPanel() {
  const { eventsOpen, toggleEvents, permissions, questions, commands, showEvents } = useStore();
  const approvals = useStore((s) => pendingApprovals(s.localPlugins, s.deferredApprovals).length);
  const pending = permissions.length + questions.length + commands.length + approvals;
  const localPlugins = useStore((s) => s.localPlugins);
  const enabledPlugins = useStore((s) => s.enabledPlugins);
  const sidePlugins = localPlugins.filter(
    (p) => p.status === "approved" && p.sidePanel && enabledPlugins.includes(p.id),
  );
  const [panel, setPanel] = useState<PanelTab>("queue");

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

  const TABS: Array<{ key: PanelTab; label: string; badge?: number }> = [
    { key: "queue", label: "Fila", badge: pending },
    { key: "sessions", label: "Histórico" },
    { key: "pinned", label: "Fixadas" },
    // Raw hook traffic, only for diagnosing the app; switched on under Sobre.
    ...(showEvents ? [{ key: "events" as const, label: "Eventos" }] : []),
    ...sidePlugins.map((p) => ({ key: `plugin:${p.id}` as const, label: p.sidePanel!.title })),
  ];
  // A tab whose plugin was turned off or hid its panel falls back to the queue.
  const current = TABS.some((t) => t.key === panel) ? panel : "queue";
  const sidePlugin = sidePlugins.find((p) => `plugin:${p.id}` === current);

  return (
    <aside className="events-panel">
      <header className="panel-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={current === t.key ? "active" : ""}
            onClick={() => setPanel(t.key)}
          >
            {t.label}
            {t.badge ? <span className="badge">{t.badge}</span> : null}
          </button>
        ))}
        <button className="icon-btn" title={`Recolher (${shortcutLabel("events")})`} onClick={toggleEvents}>
          »
        </button>
      </header>

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
