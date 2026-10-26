import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { STATE_LABEL, isBeeTab, type Tab } from "../lib/types";

interface Entry {
  tab: Tab;
  groupName: string;
  color: string;
  folder: string;
  branch: string | null;
  hidden: boolean;
  detached: boolean;
  haystack: string;
}

/** Cmd+P: find a tab by name, folder, branch or group and jump to it. */
export function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const { tabs, groups, detached, gitByTab, activateTab, activeTabId } = useStore();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const entries = useMemo<Entry[]>(
    () =>
      tabs.filter((t) => !isBeeTab(t)).map((tab) => {
        const group = groups.find((g) => g.id === tab.groupId);
        const folder = tab.cwd ?? "";
        const branch = gitByTab[tab.id]?.branch ?? null;
        return {
          tab,
          groupName: group?.name ?? "",
          color: group?.color ?? "transparent",
          folder,
          branch,
          hidden: !!group?.hidden,
          detached: detached.includes(tab.id),
          haystack: [tab.title, folder, branch ?? "", group?.name ?? ""].join(" ").toLowerCase(),
        };
      }),
    [tabs, groups, detached, gitByTab],
  );

  const results = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matched = entries.filter((e) => e.tab.id !== activeTabId || terms.length > 0);
    if (terms.length === 0) return matched;
    return matched
      .filter((e) => terms.every((t) => e.haystack.includes(t)))
      .sort((a, b) => {
        const rank = (e: Entry) => (e.tab.title.toLowerCase().includes(terms[0]) ? 0 : 1);
        return rank(a) - rank(b);
      });
  }, [entries, query, activeTabId]);

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const pick = (e: Entry | undefined) => {
    if (!e) return;
    onClose();
    activateTab(e.tab.id);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal switcher" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="switcher-input"
          autoFocus
          placeholder="Buscar aba por nome, pasta, branch ou grupo"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              pick(results[cursor]);
            }
          }}
        />
        {results.length === 0 ? (
          <p className="hint pad">Nenhuma aba encontrada.</p>
        ) : (
          <ul className="switcher-list" ref={listRef}>
            {results.map((e, i) => (
              <li
                key={e.tab.id}
                className={`switcher-row state-${e.tab.state} ${i === cursor ? "on" : ""}`}
                onMouseMove={() => setCursor(i)}
                onClick={() => pick(e)}
              >
                <span className="pick-dot" style={{ background: e.color }} />
                <span className="switcher-main">
                  <span className="switcher-title">{e.tab.title}</span>
                  <span className="switcher-sub">
                    {[e.groupName, e.folder.split("/").slice(-2).join("/"), e.branch && `⎇ ${e.branch}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {e.hidden && <span className="switcher-tag">oculto</span>}
                {e.detached && <span className="switcher-tag">outra janela</span>}
                <span className="switcher-state">{STATE_LABEL[e.tab.state]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
