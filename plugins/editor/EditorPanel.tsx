import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CsvGrid } from "./CsvGrid";
import { format as reformat, validate } from "./format";
import type { EditorFormat, EditorRequest } from "./types";
import { LABELS } from "../../src/lib/shortcuts";

const FORMATS: Array<{ value: EditorFormat; label: string }> = [
  { value: "text", label: "Texto" },
  { value: "csv", label: "Planilha" },
  { value: "json", label: "JSON" },
  { value: "xml", label: "XML" },
];

const MIN_HEIGHT = 140;
const MAX_HEIGHT_RATIO = 0.75;
/** Matches the closing animation, so the panel is seen leaving. */
const EXIT_MS = 170;

interface Props {
  request: EditorRequest;
  onDone: () => void;
  /** Pane the request came from, which the panel covers the lower part of;
   *  null while that tab is not on screen, when the panel waits hidden. */
  rect: { left: string; top: string; width: string; height: string } | null;
}

/** Slides up under the terminal so Claude can ask for text without an external editor. */
export function EditorPanel({ request, onDone, rect }: Props) {
  const [text, setText] = useState(request.content);
  const [format, setFormat] = useState<EditorFormat>(request.format);
  const [hasHeader, setHasHeader] = useState(true);
  const [height, setHeight] = useState(360);
  const [sent, setSent] = useState(false);
  const [closing, setClosing] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const dragFrom = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => {
    setText(request.content);
    setFormat(request.format);
    setSent(false);
    setClosing(false);
    requestAnimationFrame(() => areaRef.current?.focus());
  }, [request.id, request.content, request.format]);

  const error = useMemo(() => validate(format, text), [format, text]);

  // Claude is answered right away; the panel then plays its way out.
  const dismiss = () => {
    setClosing(true);
    setTimeout(onDone, EXIT_MS);
  };

  const submit = async () => {
    if (error) return;
    setSent(true);
    dismiss();
    await invoke("editor_submit", { id: request.id, content: text }).catch(console.error);
  };

  const cancel = async () => {
    setSent(true);
    dismiss();
    if (request.blocking) await invoke("editor_cancel", { id: request.id }).catch(console.error);
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragFrom.current) return;
      const next = dragFrom.current.h + (dragFrom.current.y - e.clientY);
      setHeight(Math.max(MIN_HEIGHT, Math.min(window.innerHeight * MAX_HEIGHT_RATIO, next)));
      // maxHeight keeps it inside the pane; this only bounds the drag.
    };
    const onUp = () => {
      dragFrom.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      void cancel();
    }
  };

  return (
    <section
      className={`editor-panel ${closing ? "closing" : ""}`}
      style={
        rect
          ? {
              left: rect.left,
              width: rect.width,
              bottom: `calc(100% - ${rect.top} - ${rect.height})`,
              height,
              maxHeight: `calc(${rect.height} - 24px)`,
            }
          : { display: "none" }
      }
    >
      <div
        className="editor-grip"
        onMouseDown={(e) => {
          dragFrom.current = { y: e.clientY, h: height };
        }}
      />
      <header>
        <span className="editor-title">{request.title}</span>
        {request.path && (
          <span className="editor-path" title={request.path}>
            {request.path}
          </span>
        )}
        {!request.blocking && <span className="editor-tag">só leitura do Claude</span>}
        <select
          className="editor-format-select"
          value={format}
          onChange={(e) => setFormat(e.target.value as EditorFormat)}
          title="Como editar o conteúdo"
        >
          {FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        {format === "csv" && (
          <label className="check">
            <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
            1ª linha é cabeçalho
          </label>
        )}
        {(format === "json" || format === "xml") && (
          <button className="ghost auto" onClick={() => setText(reformat(format, text))}>
            Formatar
          </button>
        )}
        <button className="icon-btn" title="Fechar (Esc)" onClick={() => void cancel()}>
          ×
        </button>
      </header>
      {request.instructions && <p className="editor-instructions">{request.instructions}</p>}
      {format === "csv" ? (
        <CsvGrid value={text} onChange={setText} hasHeader={hasHeader} />
      ) : (
        <textarea
          ref={areaRef}
          className={error ? "invalid" : ""}
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
      )}
      {error && <p className="editor-error">{error}</p>}
      <footer>
        <span className="hint">
          {request.blocking ? "O Claude está aguardando este texto." : "O Claude não está aguardando."}
        </span>
        <button className="ghost auto" onClick={() => void cancel()} disabled={sent}>
          Cancelar
        </button>
        <button className="primary" onClick={() => void submit()} disabled={sent || !!error}>
          Enviar ao Claude ({LABELS.sendNow})
        </button>
      </footer>
    </section>
  );
}
