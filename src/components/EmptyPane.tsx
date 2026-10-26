import { useEffect, useRef, useState } from "react";
import { defaultGroupId, openSession, openSessionInGroup, sessionFromDrag, useStore } from "../lib/store";
import { isBeeTab, paneCount, paneRect } from "../lib/types";
import { carriesSession, carriesTab } from "../lib/termExtras";

/** Placeholder shown in a pane with no terminal, with its own opener. */
export function EmptyPane({ index }: { index: number }) {
  const { tabs, panes, splitMode, groups, detached, assignToPane, focusPane } = useStore();
  const [open, setOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shown = new Set(panes.slice(0, paneCount(splitMode)).filter(Boolean) as string[]);
  const hiddenGroups = new Set(groups.filter((g) => g.hidden).map((g) => g.id));
  const available = tabs.filter(
    (t) => !shown.has(t.id) && !hiddenGroups.has(t.groupId) && !detached.includes(t.id) && !isBeeTab(t),
  );

  const startNew = () => {
    setOpen(false);
    focusPane(index);
    openSessionInGroup(defaultGroupId());
  };

  return (
    <div
      className={`empty-pane ${dropping ? "drop-target" : ""}`}
      style={paneRect(splitMode, index)}
      onDragOver={(e) => {
        if (!carriesTab(e.dataTransfer) && !carriesSession(e.dataTransfer)) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        const dragged = e.dataTransfer.getData("text/tab-id");
        const session = sessionFromDrag(e.dataTransfer);
        if (!dragged && !session) return;
        e.preventDefault();
        if (dragged) assignToPane(dragged, index);
        else if (session) openSession(session, { pane: index });
      }}
    >
      {!open ? (
        <button className="empty-pane-btn" onClick={() => setOpen(true)} title="Abrir um terminal aqui">
          <span className="plus">+</span>
          <span>Abrir terminal</span>
        </button>
      ) : (
        <div className="pane-picker" ref={ref}>
          <button className="menu-item strong" onClick={startNew}>
            Nova sessão
          </button>
          {available.length > 0 && <div className="menu-sep" />}
          <div className="pane-picker-list">
            {available.map((t) => {
              const color = groups.find((g) => g.id === t.groupId)?.color ?? "transparent";
              return (
                <button
                  key={t.id}
                  className="menu-item"
                  onClick={() => {
                    setOpen(false);
                    assignToPane(t.id, index);
                  }}
                >
                  <span className="pick-dot" style={{ background: color }} />
                  <span className="pick-title">{t.title}</span>
                  {t.state === "dormant" && <span className="pick-tag">fechada</span>}
                </button>
              );
            })}
          </div>
          {available.length === 0 && <p className="hint pad">Nenhuma outra aba disponível.</p>}
        </div>
      )}
    </div>
  );
}
