import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openSession, SESSION_DRAG, useStore, type SessionRef } from "../lib/store";
import { sessionLabel } from "../lib/titles";
import type { SessionInfo, SessionMatch } from "../lib/types";

function relativeDate(epochSeconds: number): string {
  const diff = Date.now() - epochSeconds * 1000;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(epochSeconds * 1000).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function label(s: SessionInfo): string {
  return sessionLabel(s);
}

function place(s: SessionInfo): string {
  const dir = s.cwd ?? s.project.replace(/-/g, "/");
  return dir.split("/").filter(Boolean).slice(-1)[0] ?? dir;
}

/** Every recorded session, or only the pinned ones when `onlyPinned` is set. */
export function SessionsBrowser({ onlyPinned = false }: { onlyPinned?: boolean }) {
  const { tabs, pinned, togglePinned } = useStore();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [matches, setMatches] = useState<SessionMatch[] | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);

  const load = () => {
    setLoading(true);
    invoke<SessionInfo[]>("sessions_list")
      .then(setSessions)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  // A session pinned from its tab may be newer than the list; reload so it
  // shows up in Fixadas right away.
  useEffect(() => {
    if (pinned.some((id) => !sessions.some((s) => s.id === id))) load();
    // Only a change in the pins should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setMatches(null);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      invoke<SessionMatch[]>("sessions_search", { query: q })
        .then(setMatches)
        .catch(console.error)
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const openSessions = useMemo(
    () => new Set(tabs.map((t) => t.claudeSessionId).filter(Boolean) as string[]),
    [tabs],
  );

  const snippetById = useMemo(() => {
    const map = new Map<string, string>();
    matches?.forEach((m) => map.set(m.id, m.snippet));
    return map;
  }, [matches]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = onlyPinned ? sessions.filter((s) => pinned.includes(s.id)) : sessions;
    if (q.length >= 2) {
      const byText = list.filter(
        (s) => label(s).toLowerCase().includes(q) || place(s).toLowerCase().includes(q),
      );
      const byContent = list.filter((s) => snippetById.has(s.id));
      const seen = new Set<string>();
      list = [...byText, ...byContent].filter((s) => (seen.has(s.id) ? false : seen.add(s.id)));
    }
    // Pinned sessions stay on top, in the order they were pinned.
    const rank = (s: SessionInfo) => {
      const i = pinned.indexOf(s.id);
      return i === -1 ? pinned.length : i;
    };
    return [...list].sort((a, b) => rank(a) - rank(b));
  }, [sessions, query, snippetById, pinned, onlyPinned]);

  const refOf = (s: SessionInfo): SessionRef => ({ id: s.id, cwd: s.cwd, title: label(s) });
  const open = (s: SessionInfo) => openSession(refOf(s));

  return (
    <div className="sessions">
      <div className="sessions-search">
        <input
          placeholder="Buscar por assunto ou conteúdo"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="icon-btn" title="Recarregar" onClick={load}>
          ↻
        </button>
      </div>
      {loading && <p className="hint pad">Lendo transcripts…</p>}
      {!loading && visible.length === 0 && (
        <p className="hint pad">
          {query
            ? "Nada encontrado."
            : onlyPinned
              ? "Nenhuma sessão fixada. Fixe uma pela ☆ no Histórico."
              : "Nenhuma sessão gravada."}
        </p>
      )}
      {searching && <p className="hint pad">Buscando no conteúdo…</p>}
      <ul className="session-list">
        {visible.map((s) => (
          <li
            key={s.id}
            className={`${openSessions.has(s.id) ? "open" : ""} ${pinned.includes(s.id) ? "pinned" : ""}`}
            onClick={() => open(s)}
            draggable
            onDragStart={(e) => e.dataTransfer.setData(SESSION_DRAG, JSON.stringify(refOf(s)))}
            title={`${s.cwd ?? s.project}\n${(s.size_bytes / 1024).toFixed(0)} KB`}
          >
            <div className="row">
              <span className="session-title">{label(s)}</span>
              <button
                className={`pin ${pinned.includes(s.id) ? "on" : ""}`}
                title={pinned.includes(s.id) ? "Desafixar" : "Fixar no topo"}
                onClick={(e) => {
                  e.stopPropagation();
                  togglePinned(s.id);
                }}
              >
                {pinned.includes(s.id) ? "★" : "☆"}
              </button>
              <time>{relativeDate(s.modified_at)}</time>
            </div>
            <div className="meta">
              <span>{place(s)}</span>
              {s.git_branch && <span className="branch">{s.git_branch}</span>}
              {openSessions.has(s.id) && <span className="tag">aberta</span>}
            </div>
            {snippetById.has(s.id) && <div className="snippet">{snippetById.get(s.id)}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
