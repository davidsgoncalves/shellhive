import { useEffect, useRef } from "react";
import { openSessionInGroup, useStore } from "../lib/store";
import { SESSION_KINDS } from "../lib/providers";

/** The + menu of a group: a plain terminal or an agent session, in chat or terminal. */
export function NewSessionMenu() {
  const menu = useStore((s) => s.newSessionMenu);
  const openMenu = useStore((s) => s.openNewSessionMenu);
  const group = useStore((s) => s.groups.find((g) => g.id === menu?.groupId));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) openMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && openMenu(null);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, openMenu]);

  if (!menu || !group) return null;
  const preferred = group.launch?.open ?? "terminal";

  return (
    <div ref={ref} className="group-menu" style={{ left: Math.min(menu.x, window.innerWidth - 230), top: menu.y + 4 }}>
      {SESSION_KINDS.map(([kind, label]) => (
        <button
          key={kind}
          className="menu-item"
          onClick={() => {
            openMenu(null);
            openSessionInGroup(group.id, kind);
          }}
        >
          {label}
          {kind === preferred && <span className="muted">padrão</span>}
        </button>
      ))}
    </div>
  );
}
