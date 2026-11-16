import { useEffect, useMemo, useState } from "react";
import { api, errorText, type Conflict } from "./api";

type Part = { kind: "text"; text: string } | { kind: "conflict"; ours: string; base: string; theirs: string };
type Pick = "ours" | "theirs" | "both" | "base";

const PICKS: [Pick, string][] = [
  ["ours", "Nosso"],
  ["theirs", "Deles"],
  ["both", "Os dois"],
  ["base", "Base"],
];

/** Splits a file merged with `--diff3` markers into plain text and conflicts. */
export function parseConflicts(merged: string): Part[] {
  const parts: Part[] = [];
  const lines = merged.split(/(?<=\n)/);
  let text = "";
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("<<<<<<< ")) {
      text += lines[i++];
      continue;
    }
    const block = { ours: "", base: "", theirs: "" };
    let at: keyof typeof block = "ours";
    let closed = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (l.startsWith("||||||| ")) at = "base";
      else if (l.startsWith("=======")) at = "theirs";
      else if (l.startsWith(">>>>>>> ")) {
        closed = true;
        break;
      } else block[at] += l;
    }
    if (!closed) {
      text += lines.slice(i).join("");
      break;
    }
    if (text) parts.push({ kind: "text", text });
    text = "";
    parts.push({ kind: "conflict", ...block });
    i = j + 1;
  }
  if (text) parts.push({ kind: "text", text });
  return parts;
}

const pickText = (p: Extract<Part, { kind: "conflict" }>, pick: Pick) =>
  pick === "both" ? p.ours + p.theirs : p[pick];

/** A file in conflict: ours, base and theirs side by side, one choice per block. */
export function ConflictView({ root, path, onDone }: { root: string; path: string; onDone: () => void }) {
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [picks, setPicks] = useState<Record<number, Pick>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setConflict(null);
    setPicks({});
    setError(null);
    api
      .conflict(root, path)
      .then(setConflict)
      .catch((err) => setError(errorText(err)));
  }, [root, path]);

  const parts = useMemo(() => (conflict ? parseConflicts(conflict.merged) : []), [conflict]);
  const blocks = parts.flatMap((p, i) => (p.kind === "conflict" ? [i] : []));
  const done = blocks.every((i) => picks[i]);

  const resolve = async (content: string | null) => {
    setBusy(true);
    try {
      await api.resolve(root, path, content);
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const result = () =>
    parts.map((p, i) => (p.kind === "text" ? p.text : pickText(p, picks[i]))).join("");

  if (error) return <p className="error pad">{error}</p>;
  if (!conflict) return <p className="hint pad">Carregando…</p>;
  return (
    <div className="git-conflict">
      <div className="git-conflict-bar">
        <span className="hint">
          {conflict.hasMarkers
            ? `${blocks.length} conflito(s). Escolha o lado de cada um.`
            : "O arquivo já não tem marcadores de conflito. Se ele está como deve ficar, marque como resolvido."}
        </span>
        <button className="ghost" disabled={busy} onClick={() => void resolve(null)} title="git add do arquivo como está">
          Usar o arquivo atual
        </button>
        <button className="primary" disabled={busy || !done || blocks.length === 0} onClick={() => void resolve(result())}>
          Salvar e marcar resolvido
        </button>
      </div>
      <div className="git-conflict-body">
        {parts.map((p, i) =>
          p.kind === "text" ? (
            <pre key={i} className="git-conflict-text">
              {p.text.length > 600 ? `${p.text.slice(0, 200)}\n…\n${p.text.slice(-200)}` : p.text}
            </pre>
          ) : (
            <div key={i} className={`git-conflict-block ${picks[i] ? "picked" : ""}`}>
              <div className="git-conflict-cols">
                {(["ours", "base", "theirs"] as const).map((side) => (
                  <div key={side} className={`git-conflict-col ${picks[i] === side || (picks[i] === "both" && side !== "base") ? "on" : ""}`}>
                    <span className="git-conflict-label">{side === "ours" ? "Nosso (HEAD)" : side === "base" ? "Base" : "Deles"}</span>
                    <pre>{p[side] || " "}</pre>
                  </div>
                ))}
              </div>
              <div className="git-conflict-picks">
                {PICKS.map(([pick, label]) => (
                  <button key={pick} className={`ghost ${picks[i] === pick ? "on" : ""}`} onClick={() => setPicks((s) => ({ ...s, [i]: pick }))}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
