import { useMemo, useState } from "react";
import { useStore } from "../lib/store";
import { activeTopics, topicsOf } from "../lib/topics";
import { isHiddenTab, type Tab, type Topic } from "../lib/types";

/** The topics attached to a tab, followed in the store. */
function useTabTopics(tab: Tab): Topic[] {
  const topics = useStore((s) => s.topics);
  return useMemo(() => topicsOf(tab, topics), [tab, topics]);
}

const BookIcon = () => (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3h12v18l-6-4-6 4z" />
  </svg>
);

/** A small mark on a tab that keeps topics; their names show on hover. */
export function TopicMark({ tab }: { tab: Tab }) {
  const mine = useTabTopics(tab);
  if (!mine.length) return null;
  return (
    <span className="topic-mark" title={`Tópicos: ${mine.map((t) => t.name).join(", ")}`}>
      <BookIcon />
      {mine.length > 1 && <small>{mine.length}</small>}
    </span>
  );
}

/** The names of the topics a chat keeps, in its header. */
export function TopicChips({ tab }: { tab: Tab }) {
  const mine = useTabTopics(tab);
  if (!mine.length) return null;
  return (
    <span className="topic-chips">
      {mine.map((t) => (
        <span key={t.id} className="topic-chip" title={t.description || "Tópico ligado a esta conversa"}>
          <BookIcon />
          {t.name}
        </span>
      ))}
    </span>
  );
}

export function NewTopicButton() {
  const openModal = useStore((s) => s.openModal);
  return (
    <button className="ghost auto bee-new" onClick={() => openModal({ kind: "newTopic" })}>
      + Novo tópico
    </button>
  );
}

const STATE_LABEL: Record<Tab["state"], string> = {
  working: "trabalhando",
  waiting: "esperando você",
  permission: "pedindo permissão",
  shell: "terminal",
  dormant: "suspensa",
};

/**
 * Every topic with the chats and sessions that keep it. The topics' files are
 * the agent's, so the panel only creates topics, shows where each one is in
 * use and archives the ones that are done.
 */
export function TopicsPanel() {
  const topics = useStore((s) => s.topics);
  const tabs = useStore((s) => s.tabs);
  const groups = useStore((s) => s.groups);
  const activateTab = useStore((s) => s.activateTab);
  const setArchived = useStore((s) => s.setTopicArchived);
  const [showArchived, setShowArchived] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const active = activeTopics(topics);
  const archived = topics.filter((t) => t.archived);

  if (!topics.length) {
    return (
      <p className="hint topics-empty">
        Um tópico guarda o que um assunto longo ensinou, fora do chat. Crie um aqui, ligue a uma aba pelo botão direito nela ou digite{" "}
        <code>:topico Nome</code> na conversa. O Claude daquela aba passa a cuidar dele: lê o que precisa e salva o que importa.
      </p>
    );
  }

  return (
    <div className="topics-panel">
      <ul className="topic-list">
        {active.map((t) => {
          const users = tabs.filter((tab) => !isHiddenTab(tab) && tab.topicIds?.includes(t.id));
          return (
            <li key={t.id} className="topic-item">
              <div className="topic-head">
                <BookIcon />
                <b>{t.name}</b>
                {confirming === t.id ? (
                  <span className="topic-confirm">
                    <button className="ghost small danger" onClick={() => (setArchived(t.id, true), setConfirming(null))}>
                      Arquivar
                    </button>
                    <button className="ghost small" onClick={() => setConfirming(null)}>
                      Não
                    </button>
                  </span>
                ) : (
                  <button
                    className="ghost small topic-archive"
                    title="Tira o tópico das listas e das abas. A pasta dele fica guardada."
                    onClick={() => setConfirming(t.id)}
                  >
                    Arquivar
                  </button>
                )}
              </div>
              {t.description && <p className="topic-desc">{t.description}</p>}
              {users.length ? (
                <ul className="topic-tabs">
                  {users.map((tab) => (
                    <li key={tab.id}>
                      <button className={`topic-tab state-${tab.state}`} onClick={() => activateTab(tab.id)}>
                        <span className="dot" />
                        <span className="topic-tab-title">{tab.title}</span>
                        <span className="muted">
                          {groups.find((g) => g.id === tab.groupId)?.name ?? ""} · {STATE_LABEL[tab.state]}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="hint">Nenhuma aba ligada. Use o botão direito numa aba ou :topico {t.name}.</p>
              )}
            </li>
          );
        })}
      </ul>
      {archived.length > 0 && (
        <section className="topics-archived">
          <button className="ghost small" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? "▾" : "›"} Arquivados ({archived.length})
          </button>
          {showArchived && (
            <ul className="topic-list">
              {archived.map((t) => (
                <li key={t.id} className="topic-item archived">
                  <div className="topic-head">
                    <BookIcon />
                    <b>{t.name}</b>
                    <button className="ghost small topic-archive" onClick={() => setArchived(t.id, false)}>
                      Restaurar
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
