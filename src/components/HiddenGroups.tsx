import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";

/** Dropdown listing hidden groups, each with a restore button. */
export function HiddenGroups({ variant }: { variant: "sidebar" | "strip" }) {
  const { groups, tabs, setGroupHidden } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const hidden = groups.filter((g) => g.hidden);

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

  useEffect(() => {
    if (hidden.length === 0) setOpen(false);
  }, [hidden.length]);

  if (hidden.length === 0) return null;

  const hiddenIds = new Set(hidden.map((g) => g.id));
  const pending = tabs.filter((t) => hiddenIds.has(t.groupId) && t.state === "permission").length;

  return (
    <div ref={ref} className={`hidden-groups in-${variant}`}>
      <button
        className={variant === "sidebar" ? "ghost hidden-toggle" : "strip-new-group hidden-toggle"}
        onClick={() => setOpen((o) => !o)}
        title="Grupos ocultos"
      >
        <span>Ocultos ({hidden.length})</span>
        {pending > 0 && <span className="badge">{pending}</span>}
        <span className="hidden-caret">{open ? "⌄" : "›"}</span>
      </button>
      {open && (
        <div className="hidden-list">
          {hidden.map((g) => {
            const gt = tabs.filter((t) => t.groupId === g.id);
            const waiting = gt.filter((t) => t.state === "permission").length;
            return (
              <div key={g.id} className="hidden-row">
                {g.emoji ? <span className="group-emoji">{g.emoji}</span> : <span className="pick-dot" style={{ background: g.color }} />}
                <span className="hidden-name" title={g.name}>
                  {g.name}
                </span>
                {waiting > 0 && <span className="badge">{waiting}</span>}
                <span className="count">{gt.length}</span>
                <button className="hidden-restore" onClick={() => setGroupHidden(g.id, false)}>
                  Restaurar
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
