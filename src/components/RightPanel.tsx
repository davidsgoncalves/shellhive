import { useState } from "react";
import { useStore } from "../lib/store";
import { PermissionQueue } from "./PermissionQueue";
import { pendingApprovals } from "./PluginApprovals";
import { SessionsBrowser } from "./SessionsBrowser";
import { EventsList } from "./EventsPanel";
import { shortcutLabel } from "../lib/shortcuts";

type PanelTab = "queue" | "sessions" | "pinned" | "events";

export function RightPanel() {
  const { eventsOpen, toggleEvents, permissions, questions, commands, showEvents } = useStore();
  const approvals = useStore((s) => pendingApprovals(s.localPlugins, s.deferredApprovals).length);
  const pending = permissions.length + questions.length + commands.length + approvals;
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
  ];
  const current = panel === "events" && !showEvents ? "queue" : panel;

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
      {current === "events" && (
        <div className="panel-body">
          <EventsList />
        </div>
      )}
    </aside>
  );
}
