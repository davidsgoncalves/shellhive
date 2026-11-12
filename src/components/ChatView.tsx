import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../lib/store";
import { terminals } from "../lib/terminals";
import { sendMessage } from "../lib/typing";
import { pushEntries, setAgentView, switchAgent, useAgentEntries, useAgentModels } from "../lib/agents";
import { agentCommand, CLAUDE_MODELS, PROVIDER_NAMES, type Provider } from "../lib/providers";
import { Markdown } from "../lib/markdown";
import { droneOfTab, parseLetter } from "../lib/colony";
import { BeeAvatar } from "./BeeAvatar";
import { isColonyTab, type ChatEntry as Entry, type Tab } from "../lib/types";

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

interface Attached {
  path: string;
  preview: string;
}

/** Saves a pasted or picked image to a file the agent can take. */
async function saveImage(file: Blob): Promise<Attached> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const ext = file.type.split("/")[1] ?? "png";
  const path = await invoke<string>("chat_save_image", { data, ext });
  return { path, preview: URL.createObjectURL(file) };
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

/** The note that stands for the colony's introduction in a drone's chat, opened on click. */
function IntroNote({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="chat-steps">
      <button className="chat-steps-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chat-caret">{open ? "▾" : "▸"}</span>
        Instruções da colony
      </button>
      {open && <pre className="chat-intro">{text}</pre>}
    </li>
  );
}

/** The drones of a colony by name, to put each colleague's avatar on their letters. */
type Members = Map<string, { id: string; queen: boolean }>;

function Colleague({ from, kind, body, members }: { from: string; kind: string; body: string; members: Members }) {
  // A Queen Bee is named "Nome (Queen Bee)" in letters; the avatar goes by the bare name.
  const who = members.get(from.replace(/\s*\(.*\)$/, ""));
  return (
    <li className="chat-msg from-colleague">
      <span className="chat-from">
        <BeeAvatar seed={who?.id ?? from} queen={who?.queen} size={18} />
        {from} · {kind}
      </span>
      <Markdown text={body} />
    </li>
  );
}

/** One message of a chat; in a drone's chat, what the colony typed shows as such, not as the user's. */
function MessageRow({ kind, text, members }: { kind: "user" | "text" | "error"; text: string; members: Members | null }) {
  const letter = members && kind === "user" ? parseLetter(text) : null;
  if (letter?.kind === "intro") {
    const carried = letter.rest ? parseLetter(letter.rest) : null;
    return (
      <>
        <IntroNote text={text} />
        {carried && carried.kind !== "intro" && <MessageRow kind="user" text={letter.rest} members={members} />}
      </>
    );
  }
  if (letter?.kind === "replies")
    return (
      <>
        {letter.parts.map((p) => (
          <Colleague key={p.from} from={p.from} kind="resposta" body={p.body} members={members!} />
        ))}
      </>
    );
  if (letter) return <Colleague from={letter.from} kind={letter.kind === "reply" ? "resposta" : "pedido"} body={letter.body} members={members!} />;
  return (
    <li className={kind === "error" ? "chat-error" : `chat-msg ${kind === "user" ? "from-user" : "from-agent"}`}>
      {kind === "text" ? <Markdown text={text} /> : text}
    </li>
  );
}

/** A finished session's conversation, read only: a bee run looked at after it ended. */
export function TranscriptView({ path }: { path: string }) {
  const { entries, clipped } = useTranscript(path);
  const items = useMemo(() => itemsOf(entries), [entries]);
  return (
    <ol className="chat-list">
      {clipped && <li className="chat-note">O começo desta sessão ficou de fora.</li>}
      {items.length === 0 && <li className="chat-note chat-empty">Lendo a conversa…</li>}
      {items.map((it) =>
        it.kind === "steps" ? (
          <StepsRow key={it.id} steps={it.steps} running={false} />
        ) : (
          <li
            key={`${it.kind}:${it.id}`}
            className={it.kind === "error" ? "chat-error" : `chat-msg ${it.kind === "user" ? "from-user" : "from-agent"}`}
          >
            {it.kind === "text" ? <Markdown text={it.text} /> : it.text}
          </li>
        ),
      )}
    </ol>
  );
}

interface Props {
  tab: Tab;
  rect: { left: string; top: string; width: string; height: string };
}

/**
 * A tab's agent session as a chat. Claude keeps running in the tab's terminal
 * underneath: messages are typed into it and the conversation is read back
 * from the session's transcript. Codex and OpenCode run in a process of
 * their own, which reports the conversation and takes the messages.
 */
export function ChatView({ tab, rect }: Props) {
  const setTabView = useStore((s) => s.setTabView);
  const asking = useStore((s) => s.questions.some((q) => q.tab_id === tab.id));
  const provider = tab.provider;
  const transcript = useTranscript(provider ? null : tab.transcriptPath);
  const agentEntries = useAgentEntries((s) => s.byTab[tab.id]);
  const entries = provider ? (agentEntries ?? []) : transcript.entries;
  const clipped = !provider && transcript.clipped;
  const agent = provider ? PROVIDER_NAMES[provider] : "Claude";
  const items = useMemo(() => itemsOf(entries), [entries]);
  const drone = isColonyTab(tab) ? droneOfTab(tab.id) : undefined;
  const allDrones = useStore((s) => s.drones);
  const members = useMemo<Members | null>(
    () => (drone ? new Map(allDrones.filter((d) => d.colonyId === drone.colonyId).map((d) => [d.name, { id: d.id, queen: d.queen }])) : null),
    [drone, allDrones],
  );
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<Attached[]>([]);
  const [switching, setSwitching] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const patchTab = useStore((s) => s.patchTab);
  const agentModels = useAgentModels((s) => s.byTab[tab.id]);
  const claudeModel = useStore((s) => s.statusByTab[tab.id]?.model?.id);
  const claudeModelName = useStore((s) => s.statusByTab[tab.id]?.model?.display_name);
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

  const attach = (files: Iterable<Blob>) => {
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      saveImage(f)
        .then((img) => setImages((list) => [...list, img]))
        .catch((err) => pushEntries(tab.id, [{ kind: "error", id: `img:${Date.now()}`, text: `A imagem não foi anexada: ${String(err)}` }]));
    }
  };

  const send = () => {
    const text = draft.trim();
    if ((!text && images.length === 0) || !claudeRunning) return;
    const paths = images.map((i) => i.path);
    images.forEach((i) => URL.revokeObjectURL(i.preview));
    setDraft("");
    setImages([]);
    if (provider) {
      void invoke(agentCommand(provider, "send"), { tabId: tab.id, text, model: tab.agentModel ?? null, images: paths }).catch((err) =>
        pushEntries(tab.id, [{ kind: "error", id: `send:${Date.now()}`, text: `A mensagem não foi enviada: ${String(err)}` }]),
      );
    } else {
      // Claude takes an image named by its path in the message.
      void sendMessage(tab.id, [text, ...paths].filter(Boolean).join(" "));
    }
  };

  const pickModel = (model: string) => {
    if (provider) patchTab(tab.id, { agentModel: model });
    else if (model) void sendMessage(tab.id, `/model ${model}`);
  };
  // Claude's list marks the model the session runs, read from its status line.
  const models: [string, string][] = provider
    ? (agentModels ?? []).map((m) => [m, m])
    : claudeModel && !CLAUDE_MODELS.some(([id]) => id === claudeModel)
      ? [[claudeModel, claudeModelName ?? claudeModel], ...CLAUDE_MODELS]
      : CLAUDE_MODELS;
  const currentModel = provider ? (tab.agentModel ?? "") : (claudeModel ?? "");

  const toTerminal = () => {
    setTabView(tab.id, undefined);
    terminals.get(tab.id)?.focus();
  };

  // The message box grows with what is typed, up to a limit.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft]);

  const stop = () =>
    void (provider
      ? invoke(agentCommand(provider, "interrupt"), { tabId: tab.id })
      : invoke("pty_write", { id: tab.id, data: "\x1b" })
    ).catch(() => {});

  return (
    <div className="chat-view" style={rect}>
      <header className="chat-head">
        {drone && <BeeAvatar seed={drone.id} queen={drone.queen} size={26} />}
        <h2 className={drone ? "drone-title" : undefined}>
          {drone ? drone.name : tab.title}
          {drone?.queen && <span className="drone-queen">Queen Bee</span>}
          {drone && !drone.queen && drone.role && <span className="drone-head-role">{drone.role}</span>}
        </h2>
        {items.length === 0 && !isColonyTab(tab) && (
          <select
            className="chat-pick"
            value={provider ?? "claude"}
            disabled={switching}
            title="Agente desta aba, enquanto a conversa não começou"
            onChange={(e) => {
              setSwitching(true);
              void switchAgent(tab.id, e.target.value as Provider | "claude").finally(() => setSwitching(false));
            }}
          >
            <option value="claude">Claude</option>
            {(Object.keys(PROVIDER_NAMES) as Provider[]).map((p) => (
              <option key={p} value={p}>
                {PROVIDER_NAMES[p]}
              </option>
            ))}
          </select>
        )}
        {models.length > 0 && (
          <select
            className="chat-pick"
            value={currentModel}
            disabled={!claudeRunning}
            title={provider ? "Modelo das próximas mensagens" : "Troca o modelo da sessão com /model"}
            onChange={(e) => pickModel(e.target.value)}
          >
            {!provider && !claudeModel && <option value="">Modelo</option>}
            {models.map(([id, label]) => (
              <option key={id} value={id}>
                {provider ? label : `${agent} ${label}`}
              </option>
            ))}
          </select>
        )}
        {/* A drone lives on the Colony screen, which has no way back from its terminal. */}
        {!isColonyTab(tab) && (
          <button
            className="chat-head-btn"
            onClick={() => (provider ? void setAgentView(tab.id, "terminal") : toTerminal())}
            title={provider ? `Abrir esta sessão na interface do ${agent}` : "Mostrar o terminal desta aba"}
          >
            Terminal
          </button>
        )}
      </header>
      <ol className="chat-list" ref={listRef}>
        {clipped && <li className="chat-note">O começo desta sessão ficou de fora. Ele continua no terminal.</li>}
        {items.length === 0 && (
          <li className="chat-note chat-empty">
            {provider
              ? claudeRunning
                ? `Mande a primeira mensagem para o ${agent}.`
                : `Abrindo o ${agent}…`
              : tab.transcriptPath
                ? "A conversa aparece aqui conforme o Claude grava."
                : "Abrindo o Claude…"}
          </li>
        )}
        {items.map((it, i) =>
          it.kind === "steps" ? (
            <StepsRow key={it.id} steps={it.steps} running={working && i === items.length - 1} />
          ) : (
            <MessageRow key={`${it.kind}:${it.id}`} kind={it.kind} text={it.text} members={members} />
          ),
        )}
        {working && (
          <li className="chat-note working">
            <span className="chat-dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            {agent} trabalhando
          </li>
        )}
      </ol>
      <div className="chat-bottom">
        {asking && !provider && (
          <div className="chat-ask">
            O Claude fez uma pergunta com opções. Responda no terminal.
            <button className="ghost auto" onClick={toTerminal}>
              Abrir terminal
            </button>
          </div>
        )}
        <div className={`chat-composer ${claudeRunning ? "" : "off"}`} onClick={() => inputRef.current?.focus()}>
          {images.length > 0 && (
            <div className="chat-attached">
              {images.map((img) => (
                <button
                  key={img.path}
                  className="chat-thumb"
                  title="Remover a imagem"
                  onClick={(e) => {
                    e.stopPropagation();
                    URL.revokeObjectURL(img.preview);
                    setImages((list) => list.filter((i) => i !== img));
                  }}
                >
                  <img src={img.preview} alt="" />
                </button>
              ))}
            </div>
          )}
          <div className="chat-input-row">
            <button
              className="chat-round ghosted"
              title="Anexar imagem"
              disabled={!claudeRunning}
              onClick={(e) => {
                e.stopPropagation();
                fileRef.current?.click();
              }}
            >
              +
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                attach(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <textarea
              ref={inputRef}
              value={draft}
              rows={1}
              placeholder={claudeRunning ? `Mensagem para o ${agent}` : `O ${agent} não está rodando nesta aba`}
              disabled={!claudeRunning}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
                if (files.length) {
                  e.preventDefault();
                  attach(files);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {working ? (
              <button className="chat-round stop" title={`Interrompe o ${agent}`} onClick={stop}>
                ■
              </button>
            ) : (
              <button
                className="chat-round send"
                title="Enviar"
                onClick={send}
                disabled={(!draft.trim() && images.length === 0) || !claudeRunning}
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
