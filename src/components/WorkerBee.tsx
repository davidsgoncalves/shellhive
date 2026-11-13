import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useStore } from "../lib/store";
import {
  DAY_NAMES,
  describeEvent,
  describeTrigger,
  hasUnfilled,
  markRunRead,
  openBeeRun,
  runBee,
  stopBeeRun,
  useBeeRuns,
  useUnreadRuns,
} from "../lib/bees";
import { TranscriptView } from "./ChatView";
import { PERMISSION_MODES } from "./Dialogs";
import { openBeeCreator } from "../lib/beeCreator";
import { BLANK_PROMPT, TEMPLATES, type BeeTemplate } from "../lib/beeTemplates";
import { BEE_GROUP_ID, isBeeTab, type Bee, type BeeEvent, type BeeRun, type BeeTrigger, type PathCheck } from "../lib/types";
import { PermissionCard, QuestionCard } from "./PermissionQueue";

/** Requests from the bees' hidden tabs: permissions and questions. */
export function useBeeWaiting() {
  const s = useStore();
  const bee = new Set(s.tabs.filter(isBeeTab).map((t) => t.id));
  return {
    permissions: s.permissions.filter((p) => bee.has(p.tab_id ?? "")),
    questions: s.questions.filter((q) => bee.has(q.tab_id ?? "")),
  };
}

const STATUS_LABEL: Record<BeeRun["status"], string> = { running: "rodando", done: "concluída", error: "com erro" };

const when = (at: number) =>
  new Date(at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const clock = (at: number) => new Date(at).toLocaleString("pt-BR", { weekday: "short", hour: "2-digit", minute: "2-digit" });

const duration = (from: number, to: number) => {
  const min = Math.max(0, Math.round((to - from) / 60_000));
  return min < 1 ? "menos de 1 min" : min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
};

/** The bee shown in the center: the one picked, else the first. */
function useShownBee() {
  const bees = useStore((s) => s.bees);
  const view = useStore((s) => s.beeView);
  if (view?.mode === "new" || view?.mode === "activity" || view?.mode === "run") return null;
  return bees.find((b) => b.id === view?.id) ?? bees[0] ?? null;
}

/** The hidden tab of the shown bee's run in progress, drawn live in the center. */
export function useWatchedBeeTab(): string | null {
  const on = useStore((s) => s.panelOpen && s.panelTab === "bees");
  const view = useStore((s) => s.beeView);
  const bee = useShownBee();
  const runs = useBeeRuns((s) => s.runs);
  const tabs = useStore((s) => s.tabs);
  if (!on || !bee || view?.mode === "edit") return null;
  const tabId = runs.find((r) => r.beeId === bee.id && r.status === "running")?.tabId ?? null;
  return tabId && tabs.some((t) => t.id === tabId) ? tabId : null;
}

/** The side panel: what the bees wait on, and the list of bees. */
export function BeePanel() {
  const bees = useStore((s) => s.bees);
  const setBeeView = useStore((s) => s.setBeeView);
  const updateBee = useStore((s) => s.updateBee);
  const load = useBeeRuns((s) => s.load);
  const waiting = useBeeWaiting();
  const runs = useBeeRuns((s) => s.runs);
  const held = useBeeRuns((s) => s.held);
  const queued = useBeeRuns((s) => s.queued);
  const shown = useShownBee();
  const view = useStore((s) => s.beeView);
  const unread = useUnreadRuns();
  useEffect(() => void load(), [load]);
  // A hidden tab is shown through its run, which keeps it open once revealed.
  const openTab = (tabId: string | null) => {
    const run = runs.find((r) => r.tabId === tabId && r.status === "running");
    if (run) setBeeView({ mode: "detail", id: run.beeId });
  };

  return (
    <div className="bee-panel">
      {waiting.permissions.length + waiting.questions.length > 0 && (
        <section className="bee-waiting">
          <h4>Esperando você</h4>
          <ul className="perm-list">
            {waiting.permissions.map((p) => (
              <PermissionCard key={p.id} req={p} onOpen={() => openTab(p.tab_id)} />
            ))}
            {waiting.questions.map((q) => (
              <QuestionCard key={q.id} item={q} onOpen={() => openTab(q.tab_id)} />
            ))}
          </ul>
        </section>
      )}
      <button
        className={`bee-activity-row ${view?.mode === "activity" || view?.mode === "run" ? "on" : ""}`}
        onClick={() => setBeeView({ mode: "activity" })}
      >
        <span>Atividade</span>
        {unread > 0 && <span className="badge">{unread}</span>}
      </button>
      {bees.length === 0 ? (
        <p className="hint">Nenhuma worker bee ainda. Uma worker bee roda uma tarefa do Claude em segundo plano, na hora que você escolher.</p>
      ) : (
        <ul className="bee-list">
          {bees.map((b) => {
            const running = runs.some((r) => r.beeId === b.id && r.status === "running");
            const needsYou = runs.find((r) => r.beeId === b.id)?.attention;
            return (
              <li
                key={b.id}
                className={`bee-row ${shown?.id === b.id ? "on" : ""} ${b.enabled ? "" : "off"}`}
                onClick={() => setBeeView({ mode: "detail", id: b.id })}
              >
                <input
                  type="checkbox"
                  title={b.enabled ? "Desligar" : "Ligar"}
                  checked={b.enabled}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => updateBee(b.id, { enabled: e.target.checked })}
                />
                <span className="bee-row-main">
                  <span className="bee-name">{b.name}</span>
                  <span className="bee-meta">
                    {running
                      ? "rodando agora"
                      : needsYou
                        ? "precisa de você"
                        : queued.some((q) => q.beeId === b.id)
                        ? "na fila"
                        : held[b.id]
                        ? `adiada por cota até ${clock(held[b.id])}`
                        : describeTrigger(b.trigger)}
                  </span>
                </span>
                {running && <span className="bee-run-dot live" />}
                {!running && needsYou && <span className="bee-run-dot attention" />}
              </li>
            );
          })}
        </ul>
      )}
      <BeeQuotaSection />
    </div>
  );
}

const CEILINGS = [50, 60, 70, 80, 90];

/** Usage ceilings above which scheduled runs wait for the window to reset. */
function BeeQuotaSection() {
  const quota = useStore((s) => s.beeQuota);
  const setQuota = useStore((s) => s.setBeeQuota);
  const maxRunning = useStore((s) => s.beeMaxRunning);
  const setMaxRunning = useStore((s) => s.setBeeMaxRunning);
  const field = (key: keyof typeof quota, label: string) => (
    <label className="bee-quota-row">
      <span>{label}</span>
      <select
        className="bee-select"
        value={quota[key] ?? ""}
        onChange={(e) => setQuota({ [key]: e.target.value ? Number(e.target.value) : null })}
      >
        <option value="">Sem limite</option>
        {CEILINGS.map((c) => (
          <option key={c} value={c}>
            Até {c}%
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section className="bee-quota">
      <h4>Limite de uso</h4>
      <p className="hint">
        Acima do limite, uma execução agendada espera a janela renovar. Rodar à mão ignora o limite.
      </p>
      {field("session", "Sessão (5h)")}
      {field("weekly", "Semanal (7d)")}
      <h4 className="bee-quota-sub">Execução</h4>
      <label className="bee-quota-row">
        <span>Ao mesmo tempo</span>
        <select
          className="bee-select"
          value={maxRunning ?? ""}
          onChange={(e) => setMaxRunning(e.target.value ? Number(e.target.value) : null)}
        >
          {[1, 2, 3, 4, 6].map((n) => (
            <option key={n} value={n}>
              {n === 1 ? "1 worker bee" : `${n} worker bees`}
            </option>
          ))}
          <option value="">Sem limite</option>
        </select>
      </label>
    </section>
  );
}

/** The panel header's button for a new bee. */
export function NewBeeButton() {
  const setBeeView = useStore((s) => s.setBeeView);
  return (
    <button className="ghost auto bee-new" onClick={() => setBeeView({ mode: "new" })}>
      + Nova worker bee
    </button>
  );
}

/** The Worker bee in place of the terminals: a bee's details, or its editor. */
export function BeeMain() {
  const view = useStore((s) => s.beeView);
  const setBeeView = useStore((s) => s.setBeeView);
  const bee = useShownBee();
  const watched = useWatchedBeeTab();
  const done = (id?: string) => setBeeView(id ? { mode: "detail", id } : null);
  let body: React.ReactNode;
  if (view?.mode === "new") body = <BeeEditor onDone={done} />;
  else if (view?.mode === "activity") body = <Activity />;
  else if (view?.mode === "run") body = <RunView runId={view.runId} />;
  else if (bee && view?.mode === "edit") body = <BeeEditor key={bee.id} beeId={bee.id} onDone={done} />;
  else if (bee) body = <BeeDetail bee={bee} live={!!watched} />;
  else
    body = (
      <div className="bee-blank">
        <p className="hint">Nenhuma worker bee ainda.</p>
        <button className="primary" onClick={() => setBeeView({ mode: "new" })}>
          + Nova worker bee
        </button>
      </div>
    );
  return <div className={`bee-main ${watched ? "with-live" : ""}`}>{body}</div>;
}

/** Where the live terminal of a run sits, under the details. */
export const LIVE_RECT = { left: "4px", top: "calc(45% + 28px)", width: "calc(100% - 8px)", height: "calc(55% - 32px)" };

function BeeDetail({ bee, live }: { bee: Bee; live: boolean }) {
  const { updateBee, setBeeView } = useStore();
  const all = useBeeRuns((s) => s.runs);
  const runs = all.filter((r) => r.beeId === bee.id);
  const running = runs.find((r) => r.status === "running");
  const queued = useBeeRuns((s) => s.queued.some((q) => q.beeId === bee.id));
  const [asking, setAsking] = useState(false);
  const setQueued = useBeeRuns((s) => s.setQueued);
  const bees = useStore((s) => s.bees);
  const after = bee.trigger.kind === "event" && bee.trigger.event.on === "beeDone" ? bee.trigger.event.beeId : null;
  const before = bees.find((b) => b.id === after);
  const next = bees.filter((b) => b.trigger.kind === "event" && b.trigger.event.on === "beeDone" && b.trigger.event.beeId === bee.id);
  const mode = PERMISSION_MODES.find(([m]) => m === bee.permissionMode)?.[1];
  const [, tick] = useState(0);
  // Keeps the running time current.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [running]);

  return (
    <div className="bee-detail">
      <header className="bee-detail-head">
        <div>
          <h2>{bee.name}</h2>
          <p className="hint">
            {TEMPLATES.find((t) => t.id === bee.templateId)?.name ?? "Sem template"} · {describeTrigger(bee.trigger)}
            {bee.trigger.kind !== "manual" && ` · horário perdido: ${bee.missed === "run" ? "roda ao abrir" : "pula"}`}
          </p>
        </div>
        <label className="check">
          <input type="checkbox" checked={bee.enabled} onChange={(e) => updateBee(bee.id, { enabled: e.target.checked })} />
          {bee.enabled ? "Ligada" : "Desligada"}
        </label>
        <button className="ghost auto" onClick={() => setBeeView({ mode: "edit", id: bee.id })}>
          Editar
        </button>
        {running ? (
          <button className="ghost auto" onClick={() => stopBeeRun(running)}>
            Parar
          </button>
        ) : queued ? (
          <button
            className="ghost auto"
            title="Esperando outras worker bees terminarem"
            onClick={() => setQueued(useBeeRuns.getState().queued.filter((q) => q.beeId !== bee.id))}
          >
            Tirar da fila
          </button>
        ) : (
          <button className="primary" onClick={() => setAsking((v) => !v)}>
            Rodar agora
          </button>
        )}
      </header>
      {asking && !running && !queued && (
        <RunNow
          lastDir={runs.find((r) => r.dir)?.dir ?? ""}
          worktree={!!bee.worktree}
          onRun={(dir) => {
            setAsking(false);
            void runBee(bee, dir);
          }}
          onCancel={() => setAsking(false)}
        />
      )}
      <div className="bee-detail-body">
        <section>
          <h4>Prompt</h4>
          <p className="bee-instructions">{bee.instructions}</p>
        </section>
        <section>
          <h4>Como roda</h4>
          <p className="hint">
            {bee.worktree ? "Numa worktree nova do repositório que receber" : "Direto na pasta que receber"}
            {" · "}
            {mode ? `permissões: ${mode}` : "permissões do app"}
            {bee.allowedTools?.length ? ` · liberado sem perguntar: ${bee.allowedTools.join(", ")}` : ""}
          </p>
        </section>
        {(before || next.length > 0) && (
          <section>
            <h4>Cadeia</h4>
            <ul className="bee-chain">
              {before && (
                <li>
                  Roda depois de{" "}
                  <button className="link" onClick={() => setBeeView({ mode: "detail", id: before.id })}>
                    {before.name}
                  </button>
                </li>
              )}
              {next.map((b) => (
                <li key={b.id}>
                  Ao terminar, dispara{" "}
                  <button className="link" onClick={() => setBeeView({ mode: "detail", id: b.id })}>
                    {b.name}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {bee.state && bee.state !== "null" && (
          <section>
            <h4>
              Guardado entre execuções
              <button className="link bee-state-clear" onClick={() => updateBee(bee.id, { state: null })}>
                limpar
              </button>
            </h4>
            <pre className="bee-state">{prettyState(bee.state)}</pre>
          </section>
        )}
        <section>
          <h4>Execuções</h4>
          {runs.length === 0 && <p className="hint">Ainda não rodou. Use "Rodar agora" para ver como ela se sai.</p>}
          <ul className="bee-runs">
            {runs.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </ul>
        </section>
      </div>
      {live && running && (
        <div className="bee-live-label">
          Ao vivo · rodando há {duration(running.startedAt, Date.now())}
        </div>
      )}
    </div>
  );
}

/** Asks which folder a run started by hand works on; empty runs it in the bees' folder. */
function RunNow({
  lastDir,
  worktree,
  onRun,
  onCancel,
}: {
  lastDir: string;
  worktree: boolean;
  onRun: (dir: string | null) => void;
  onCancel: () => void;
}) {
  const [dir, setDir] = useState(lastDir);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    if (!dir.trim()) return onRun(null);
    const check = await invoke<PathCheck>("path_check", { path: dir.trim() }).catch(() => null);
    if (!check?.exists || !check.is_dir) return setError("Pasta não encontrada.");
    onRun(check.expanded);
  };
  return (
    <div className="bee-run-now">
      <span className="hint">
        Pasta desta execução{worktree ? ", numa worktree nova se for um repositório" : ""}. Vazio roda na pasta das worker bees.
      </span>
      <div className="row">
        <input
          autoFocus
          value={dir}
          placeholder="~/projects/app"
          onChange={(e) => {
            setDir(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void go();
            if (e.key === "Escape") onCancel();
          }}
        />
        <button
          className="ghost auto"
          onClick={async () => {
            const picked = await openDialog({ directory: true, multiple: false, title: "Pasta desta execução" });
            if (typeof picked === "string") setDir(picked);
          }}
        >
          Procurar…
        </button>
        <button className="ghost auto" onClick={onCancel}>
          Cancelar
        </button>
        <button className="primary" onClick={() => void go()}>
          Rodar
        </button>
      </div>
      {error && <span className="hint bee-warn">{error}</span>}
    </div>
  );
}

/** The first line of a run's reply that says what came of it. */
function headline(run: BeeRun): string {
  if (run.attention) return `Precisa de você: ${run.attention}`;
  const text = run.summary?.trim() ?? "";
  const line = text.split("\n").find((l) => /^resultado\s*:/i.test(l.trim())) ?? text.split("\n")[0] ?? "";
  return line.replace(/^resultado\s*:\s*/i, "") || (run.status === "running" ? "Rodando…" : "Sem resumo.");
}

/** Every bee's runs in one list, newest first. */
function Activity() {
  const runs = useBeeRuns((s) => s.runs);
  const bees = useStore((s) => s.bees);
  const setBeeView = useStore((s) => s.setBeeView);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt);
  return (
    <div className="bee-detail">
      <header className="bee-detail-head">
        <div>
          <h2>Atividade</h2>
          <p className="hint">O que as worker bees fizeram, da execução mais nova para a mais antiga.</p>
        </div>
        {sorted.some((r) => r.read === false) && (
          <button className="ghost auto" onClick={() => sorted.forEach(markRunRead)}>
            Marcar tudo como lido
          </button>
        )}
      </header>
      <div className="bee-detail-body">
        {sorted.length === 0 && <p className="hint">Nenhuma execução ainda.</p>}
        <ul className="bee-activity">
          {sorted.map((r) => {
            const bee = bees.find((b) => b.id === r.beeId);
            return (
              <li
                key={r.id}
                className={`bee-activity-item ${r.status} ${r.read === false ? "unread" : ""} ${r.attention ? "attention" : ""}`}
                onClick={() =>
                  setBeeView(r.status === "running" ? { mode: "detail", id: r.beeId } : { mode: "run", runId: r.id })
                }
              >
                <span className="bee-run-dot" />
                <div className="bee-activity-main">
                  <div className="row">
                    <strong>{bee?.name ?? "Worker bee removida"}</strong>
                    <span className="muted">
                      {when(r.startedAt)}
                      {r.endedAt ? ` · ${duration(r.startedAt, r.endedAt)}` : ` · rodando há ${duration(r.startedAt, Date.now())}`}
                      {r.status === "error" && " · com erro"}
                    </span>
                  </div>
                  <span className="bee-activity-line">{headline(r)}</span>
                  {r.dir && <span className="muted bee-activity-dir">{r.dir}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** One ended run: what came of it, and its conversation read only. */
function RunView({ runId }: { runId: string }) {
  const run = useBeeRuns((s) => s.runs.find((r) => r.id === runId));
  const bee = useStore((s) => s.bees.find((b) => b.id === run?.beeId));
  const setBeeView = useStore((s) => s.setBeeView);
  useEffect(() => {
    if (run) markRunRead(run);
  }, [run]);
  if (!run) return <p className="hint bee-blank">Esta execução não está mais no histórico.</p>;
  return (
    <div className="bee-detail bee-run-view">
      <header className="bee-detail-head">
        <button className="ghost auto" onClick={() => setBeeView({ mode: "activity" })} title="Voltar para a atividade">
          ‹
        </button>
        <div>
          <h2>
            {bee ? (
              <button className="link bee-run-title" onClick={() => setBeeView({ mode: "detail", id: bee.id })}>
                {bee.name}
              </button>
            ) : (
              "Worker bee removida"
            )}
          </h2>
          <p className="hint">
            {when(run.startedAt)}
            {run.endedAt && ` · ${duration(run.startedAt, run.endedAt)}`} · {STATUS_LABEL[run.status]}
            {run.dir ? ` · ${run.dir}` : " · pasta das worker bees"}
          </p>
        </div>
        {run.sessionId && (
          <button className="ghost auto" onClick={() => openBeeRun(run)} title="Retoma a sessão numa aba">
            Abrir sessão
          </button>
        )}
      </header>
      {(run.attention || run.summary) && (
        <div className="bee-run-result">
          {run.attention && <p className="bee-run-attention">Precisa de você: {run.attention}</p>}
          {run.summary && <p className="bee-run-summary">{run.summary}</p>}
        </div>
      )}
      {run.transcriptPath ? (
        <TranscriptView path={run.transcriptPath} />
      ) : (
        <p className="hint bee-blank">A conversa desta execução não foi guardada. Use Abrir sessão para ver no terminal.</p>
      )}
    </div>
  );
}

const prettyState = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

function RunRow({ run }: { run: BeeRun }) {
  const setBeeView = useStore((s) => s.setBeeView);
  const canOpen = run.status !== "running" && !!run.sessionId;
  return (
    <li
      className={`bee-run-row ${run.status} clickable ${run.read === false ? "unread" : ""}`}
      onClick={() => run.status !== "running" && setBeeView({ mode: "run", runId: run.id })}
    >
      <div className="row">
        <span className="bee-run-dot" />
        <time>{when(run.startedAt)}</time>
        <span className="bee-run-status">
          {STATUS_LABEL[run.status]}
          {run.endedAt && ` · ${duration(run.startedAt, run.endedAt)}`}
        </span>
        {canOpen && (
          <button
            className="link"
            onClick={(e) => {
              e.stopPropagation();
              openBeeRun(run);
            }}
            title="Retoma a sessão numa aba"
          >
            abrir sessão
          </button>
        )}
      </div>
      {run.attention && <p className="bee-run-attention">Precisa de você: {run.attention}</p>}
      {run.summary && <p className="bee-run-summary">{run.summary}</p>}
    </li>
  );
}

const INTERVALS = [15, 30, 60, 120, 240, 480, 1440];
const WORKDAYS = [1, 2, 3, 4, 5];

type Start = "template" | "free" | "claude";

/** The editor's frame in the center: title, body and the buttons at the bottom. */
function Frame({ title, step, footer, children }: { title: string; step?: string; footer?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bee-form">
      <div className="bee-form-body">
        {step && <p className="hint">{step}</p>}
        <h2>{title}</h2>
        {children}
      </div>
      {footer && <footer className="bee-form-footer">{footer}</footer>}
    </div>
  );
}

/** Creates a bee in steps, or edits the one given; `onDone` gets the bee to show next. */
function BeeEditor({ beeId, onDone }: { beeId?: string; onDone: (id?: string) => void }) {
  const { bees, addBee, updateBee, removeBee } = useStore();
  const editing = bees.find((b) => b.id === beeId);
  const onClose = () => onDone(beeId);
  const [step, setStep] = useState<"start" | "template" | "config">(editing ? "config" : "start");
  const [templateId, setTemplateId] = useState<string | undefined>(editing?.templateId);
  const [name, setName] = useState(editing?.name ?? "");
  const [prompt, setPrompt] = useState(editing?.instructions ?? BLANK_PROMPT);
  const [trigger, setTrigger] = useState<BeeTrigger>(editing?.trigger ?? { kind: "manual" });
  const [missed, setMissed] = useState<Bee["missed"]>(editing?.missed ?? "run");
  const [worktree, setWorktree] = useState(!!editing?.worktree);
  const [permissionMode, setPermissionMode] = useState(editing?.permissionMode ?? "");
  const [allowed, setAllowed] = useState<string[]>(editing?.allowedTools ?? []);

  const unfilled = hasUnfilled(prompt, trigger);
  const follows = trigger.kind === "event" && trigger.event.on === "beeDone";
  const ready =
    name.trim() &&
    prompt.trim() &&
    (trigger.kind !== "schedule" || trigger.days.length > 0) &&
    (trigger.kind !== "event" || trigger.event.on !== "beeDone" || !!trigger.event.beeId);
  const save = () => {
    if (!ready) return;
    const fields = {
      name: name.trim(),
      instructions: prompt.trim(),
      trigger,
      missed,
      templateId,
      worktree,
      permissionMode: permissionMode || null,
      allowedTools: allowed,
    };
    if (editing) return void (updateBee(editing.id, fields), onDone(editing.id));
    const id = crypto.randomUUID();
    addBee({ id, enabled: true, createdAt: Date.now(), lastRunAt: null, ...fields });
    onDone(id);
  };
  const pick = (t: BeeTemplate) => {
    setTemplateId(t.id);
    setName(t.name);
    setTrigger(t.trigger);
    setPrompt(t.prompt);
    setStep("config");
  };

  if (step === "start") {
    const options: Array<{ id: Start; title: string; text: string }> = [
      {
        id: "template",
        title: "Com template",
        text: "Parte de um prompt pronto, como o de review. Você troca as partes marcadas pelo seu conteúdo.",
      },
      { id: "free", title: "Sem template", text: "Você escreve o prompt da worker bee e escolhe quando ela roda." },
      {
        id: "claude",
        title: "Com o Claude",
        text: "Você descreve o que quer numa sessão com o Claude, e ele monta a worker bee para você conferir.",
      },
    ];
    return (
      <Frame
        title="Como você quer começar?"
        step="Nova worker bee · etapa 1"
        footer={
          <button className="ghost auto" onClick={onClose}>
            Cancelar
          </button>
        }
      >
        <div className="bee-starts">
          {options.map((o) => (
            <button
              key={o.id}
              className="bee-start"
              onClick={() => {
                if (o.id === "template") return setStep("template");
                if (o.id === "claude") {
                  onDone();
                  return openBeeCreator();
                }
                setTemplateId(undefined);
                setPrompt(BLANK_PROMPT);
                setStep("config");
              }}
            >
              <strong>{o.title}</strong>
              <span>{o.text}</span>
            </button>
          ))}
        </div>
      </Frame>
    );
  }

  if (step === "template") {
    return (
      <Frame
        title="Escolha o template"
        step="Nova worker bee · etapa 2 de 3"
        footer={
          <button className="ghost auto bee-delete" onClick={() => setStep("start")}>
            Voltar
          </button>
        }
      >
        <div className="bee-starts">
          {TEMPLATES.map((t) => (
            <button key={t.id} className="bee-start" onClick={() => pick(t)}>
              <strong>{t.name}</strong>
              <span>{t.description}</span>
              {t.needs && <em>Precisa de: {t.needs}</em>}
            </button>
          ))}
        </div>
      </Frame>
    );
  }

  const toggleDay = (d: number) =>
    trigger.kind === "schedule" &&
    setTrigger({ ...trigger, days: trigger.days.includes(d) ? trigger.days.filter((x) => x !== d) : [...trigger.days, d] });

  return (
    <Frame
      title={editing ? `Editar ${editing.name}` : "Configure a worker bee"}
      step={
        editing
          ? undefined
          : templateId
            ? `Nova worker bee · etapa 3 de 3 · template ${TEMPLATES.find((t) => t.id === templateId)?.name ?? ""}`
            : "Nova worker bee · etapa 2 de 2"
      }
      footer={
        <>
          {editing ? (
            <button
              className="ghost auto bee-delete"
              onClick={() => {
                removeBee(editing.id);
                onDone();
              }}
            >
              Excluir
            </button>
          ) : (
            <button className="ghost auto bee-delete" onClick={() => setStep(templateId ? "template" : "start")}>
              Voltar
            </button>
          )}
          <button className="ghost auto" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={!ready} onClick={save}>
            {editing ? "Salvar" : "Criar e ligar"}
          </button>
        </>
      }
    >
      <div className="bee-config">
        <div className="bee-config-main">
          <label className="field">
            <span>Nome</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Revisar PRs" autoFocus />
          </label>
          <label className="field bee-config-prompt">
            <span>Prompt da worker bee</span>
            <span className="hint">Substitua os {"{{...}}"} pelo seu próprio conteúdo. A worker bee roda exatamente este texto.</span>
            <textarea className="bee-textarea bee-prompt" spellCheck={false} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            {unfilled && <span className="hint bee-warn">Ainda há partes {"{{...}}"} para substituir.</span>}
            {follows && (
              <span className="hint">
                Escreva {"{{previous}}"} no prompt para receber o resumo da última execução da worker bee anterior.
              </span>
            )}
          </label>
        </div>
        <aside className="bee-config-side">
          <section className="bee-card">
            <h4>Quando roda</h4>
            <div className="chip-row">
              <button className={`chip ${trigger.kind === "manual" ? "on" : ""}`} onClick={() => setTrigger({ kind: "manual" })}>
                Só manual
              </button>
              <button
                className={`chip ${trigger.kind === "interval" ? "on" : ""}`}
                onClick={() => setTrigger({ kind: "interval", minutes: 60 })}
              >
                Intervalo
              </button>
              <button
                className={`chip ${trigger.kind === "schedule" ? "on" : ""}`}
                onClick={() => setTrigger({ kind: "schedule", days: WORKDAYS, time: "09:00" })}
              >
                Dias e horário
              </button>
              <button
                className={`chip ${trigger.kind === "event" ? "on" : ""}`}
                onClick={() => setTrigger({ kind: "event", event: { on: "stop" }, groupId: null, cooldown: 10 })}
              >
                Evento
              </button>
            </div>
            {trigger.kind === "manual" && <p className="hint">Roda só quando você pedir.</p>}
            {trigger.kind === "event" && <EventFields trigger={trigger} selfId={editing?.id} onChange={setTrigger} />}
            {trigger.kind === "interval" && (
              <select
                className="bee-select"
                value={trigger.minutes}
                onChange={(e) => setTrigger({ kind: "interval", minutes: Number(e.target.value) })}
              >
                {INTERVALS.map((m) => (
                  <option key={m} value={m}>
                    {describeTrigger({ kind: "interval", minutes: m })}
                  </option>
                ))}
              </select>
            )}
            {trigger.kind === "schedule" && (
              <div className="chip-row">
                {DAY_NAMES.map((d, i) => (
                  <button key={d} className={`chip ${trigger.days.includes(i) ? "on" : ""}`} onClick={() => toggleDay(i)}>
                    {d}
                  </button>
                ))}
                <input
                  type="time"
                  className="bee-time"
                  value={trigger.time}
                  onChange={(e) => e.target.value && setTrigger({ ...trigger, time: e.target.value })}
                />
              </div>
            )}
            {(trigger.kind === "interval" || trigger.kind === "schedule") && (
              <label className="bee-quota-row">
                <span>Horário perdido com o app fechado</span>
                <select className="bee-select" value={missed} onChange={(e) => setMissed(e.target.value as Bee["missed"])}>
                  <option value="run">Roda ao abrir</option>
                  <option value="skip">Pula</option>
                </select>
              </label>
            )}
          </section>
          <section className="bee-card">
            <h4>Pasta</h4>
            <p className="hint">
              A pasta vem de quem pede: você ao rodar, a sessão que disparou o evento ou a worker bee anterior. Por agenda ou
              intervalo, roda numa pasta vazia, e o prompt diz onde trabalhar.
            </p>
            <label className="check">
              <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
              Num repositório, trabalhar numa worktree nova, sem tocar na cópia de quem pediu
            </label>
          </section>
          <section className="bee-card">
            <h4>Permissões</h4>
            <label className="bee-quota-row">
              <span>Modo</span>
              <select className="bee-select" value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
                <option value="">O do app</option>
                {PERMISSION_MODES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <span className="hint">Liberado sem perguntar. O resto espera você em Esperando você.</span>
            <RuleChips rules={allowed} onChange={setAllowed} />
          </section>
        </aside>
      </div>
    </Frame>
  );
}

/** The permission rules a bee runs with, as removable chips plus a field to add one. */
function RuleChips({ rules, onChange }: { rules: string[]; onChange: (rules: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const rule = draft.trim();
    if (rule && !rules.includes(rule)) onChange([...rules, rule]);
    setDraft("");
  };
  return (
    <div className="bee-rules">
      {rules.map((r) => (
        <span key={r} className="bee-rule">
          {r}
          <button title="Remover" onClick={() => onChange(rules.filter((x) => x !== r))}>
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder="+ regra, ex.: Bash(gh pr:*)"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

type EventTrigger = Extract<BeeTrigger, { kind: "event" }>;

/** A fresh event of each kind, for the event picker. */
const EVENTS: BeeEvent[] = [
  { on: "stop" },
  { on: "sessionEnd" },
  { on: "tool", tool: "Bash", match: null },
  { on: "notification" },
  { on: "subagentStop" },
  { on: "beeDone", beeId: "" },
  { on: "usage", window: "session", percent: 80 },
  { on: "appOpen" },
];

const TOOLS = ["Bash", "Edit", "Write", "Read", "WebFetch", "Agent"];
const COOLDOWNS = [1, 5, 10, 30, 60, 240];
const PERCENTS = [50, 60, 70, 80, 90, 95];

/** Which event starts the bee, its filters, and the least time between runs. */
function EventFields({ trigger, selfId, onChange }: { trigger: EventTrigger; selfId?: string; onChange: (t: BeeTrigger) => void }) {
  // Selectors return the stored arrays; a filtered copy per render would loop.
  const groups = useStore((s) => s.groups).filter((g) => g.id !== BEE_GROUP_ID);
  const bees = useStore((s) => s.bees).filter((b) => b.id !== selfId);
  const e = trigger.event;
  const set = (event: BeeEvent) => onChange({ ...trigger, event });
  const fromSession = ["stop", "sessionEnd", "tool", "notification", "subagentStop"].includes(e.on);

  return (
    <div className="bee-event">
      <select
        className="bee-select"
        value={e.on}
        onChange={(ev) => set(EVENTS.find((x) => x.on === ev.target.value)!)}
      >
        {EVENTS.map((x) => (
          <option key={x.on} value={x.on}>
            {x.on === "tool" ? "Depois de usar uma ferramenta" : x.on === "beeDone" ? "Depois de outra worker bee" : x.on === "usage" ? "Quando o uso passa de um limite" : describeEvent(x)}
          </option>
        ))}
      </select>
      {e.on === "tool" && (
        <div className="bee-event-row">
          <input list="bee-tools" placeholder="Qualquer ferramenta" value={e.tool} onChange={(ev) => set({ ...e, tool: ev.target.value.trim() })} />
          <datalist id="bee-tools">
            {TOOLS.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <input
            placeholder="Contendo o texto (opcional), ex.: git push"
            value={e.match ?? ""}
            onChange={(ev) => set({ ...e, match: ev.target.value || null })}
          />
        </div>
      )}
      {e.on === "beeDone" && (
        <select className="bee-select" value={e.beeId} onChange={(ev) => set({ ...e, beeId: ev.target.value })}>
          <option value="">Escolha a worker bee</option>
          {bees.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      )}
      {e.on === "usage" && (
        <div className="bee-event-row">
          <select className="bee-select" value={e.window} onChange={(ev) => set({ ...e, window: ev.target.value as "session" | "weekly" })}>
            <option value="session">Sessão (5h)</option>
            <option value="weekly">Semanal (7d)</option>
          </select>
          <select className="bee-select" value={e.percent} onChange={(ev) => set({ ...e, percent: Number(ev.target.value) })}>
            {PERCENTS.map((p) => (
              <option key={p} value={p}>
                {p}%
              </option>
            ))}
          </select>
        </div>
      )}
      {fromSession && (
        <label className="bee-quota-row">
          <span>Em abas de</span>
          <select className="bee-select" value={trigger.groupId ?? ""} onChange={(ev) => onChange({ ...trigger, groupId: ev.target.value || null })}>
            <option value="">Qualquer grupo</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="bee-quota-row">
        <span>Intervalo mínimo entre execuções</span>
        <select className="bee-select" value={trigger.cooldown} onChange={(ev) => onChange({ ...trigger, cooldown: Number(ev.target.value) })}>
          {COOLDOWNS.map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} min` : `${m / 60}h`}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">As abas das próprias worker bees nunca disparam eventos.</p>
    </div>
  );
}
