import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../lib/store";
import { terminals } from "../lib/terminals";
import { sendMessage } from "../lib/typing";
import { useAgentEntries } from "../lib/codex";
import type { ChatEntry as Entry, Tab } from "../lib/types";

/** How often a session's transcript is read for new entries. */
const READ_MS = 700;

interface Chunk {
  entries: Entry[];
  offset: number;
  reset: boolean;
  clipped: boolean;
}

interface Step {
  id: string;
  tool: string;
  text: string;
  result: string | null;
  error: boolean;
}

type Item =
  | { kind: "user" | "text" | "error"; id: string; text: string }
  | { kind: "steps"; id: string; steps: Step[] };

/** Groups the steps between two messages into one row, with each result under its step. */
function itemsOf(entries: Entry[]): Item[] {
  const results = new Map(entries.filter((e) => e.kind === "result").map((e) => [e.id, e]));
  const items: Item[] = [];
  for (const e of entries) {
    if (e.kind === "result") continue;
    if (e.kind === "step") {
      const r = results.get(e.id);
      const step = { id: e.id, tool: e.tool ?? "", text: e.text, result: r?.text ?? null, error: !!r?.error };
      const last = items[items.length - 1];
      if (last?.kind === "steps") last.steps.push(step);
      else items.push({ kind: "steps", id: e.id, steps: [step] });
      continue;
    }
    items.push({ kind: e.kind, id: e.id, text: e.text });
  }
  return items;
}

/** The transcript of a tab's session, followed as it grows. */
function useTranscript(path: string | null) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    setEntries([]);
    setClipped(false);
    if (!path) return;
    let offset = 0;
    let busy = false;
    let alive = true;
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        const chunk = await invoke<Chunk>("chat_read", { path, offset });
        if (!alive) return;
        if (chunk.reset) setEntries(chunk.entries);
        else if (chunk.entries.length) setEntries((prev) => prev.concat(chunk.entries));
        if (chunk.clipped) setClipped(true);
        offset = chunk.offset;
      } catch {
        // The file may not exist yet; the next read tries again.
      } finally {
        busy = false;
      }
    };
    void read();
    const id = setInterval(read, READ_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [path]);
  return { entries, clipped };
}

function StepsRow({ steps, running }: { steps: Step[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  const failed = steps.filter((s) => s.error).length;
  const pending = running && steps.some((s) => s.result === null);
  const tools = [...new Set(steps.map((s) => s.tool))].join(", ");
  return (
    <li className="chat-steps">
      <button className="chat-steps-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chat-caret">{open ? "▾" : "▸"}</span>
        {steps.length === 1 ? "1 passo" : `${steps.length} passos`}
        <span className="muted"> · {tools}</span>
        {failed > 0 && <span className="chat-failed"> · {failed} com erro</span>}
        {pending && <span className="muted"> · rodando…</span>}
      </button>
      {open && (
        <ol className="chat-step-list">
          {steps.map((s) => (
            <li key={s.id} className={s.error ? "error" : s.result === null ? "pending" : undefined}>
              <span className="chat-tool">{s.tool}</span>
              <code>{s.text}</code>
              {s.result && <pre>{s.result}</pre>}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

interface Props {
  tab: Tab;
  rect: { left: string; top: string; width: string; height: string };
}

/**
 * A tab's agent session as a chat. Claude keeps running in the tab's terminal
 * underneath: messages are typed into it and the conversation is read back
 * from the session's transcript. Codex runs in its app-server, which reports
 * the conversation and takes the messages.
 */
export function ChatView({ tab, rect }: Props) {
  const setTabView = useStore((s) => s.setTabView);
  const asking = useStore((s) => s.questions.some((q) => q.tab_id === tab.id));
  const codex = tab.provider === "codex";
  const transcript = useTranscript(codex ? null : tab.transcriptPath);
  const codexEntries = useAgentEntries((s) => s.byTab[tab.id]);
  const entries = codex ? (codexEntries ?? []) : transcript.entries;
  const clipped = !codex && transcript.clipped;
  const agent = codex ? "Codex" : "Claude";
  const items = useMemo(() => itemsOf(entries), [entries]);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLOListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const working = tab.state === "working";
  const claudeRunning = tab.state !== "dormant" && tab.state !== "shell";

  // Follows the bottom while new entries arrive.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  useEffect(() => inputRef.current?.focus(), [tab.id]);

  const send = () => {
    const text = draft.trim();
    if (!text || !claudeRunning) return;
    setDraft("");
    if (codex) void invoke("codex_send", { tabId: tab.id, text }).catch(() => {});
    else void sendMessage(tab.id, text);
  };

  const toTerminal = () => {
    setTabView(tab.id, undefined);
    terminals.get(tab.id)?.focus();
  };

  return (
    <div className="chat-view" style={rect}>
      <header className="chat-head">
        <h2>{tab.title}</h2>
        {!codex && (
          <button className="ghost auto" onClick={toTerminal} title="Mostrar o terminal desta aba">
            Ver terminal
          </button>
        )}
      </header>
      <ol className="chat-list" ref={listRef}>
        {clipped && <li className="chat-note">O começo desta sessão ficou de fora. Ele continua no terminal.</li>}
        {items.length === 0 && (
          <li className="chat-note">
            {codex
              ? claudeRunning
                ? "Mande a primeira mensagem para o Codex."
                : "Abrindo o Codex…"
              : tab.transcriptPath
                ? "A conversa aparece aqui conforme o Claude grava."
                : "Nenhuma sessão do Claude nesta aba ainda."}
          </li>
        )}
        {items.map((it, i) =>
          it.kind === "steps" ? (
            <StepsRow key={it.id} steps={it.steps} running={working && i === items.length - 1} />
          ) : (
            <li
              key={`${it.kind}:${it.id}`}
              className={it.kind === "error" ? "chat-error" : `chat-msg ${it.kind === "user" ? "from-user" : "from-agent"}`}
            >
              {it.text}
            </li>
          ),
        )}
        {working && <li className="chat-note working">Trabalhando…</li>}
      </ol>
      {asking && !codex && (
        <div className="chat-ask">
          O Claude fez uma pergunta com opções. Responda no terminal.
          <button className="ghost auto" onClick={toTerminal}>
            Abrir terminal
          </button>
        </div>
      )}
      <div className="chat-composer">
        <textarea
          ref={inputRef}
          value={draft}
          rows={2}
          placeholder={claudeRunning ? `Mensagem para o ${agent}` : `O ${agent} não está rodando nesta aba`}
          disabled={!claudeRunning}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {working ? (
          <button className="ghost danger auto" onClick={() =>
              void (codex
                ? invoke("codex_interrupt", { tabId: tab.id })
                : invoke("pty_write", { id: tab.id, data: "\x1b" })
              ).catch(() => {})
            }
            title={`Interrompe o ${agent}`}
          >
            Parar
          </button>
        ) : (
          <button className="primary" onClick={send} disabled={!draft.trim() || !claudeRunning}>
            Enviar
          </button>
        )}
      </div>
    </div>
  );
}
