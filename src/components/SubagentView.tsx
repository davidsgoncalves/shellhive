import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../lib/store";
import { terminals } from "../lib/terminals";

/** How often a subagent still running is read again. */
const REFRESH_MS = 3000;

interface Entry {
  kind: "prompt" | "text" | "tool" | "result";
  text: string;
}

const LABEL: Record<Entry["kind"], string> = { prompt: "Pedido", text: "Subagente", tool: "Ferramenta", result: "Resultado" };

interface Props {
  rect: { left: string; top: string; width: string; height: string };
}

/** A subagent's conversation, read only, in place of its tab's terminal. */
export function SubagentView({ rect }: Props) {
  const view = useStore((s) => s.subagentView)!;
  const setView = useStore((s) => s.setSubagentView);
  const transcript = useStore((s) => s.tabs.find((t) => t.id === view.tabId)?.transcriptPath ?? null);
  const running = useStore((s) => s.subagentsByTab[view.tabId]?.some((a) => a.id === view.toolUseId) ?? false);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!transcript) return;
    const read = () =>
      void invoke<Entry[] | null>("subagent_transcript", { path: transcript, toolUseId: view.toolUseId })
        .then((list) => setEntries(list ?? []))
        .catch(() => setEntries([]));
    read();
    if (!running) return;
    const id = setInterval(read, REFRESH_MS);
    return () => clearInterval(id);
  }, [transcript, view.toolUseId, running]);

  // New lines of a running subagent come in at the bottom.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries?.length]);

  const back = () => {
    setView(null);
    terminals.get(view.tabId)?.focus();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && back();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="subagent-view" style={rect}>
      <header className="bee-detail-head">
        <div>
          <h2>
            <span className="agent-mark">⑂</span> {view.description}
          </h2>
          <p className="hint">
            {[view.type, running ? "rodando" : "terminado", "só leitura"].filter(Boolean).join(" · ")}
          </p>
        </div>
        <button className="ghost auto" onClick={back} title="Voltar ao terminal (Esc)">
          Voltar ao terminal
        </button>
      </header>
      {entries === null ? (
        <p className="hint pad">Lendo a conversa…</p>
      ) : entries.length === 0 ? (
        <p className="hint pad">A conversa deste subagente ainda não foi gravada.</p>
      ) : (
        <ol className="subagent-entries" ref={listRef}>
          {entries.map((e, i) => (
            <li key={i} className={`subagent-entry ${e.kind}`}>
              <span className="subagent-kind">{LABEL[e.kind]}</span>
              <pre>{e.text}</pre>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
