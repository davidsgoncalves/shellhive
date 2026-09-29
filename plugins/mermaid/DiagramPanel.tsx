import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { PluginHost } from "../../src/lib/plugins";
import { problem, toPng, toSvg } from "./render";
import { useDiagram } from "./state";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The diagram the agent showed, under the terminal of the tab that asked. */
export function DiagramPanel({ host }: { host: PluginHost }) {
  const { diagram, show } = useDiagram();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!diagram) return;
    let live = true;
    setDraft(diagram.source);
    setNote(null);
    toSvg(diagram.source)
      .then((out) => live && (setSvg(out), setError(null)))
      .catch((err) => live && (setSvg(null), setError(errorText(err))));
    return () => {
      live = false;
    };
  }, [diagram]);

  if (!diagram) return null;
  const rect = host.paneRect(diagram.tabId);

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
    show({ ...diagram, source: draft });
    setEditing(false);
  };

  return (
    <section
      className="diagram-panel"
      style={{
        left: rect.left,
        width: rect.width,
        bottom: `calc(100% - ${rect.top} - ${rect.height})`,
        maxHeight: `calc(${rect.height} - 24px)`,
      }}
    >
      <header>
        <span className="diagram-title">{diagram.title}</span>
        <button className="ghost auto" onClick={() => void copy()} disabled={!svg}>
          Copiar imagem
        </button>
        <button className="ghost auto" onClick={() => void saveSvg()} disabled={!svg}>
          Salvar SVG
        </button>
        <button className={`ghost auto ${editing ? "on" : ""}`} onClick={() => setEditing((e) => !e)}>
          Ver código
        </button>
        <button className="icon-btn" title="Fechar" onClick={() => show(null)}>
          ×
        </button>
      </header>
      {note && <p className="hint diagram-note">{note}</p>}
      {error && <p className="error diagram-note">{error}</p>}
      {editing && (
        <div className="diagram-code">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
          <button className="primary" onClick={() => void rerender()}>
            Renderizar
          </button>
        </div>
      )}
      {/* Rendered with securityLevel strict, which sanitises the SVG. */}
      {svg && <div className="diagram-view" dangerouslySetInnerHTML={{ __html: svg }} />}
    </section>
  );
}
