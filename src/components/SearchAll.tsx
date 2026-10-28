import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { terminals } from "../lib/terminals";
import { isBeeTab } from "../lib/types";

/** Matches shown per tab, and in all. */
const PER_TAB = 5;
const TOTAL = 200;
/** Characters kept on each side of a match in its snippet. */
const AROUND = 60;

interface Hit {
  tabId: string;
  title: string;
  color: string;
  before: string;
  match: string;
  after: string;
  /** Matches in the tab, past the ones shown. */
  more: number;
}

/** The scrollback of a terminal as logical lines, wrapped rows joined back. */
function linesOf(tabId: string): string[] {
  const buffer = terminals.get(tabId)?.buffer.active;
  if (!buffer) return [];
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const row = buffer.getLine(i);
    if (!row) continue;
    const text = row.translateToString(true);
    if (row.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines;
}

/** Cmd+Shift+F: a text in the scrollback of every open terminal, by tab. */
export function SearchAll({ onClose }: { onClose: () => void }) {
  const { tabs, groups, activateTab, openSearch } = useStore();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const hits = useMemo<Hit[]>(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    const out: Hit[] = [];
    for (const tab of tabs) {
      if (tab.state === "dormant" || isBeeTab(tab)) continue;
      const color = groups.find((g) => g.id === tab.groupId)?.color ?? "transparent";
      const found = linesOf(tab.id).filter((l) => l.toLowerCase().includes(needle));
      found.slice(0, PER_TAB).forEach((line, i) => {
        const at = line.toLowerCase().indexOf(needle);
        out.push({
          tabId: tab.id,
          title: tab.title,
          color,
          before: (at > AROUND ? "…" : "") + line.slice(Math.max(0, at - AROUND), at).trimStart(),
          match: line.slice(at, at + needle.length),
          after: line.slice(at + needle.length, at + needle.length + AROUND).trimEnd(),
          more: i === PER_TAB - 1 ? found.length - PER_TAB : 0,
        });
      });
      if (out.length >= TOTAL) break;
    }
    return out.slice(0, TOTAL);
  }, [query, tabs, groups]);

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // The tab comes forward with its own Cmd+F bar already on the text.
  const pick = (hit: Hit | undefined) => {
    if (!hit) return;
    onClose();
    activateTab(hit.tabId);
    openSearch(hit.tabId, query.trim());
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal switcher" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="switcher-input"
          autoFocus
          placeholder="Buscar texto em todas as abas abertas"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, hits.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              pick(hits[cursor]);
            }
          }}
        />
        {query.trim().length < 2 ? (
          <p className="hint pad">Procura no histórico de cada terminal aberto, menos o das worker bees.</p>
        ) : hits.length === 0 ? (
          <p className="hint pad">Nada encontrado.</p>
        ) : (
          <ul className="switcher-list" ref={listRef}>
            {hits.map((h, i) => (
              <li
                key={`${h.tabId}-${i}`}
                className={`switcher-row ${i === cursor ? "on" : ""}`}
                onMouseMove={() => setCursor(i)}
                onClick={() => pick(h)}
              >
                <span className="pick-dot" style={{ background: h.color }} />
                <span className="switcher-main">
                  <span className="switcher-title">{h.title}</span>
                  <span className="switcher-sub search-all-line">
                    {h.before}
                    <mark>{h.match}</mark>
                    {h.after}
                  </span>
                </span>
                {h.more > 0 && <span className="switcher-tag">+{h.more}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
