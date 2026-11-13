import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useStore } from "../lib/store";
import { Markdown } from "../lib/markdown";
import { BeeAvatar, beeColor } from "./BeeAvatar";
import { usePermissionActions } from "./PermissionQueue";
import type { PermissionRequest, QuestionItem } from "../lib/types";

export interface Step {
  id: string;
  tool: string;
  text: string;
  result: string | null;
  error: boolean;
}

type Kind = "read" | "search" | "edit" | "write" | "run" | "web" | "agent" | "todo" | "message" | "other";

/** What kind of work a tool does, across Claude's, Codex's and OpenCode's names. */
function kindOf(tool: string): Kind {
  const t = tool.toLowerCase().replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
  if (t === "send_message") return "message";
  if (t === "read" || t === "view" || t === "notebookread") return "read";
  if (["grep", "glob", "ls", "list", "search", "find"].includes(t)) return "search";
  if (["edit", "multiedit", "notebookedit", "apply_patch", "patch"].includes(t)) return "edit";
  if (t === "write" || t === "create") return "write";
  if (["bash", "bashoutput", "killshell", "shell", "exec", "command", "local_shell"].includes(t)) return "run";
  if (["webfetch", "websearch", "web_search", "fetch"].includes(t)) return "web";
  if (t === "task" || t === "agent") return "agent";
  if (t === "todowrite" || t === "todo" || t === "update_plan") return "todo";
  return "other";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Leu 3 arquivos e rodou 2 comandos": a round of tool steps in a line. */
export function summarize(steps: Step[]): string {
  const by = new Map<Kind, Step[]>();
  for (const s of steps) {
    const k = kindOf(s.tool);
    by.set(k, [...(by.get(k) ?? []), s]);
  }
  // Reading or editing the same file twice is still one file.
  const files = (list: Step[]) => new Set(list.map((s) => s.text)).size;
  const parts: string[] = [];
  for (const [k, list] of by) {
    const n = list.length;
    if (k === "read") parts.push(`leu ${plural(files(list), "arquivo", "arquivos")}`);
    else if (k === "search") parts.push(`fez ${plural(n, "busca", "buscas")}`);
    else if (k === "edit") parts.push(`editou ${plural(files(list), "arquivo", "arquivos")}`);
    else if (k === "write") parts.push(`criou ${plural(files(list), "arquivo", "arquivos")}`);
    else if (k === "run") parts.push(`rodou ${plural(n, "comando", "comandos")}`);
    else if (k === "web") parts.push(n === 1 ? "pesquisou na web" : `fez ${n} consultas na web`);
    else if (k === "agent") parts.push(`chamou ${plural(n, "subagente", "subagentes")}`);
    else if (k === "todo") parts.push("atualizou as tarefas");
    else if (k === "message") parts.push(`mandou ${plural(n, "mensagem", "mensagens")}`);
    else parts.push(`usou ${plural(n, "ferramenta", "ferramentas")}`);
  }
  const line = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}` : (parts[0] ?? "");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** A round of tool steps as one quiet line in the middle, opened on click. */
export function StepsLine({ steps, running }: { steps: Step[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const failed = steps.filter((s) => s.error).length;
  const pending = running && steps.some((s) => s.result === null);
  return (
    <li className="chat-event-wrap">
      <button className={`chat-event ${failed ? "failed" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <b>
          {summarize(steps)}
          {failed > 0 && `, ${failed} com erro`}
          {pending && "…"}
        </b>
        <span className="chat-event-caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <ol className="chat-event-detail">
          {steps.map((s) => (
            <li key={s.id} className={s.error ? "error" : s.result === null ? "pending" : undefined}>
              <button className="chat-step" onClick={() => setShown(shown === s.id ? null : s.id)} disabled={!s.result}>
                <span className="chat-tool">{s.tool}</span>
                <code>{s.text}</code>
                <span className="chat-step-state">{s.error ? "erro" : s.result === null ? (running ? "rodando…" : "") : "ok"}</span>
              </button>
              {shown === s.id && s.result && <pre>{s.result}</pre>}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

/** A colleague's letter in a colony chat: one line in the middle, the text on click. */
export function ColonyEvent({
  from,
  label,
  body,
  seed,
  queen,
  open: openAtFirst = false,
}: {
  from: string;
  label: string;
  body: string;
  seed: string;
  queen?: boolean;
  open?: boolean;
}) {
  const [open, setOpen] = useState(openAtFirst);
  return (
    <li className="chat-event-wrap" style={{ ["--g" as string]: beeColor(seed) }}>
      <button className="chat-event" onClick={() => setOpen(!open)} aria-expanded={open}>
        {label} de <BeeAvatar seed={seed} queen={queen} size={18} />
        <b>{from}</b>
        <span className="chat-event-caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="chat-event-detail letter">
          <Markdown text={body} />
        </div>
      )}
    </li>
  );
}

/** A session error, with a way to send the last message again. */
export function ErrorBubble({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <li className="chat-msg from-agent chat-error-bubble">
      <span>{text}</span>
      {onRetry && (
        <button className="chat-pill" onClick={onRetry}>
          Enviar de novo
        </button>
      )}
    </li>
  );
}

/** A permission the agent asks for, answered in the chat. */
export function PermissionBubble({ req }: { req: PermissionRequest }) {
  const { tool, summary, risky, sent, decide, always } = usePermissionActions(req);
  return (
    <li className={`chat-msg from-agent chat-wait ${risky ? "risky" : ""}`}>
      <span className="chat-wait-kind">Permissão · {tool ?? "ferramenta"}</span>
      <code className="chat-wait-cmd">{summary}</code>
      {risky && <span className="chat-wait-note">Parece destrutivo: decida no terminal.</span>}
      <div className="chat-pills">
        <button className="chat-pill main" disabled={!!sent || risky} onClick={() => void decide("allow")}>
          Permitir
        </button>
        {always && (
          <button className="chat-pill" disabled={!!sent} title={always.title} onClick={always.run}>
            {always.label}
          </button>
        )}
        <button className="chat-pill" disabled={!!sent} onClick={() => void decide("deny")}>
          Negar
        </button>
        <button className="chat-pill" disabled={!!sent} onClick={() => void decide("ask")}>
          No terminal
        </button>
      </div>
    </li>
  );
}

/** Claude's question with its options; picking one answers it without the terminal. */
export function QuestionBubble({ item, onTerminal }: { item: QuestionItem; onTerminal: () => void }) {
  const setQuestionRequest = useStore((s) => s.setQuestionRequest);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [writing, setWriting] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const live = !!item.request_id && !sent;

  const submit = async (answers: Record<string, string>) => {
    setSent(true);
    const ok = await invoke<boolean>("permission_decide", {
      id: item.request_id,
      decision: "allow",
      reason: "Respondido no chat do Shellhive",
      updatedInput: { questions: item.questions, answers },
    }).catch(() => false);
    if (!ok && item.tab_id) setQuestionRequest(item.tab_id, null);
  };

  // Every question answered: single choices go at once, the rest on Enviar.
  const answersFor = (next: Record<string, string[]>, texts: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const q of item.questions) {
      const chosen = [...(next[q.question] ?? []), ...(texts[q.question] ? [texts[q.question]] : [])];
      if (chosen.length === 0) return null;
      out[q.question] = chosen.join(", ");
    }
    return out;
  };
  const needsSend = item.questions.some((q) => q.multiSelect) || item.questions.length > 1;

  const pick = (question: string, label: string, multi?: boolean) => {
    const current = picked[question] ?? [];
    const list = multi ? (current.includes(label) ? current.filter((l) => l !== label) : [...current, label]) : [label];
    const next = { ...picked, [question]: list };
    setPicked(next);
    if (!needsSend) {
      const answers = answersFor(next, other);
      if (answers) void submit(answers);
    }
  };

  const release = () => {
    if (item.request_id) void invoke("permission_decide", { id: item.request_id, decision: "ask" });
    if (item.tab_id) setQuestionRequest(item.tab_id, null);
    onTerminal();
  };

  const ready = answersFor(picked, other);
  return (
    <li className="chat-msg from-agent chat-wait">
      {item.questions.map((q) => (
        <div key={q.question} className="chat-question">
          <span className="chat-wait-kind">{q.header ?? "Pergunta"}</span>
          <span className="chat-wait-text">{q.question}</span>
          <div className="chat-pills">
            {(q.options ?? []).map((o) => (
              <button
                key={o.label}
                className={`chat-pill ${(picked[q.question] ?? []).includes(o.label) ? "main" : ""}`}
                title={o.description}
                disabled={!live}
                onClick={() => pick(q.question, o.label, q.multiSelect)}
              >
                {o.label}
              </button>
            ))}
            {live && writing !== q.question && (
              <button className="chat-pill" onClick={() => setWriting(q.question)}>
                Outra resposta…
              </button>
            )}
          </div>
          {live && writing === q.question && (
            <input
              autoFocus
              className="chat-other"
              placeholder="Sua resposta"
              value={other[q.question] ?? ""}
              onChange={(e) => setOther({ ...other, [q.question]: e.target.value })}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const answers = answersFor(picked, other);
                if (answers && !needsSend) void submit(answers);
              }}
            />
          )}
        </div>
      ))}
      {live ? (
        <div className="chat-pills">
          {needsSend && (
            <button className="chat-pill main" disabled={!ready} onClick={() => ready && void submit(ready)}>
              Enviar
            </button>
          )}
          <button className="chat-link" onClick={release}>
            Responder no terminal
          </button>
        </div>
      ) : (
        !sent && (
          <div className="chat-pills">
            <span className="chat-wait-note">Esta pergunta está no terminal.</span>
            <button className="chat-link" onClick={onTerminal}>
              Abrir terminal
            </button>
          </div>
        )
      )}
    </li>
  );
}

const MEDIA_RE = /(?:^|[\s(`'"<[])((?:\/|~\/)[^\s)`'"<>\]]+\.(png|jpe?g|gif|webp|mp4|mov|webm|pdf|zip))(?=$|[\s)`'".,;:>\]])/gi;

/** Image and file paths an agent's message names, in order, without repeats. */
export function mediaIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MEDIA_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

/** An image the agent produced, shown under its message; other files as a card. */
export function ChatMedia({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const image = IMAGE_RE.test(path);
  useEffect(() => {
    if (!image) return;
    let alive = true;
    invoke<string>("chat_media", { path })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setMissing(true));
    return () => {
      alive = false;
    };
  }, [path, image]);
  const name = path.split("/").pop() ?? path;
  // An image that is not on disk is just a name in the text.
  if (image) return src && !missing ? <img className="chat-image" src={src} alt={name} title={path} /> : null;
  return (
    <div className="chat-file" title={path}>
      <span className="chat-file-name">{name}</span>
      <button className="chat-link" onClick={() => void revealItemInDir(path).catch(() => {})}>
        Mostrar na pasta
      </button>
    </div>
  );
}
