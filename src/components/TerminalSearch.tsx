import { useEffect, useRef, useState } from "react";
import type { ISearchOptions } from "@xterm/addon-search";
import { searches, terminals } from "../lib/terminals";
import { IS_MAC } from "../lib/shortcuts";
import { useStore } from "../lib/store";

const OPTIONS: ISearchOptions = {
  decorations: {
    matchBackground: "#5b4a2a",
    matchOverviewRuler: "#c9a227",
    activeMatchBackground: "#d97757",
    activeMatchColorOverviewRuler: "#d97757",
  },
};

interface Props {
  tabId: string;
  rect: { left: string; top: string; width: string; height: string };
  onClose: () => void;
}

/** Cmd+F bar over a pane, searching that terminal's scrollback. */
export function TerminalSearch({ tabId, rect, onClose }: Props) {
  // A search across tabs opens the bar already on its text.
  const [query, setQuery] = useState(() => useStore.getState().searchSeed);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [count, setCount] = useState<{ index: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const search = searches.get(tabId);

  useEffect(() => {
    if (!search) return;
    const sub = search.onDidChangeResults((r) => setCount({ index: r.resultIndex, total: r.resultCount }));
    return () => {
      sub.dispose();
      search.clearDecorations();
    };
  }, [search]);

  useEffect(() => {
    if (!search) return;
    if (!query) {
      search.clearDecorations();
      setCount(null);
      return;
    }
    search.findNext(query, { ...OPTIONS, caseSensitive, incremental: true });
  }, [query, caseSensitive, search]);

  // Refocus when Cmd+F is pressed again while the bar is open.
  useEffect(() => inputRef.current?.focus(), [tabId]);

  const close = () => {
    onClose();
    terminals.get(tabId)?.focus();
  };
  const step = (back: boolean) => {
    if (!query || !search) return;
    const opts = { ...OPTIONS, caseSensitive };
    if (back) search.findPrevious(query, opts);
    else search.findNext(query, opts);
  };

  if (!search) return null;

  return (
    <div className="term-search" style={{ left: `calc(${rect.left} + ${rect.width} - 330px)`, top: `calc(${rect.top} + 8px)` }}>
      <input
        ref={inputRef}
        autoFocus
        placeholder="Buscar no terminal"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          if (e.key === "Enter") step(e.shiftKey);
        }}
      />
      <span className="term-search-count">
        {count && query ? (count.total === 0 ? "0" : `${count.index + 1}/${count.total}`) : ""}
      </span>
      <button
        className={`icon-btn ${caseSensitive ? "on" : ""}`}
        title="Diferenciar maiúsculas"
        onClick={() => setCaseSensitive((c) => !c)}
      >
        Aa
      </button>
      <button className="icon-btn" title={`Anterior (${IS_MAC ? "⇧Enter" : "Shift+Enter"})`} onClick={() => step(true)}>
        ↑
      </button>
      <button className="icon-btn" title="Próximo (Enter)" onClick={() => step(false)}>
        ↓
      </button>
      <button className="icon-btn" title="Fechar (Esc)" onClick={close}>
        ×
      </button>
    </div>
  );
}
