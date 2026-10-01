import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { save } from "@tauri-apps/plugin-dialog";
import { problem, toPng, toSvg } from "./render";
import type { Diagram } from "./state";
import { onShow, sendEdit } from "./window";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const MIN = 0.1;
const MAX = 8;
const clamp = (s: number) => Math.min(MAX, Math.max(MIN, s));

interface View {
  scale: number;
  x: number;
  y: number;
}

/** One diagram at a time in its own window, with zoom and panning. */
export function DiagramWindow() {
  const [diagram, setDiagram] = useState<Diagram | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const stage = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(
    () =>
      onShow((d) => {
        setDiagram(d);
        setDraft(d.source);
        setEditing(false);
        setNote(null);
        void getCurrentWebviewWindow().setTitle(d.title);
      }),
    [],
  );

  useEffect(() => {
    if (!diagram) return;
    let live = true;
    toSvg(diagram.source)
      .then((out) => live && (setSvg(out), setError(null)))
      .catch((err) => live && (setSvg(null), setError(errorText(err))));
    return () => {
      live = false;
    };
  }, [diagram]);

  /** Whole diagram in view, centred, never blown up past twice its size. */
  const fit = useCallback(() => {
    const box = stage.current?.getBoundingClientRect();
    const el = content.current?.querySelector("svg");
    if (!box || !el) return;
    const w = el.width.baseVal.value || 1;
    const h = el.height.baseVal.value || 1;
    const scale = clamp(Math.min((box.width - 48) / w, (box.height - 48) / h, 2));
    setView({ scale, x: (box.width - w * scale) / 2, y: (box.height - h * scale) / 2 });
  }, []);

  // Mermaid sizes the SVG to its container; at its own size it can be zoomed.
  useLayoutEffect(() => {
    const el = content.current?.querySelector("svg");
    if (!el) return;
    const vb = el.viewBox.baseVal;
    if (vb && vb.width) {
      el.setAttribute("width", String(vb.width));
      el.setAttribute("height", String(vb.height));
    }
    el.style.maxWidth = "none";
    fit();
  }, [svg, fit]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const box = stage.current?.getBoundingClientRect();
    if (!box) return;
    const px = cx ?? box.width / 2;
    const py = cy ?? box.height / 2;
    setView((v) => {
      const scale = clamp(v.scale * factor);
      const k = scale / v.scale;
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, []);

  // Pinch and ⌘/Ctrl + wheel zoom at the pointer; a plain wheel or swipe pans.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const box = el.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - box.left, e.clientY - box.top);
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing && (e.target as HTMLElement).tagName === "TEXTAREA") return;
      if (e.key === "+" || e.key === "=") zoomAt(1.25);
      else if (e.key === "-") zoomAt(0.8);
      else if (e.key === "0") fit();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, zoomAt, fit]);

  if (!diagram) return <p className="hint pad">Carregando…</p>;

  const copy = async () => {
    if (!svg) return;
    try {
      const png = await toPng(svg);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      setNote("Imagem copiada.");
    } catch (err) {
      setNote(`Não consegui copiar: ${errorText(err)}`);
    }
  };

  const saveSvg = async () => {
    if (!svg) return;
    const path = await save({
      defaultPath: `${diagram.title.replace(/[\\/:*?"<>|]/g, "-") || "diagrama"}.svg`,
      filters: [{ name: "SVG", extensions: ["svg"] }],
    });
    if (!path) return;
    try {
      await invoke("save_text_file", { path, contents: svg });
      setNote(`Salvo em ${path}`);
    } catch (err) {
      setNote(errorText(err));
    }
  };

  const rerender = async () => {
    const bad = await problem(draft);
    if (bad) return setError(bad);
    setDiagram({ ...diagram, source: draft });
    void sendEdit(diagram.id, draft);
    setEditing(false);
  };

  return (
    <div className="diagram-window">
      <header>
        <span className="diagram-title">{diagram.title}</span>
        <button className="ghost auto" title="Diminuir (−)" onClick={() => zoomAt(0.8)}>
          −
        </button>
        <span className="diagram-zoom">{Math.round(view.scale * 100)}%</span>
        <button className="ghost auto" title="Aumentar (+)" onClick={() => zoomAt(1.25)}>
          +
        </button>
        <button className="ghost auto" title="Caber na janela (0)" onClick={fit}>
          Caber
        </button>
        <span className="diagram-sep" />
        <button className="ghost auto" onClick={() => void copy()} disabled={!svg}>
          Copiar imagem
        </button>
        <button className="ghost auto" onClick={() => void saveSvg()} disabled={!svg}>
          Salvar SVG
        </button>
        <button className={`ghost auto ${editing ? "on" : ""}`} onClick={() => setEditing((e) => !e)}>
          Ver código
        </button>
      </header>
      {note && <p className="hint diagram-note">{note}</p>}
      {error && <p className="error diagram-note">{error}</p>}
      <div className="diagram-body">
        <div
          ref={stage}
          className={`diagram-stage ${drag.current ? "dragging" : ""}`}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            drag.current = { x: e.clientX, y: e.clientY };
            e.currentTarget.setPointerCapture(e.pointerId);
            e.currentTarget.classList.add("dragging");
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            drag.current = { x: e.clientX, y: e.clientY };
            setView((v) => ({ ...v, x: v.x + e.clientX - d.x, y: v.y + e.clientY - d.y }));
          }}
          onPointerUp={(e) => {
            drag.current = null;
            e.currentTarget.classList.remove("dragging");
          }}
          onDoubleClick={fit}
        >
          {/* Rendered with securityLevel strict, which sanitises the SVG. */}
          {svg && (
            <div
              ref={content}
              className="diagram-content"
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          )}
        </div>
        {editing && (
          <div className="diagram-code">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
            <button className="primary" onClick={() => void rerender()}>
              Renderizar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
