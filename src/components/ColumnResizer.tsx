import { useStore } from "../lib/store";

const LIMITS = {
  sidebar: { min: 180, max: 480 },
  events: { min: 240, max: 640 },
};

/**
 * Drag handle on a side column's inner edge; the width is kept across
 * restarts and a double click goes back to the default.
 */
export function ColumnResizer({ column }: { column: "sidebar" | "events" }) {
  const setColumnWidth = useStore((s) => s.setColumnWidth);
  const { min, max } = LIMITS[column];

  return (
    <div
      className={`column-resizer ${column}`}
      title="Arraste para redimensionar; duplo clique volta ao padrão"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const aside = e.currentTarget.parentElement;
        if (!aside) return;
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = aside.getBoundingClientRect().width;
        const handle = e.currentTarget;
        handle.setPointerCapture(e.pointerId);
        document.documentElement.dataset.resizing = "on";
        const onMove = (ev: PointerEvent) => {
          const delta = column === "sidebar" ? ev.clientX - startX : startX - ev.clientX;
          setColumnWidth(column, Math.round(Math.min(max, Math.max(min, startWidth + delta))));
        };
        const onUp = () => {
          delete document.documentElement.dataset.resizing;
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onUp);
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
      }}
      onDoubleClick={() => setColumnWidth(column, null)}
    />
  );
}
