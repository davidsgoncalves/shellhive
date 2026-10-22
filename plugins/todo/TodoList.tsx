import { useEffect, useState } from "react";
import { openSession, useStore } from "../../src/lib/store";
import { newTodo, useTodos, type Todo } from "./state";

const when = (at: number) =>
  new Date(at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const folderName = (cwd: string | null) => cwd?.split(/[\\/]/).filter(Boolean).pop() ?? null;

/** The list in the right column: open items first, newest on top. */
export function TodoList() {
  const { todos, loaded, load, add, toggle, remove } = useTodos();
  const tabs = useStore((s) => s.tabs);
  const [draft, setDraft] = useState("");
  useEffect(() => void load(), [load]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    const s = useStore.getState();
    void add(newTodo(text, "user", s.tabs.find((t) => t.id === s.activeTabId)));
    setDraft("");
  };

  const meta = (t: Todo) =>
    [
      t.by === "claude" ? "Claude" : "você",
      folderName(t.cwd),
      tabs.find((tab) => tab.id === t.tabId)?.title ?? t.tabTitle,
      when(t.at),
    ]
      .filter(Boolean)
      .join(" · ");

  const ordered = [...todos.filter((t) => !t.done), ...todos.filter((t) => t.done)];

  return (
    <div className="todo">
      <textarea
        className="todo-input"
        placeholder="Novo item (Enter para adicionar)"
        rows={2}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {!loaded ? (
        <p className="hint pad">Carregando…</p>
      ) : ordered.length === 0 ? (
        <p className="hint pad">Nada na lista. Peça ao Claude para anotar algo ou escreva acima.</p>
      ) : (
        <ul className="todo-list">
          {ordered.map((t) => (
            <li key={t.id} className={t.done ? "done" : undefined}>
              <input
                type="checkbox"
                checked={t.done}
                title={t.done ? "Reabrir" : "Concluir"}
                onChange={() => void toggle(t.id)}
              />
              <div className="todo-body">
                <span className="todo-text">{t.text}</span>
                <span className="todo-meta">{meta(t)}</span>
              </div>
              {t.sessionId && (
                <button
                  className="icon-btn"
                  title="Voltar à sessão"
                  onClick={() => openSession({ id: t.sessionId!, cwd: t.cwd, title: t.tabTitle || "Sessão" })}
                >
                  ↩
                </button>
              )}
              <button className="icon-btn" title="Excluir" onClick={() => void remove(t.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
