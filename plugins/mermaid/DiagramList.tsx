import { useEffect } from "react";
import { useStore } from "../../src/lib/store";
import { useDiagrams } from "./state";
import { openDiagram } from "./window";

const when = (at: number) =>
  new Date(at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Every diagram the agent made, in the right column; each opens in its window. */
export function DiagramList() {
  const { diagrams, loaded, load, remove } = useDiagrams();
  const tabs = useStore((s) => s.tabs);
  useEffect(() => void load(), [load]);

  if (!loaded) return <p className="hint pad">Carregando…</p>;
  if (diagrams.length === 0)
    return <p className="hint pad">Nenhum diagrama ainda. Os que o Claude criar aparecem aqui.</p>;
  return (
    <ul className="diagram-list">
      {diagrams.map((d) => (
        <li key={d.id}>
          <button className="diagram-item" onClick={() => void openDiagram(d)} title="Abrir numa janela">
            <span className="diagram-item-title">{d.title}</span>
            <span className="diagram-item-meta">
              {tabs.find((t) => t.id === d.tabId)?.title ?? d.tabTitle ?? "aba fechada"} · {when(d.at)}
            </span>
          </button>
          <button className="icon-btn" title="Apagar" onClick={() => void remove(d.id)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
