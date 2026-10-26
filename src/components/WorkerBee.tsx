import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../lib/store";
import { DAY_NAMES, describeTrigger, openBeeRun, runBee, setDecision, stopBeeRun, useBeeNotes, useBeeRuns } from "../lib/bees";
import { openBeeCreator } from "../lib/beeCreator";
import { BLANK_PROMPT, COMMON_VARIABLES, REVIEW_VARIABLES, TEMPLATES, reviewPromptOf, type BeeTemplate } from "../lib/beeTemplates";
import { isBeeTab, type Bee, type BeeRun, type BeeTrigger, type ReviewPr } from "../lib/types";
import { PermissionCard, QuestionCard } from "./PermissionQueue";

/** Requests from the bees' hidden tabs: permissions and questions. */
export function useBeeWaiting() {
  const s = useStore();
  const runs = useBeeRuns((r) => r.runs);
  const bee = new Set(s.tabs.filter(isBeeTab).map((t) => t.id));
  return {
    permissions: s.permissions.filter((p) => bee.has(p.tab_id ?? "")),
    questions: s.questions.filter((q) => bee.has(q.tab_id ?? "")),
    // Pull requests a review bee found nothing in, waiting on the user's call.
    clean: runs.flatMap((run) =>
      (run.review?.prs ?? []).filter((pr) => pr.verdict === "clean" && !pr.decision).map((pr) => ({ run, pr })),
    ),
  };
}

/** The user's call on a pull request the review bee found nothing in. */
function CleanCard({ run, pr }: { run: BeeRun; pr: ReviewPr }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await invoke("review_verdict", { repo: pr.repo, number: pr.number, head: pr.head, approve, note: approve ? null : note });
      setDecision(run.id, pr, approve ? "approved" : "changes");
    } catch (err) {
      const text = String(err);
      // A new commit gets its own round; this answer no longer applies.
      if (text.includes("commit novo")) setDecision(run.id, pr, "stale");
      setError(text);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="perm-item bee-clean">
      <div className="perm-head">
        <span className="perm-tool">Por mim está ok</span>
        <span className="muted">
          {pr.repo.split("/")[1]}#{pr.number}
        </span>
      </div>
      <p className="question-text">{pr.title}</p>
      <p className="hint">A abelha não achou nada para apontar. Falta você confirmar.</p>
      {asking && (
        <textarea
          className="bee-textarea"
          rows={3}
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="O que precisa mudar"
        />
      )}
      {error && <p className="error">{error}</p>}
      <div className="perm-actions">
        <button className="ask" onClick={() => void openUrl(pr.url)}>
          Abrir no GitHub
        </button>
        {asking ? (
          <button className="deny" disabled={busy} onClick={() => void decide(false)}>
            Enviar pedido
          </button>
        ) : (
          <button className="deny" disabled={busy} onClick={() => setAsking(true)}>
            Pedir alterações
          </button>
        )}
        <button className="allow" disabled={busy} onClick={() => void decide(true)}>
          Aprovar
        </button>
      </div>
    </li>
  );
}

const STATUS_LABEL: Record<BeeRun["status"], string> = { running: "rodando", done: "concluída", error: "com erro" };

const when = (at: number) =>
  new Date(at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const duration = (from: number, to: number) => {
  const min = Math.max(0, Math.round((to - from) / 60_000));
  return min < 1 ? "menos de 1 min" : min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
};

/** The bee shown in the center: the one picked, else the first. */
function useShownBee() {
  const bees = useStore((s) => s.bees);
  const view = useStore((s) => s.beeView);
  if (view?.mode === "new") return null;
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
  const shown = useShownBee();
  useEffect(() => void load(), [load]);
  // A hidden tab is shown through its run, which keeps it open once revealed.
  const openTab = (tabId: string | null) => {
    const run = runs.find((r) => r.tabId === tabId && r.status === "running");
    if (run) setBeeView({ mode: "detail", id: run.beeId });
  };

  return (
    <div className="bee-panel">
      {waiting.permissions.length + waiting.questions.length + waiting.clean.length > 0 && (
        <section className="bee-waiting">
          <h4>Esperando você</h4>
          <ul className="perm-list">
            {waiting.permissions.map((p) => (
              <PermissionCard key={p.id} req={p} onOpen={() => openTab(p.tab_id)} />
            ))}
            {waiting.questions.map((q) => (
              <QuestionCard key={q.id} item={q} onOpen={() => openTab(q.tab_id)} />
            ))}
            {waiting.clean.map(({ run, pr }) => (
              <CleanCard key={`${run.id}-${pr.repo}-${pr.number}`} run={run} pr={pr} />
            ))}
          </ul>
        </section>
      )}
      {bees.length === 0 ? (
        <p className="hint">Nenhuma abelha ainda. Uma abelha roda uma tarefa do Claude em segundo plano, na hora que você escolher.</p>
      ) : (
        <ul className="bee-list">
          {bees.map((b) => {
            const running = runs.some((r) => r.beeId === b.id && r.status === "running");
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
                  <span className="bee-meta">{running ? "rodando agora" : describeTrigger(b.trigger)}</span>
                </span>
                {running && <span className="bee-run-dot live" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The panel header's button for a new bee. */
export function NewBeeButton() {
  const setBeeView = useStore((s) => s.setBeeView);
  return (
    <button className="ghost auto bee-new" onClick={() => setBeeView({ mode: "new" })}>
      + Nova abelha
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
  else if (bee && view?.mode === "edit") body = <BeeEditor key={bee.id} beeId={bee.id} onDone={done} />;
  else if (bee) body = <BeeDetail bee={bee} live={!!watched} />;
  else
    body = (
      <div className="bee-blank">
        <p className="hint">Nenhuma abelha ainda.</p>
        <button className="primary" onClick={() => setBeeView({ mode: "new" })}>
          + Nova abelha
        </button>
      </div>
    );
  return <div className={`bee-main ${watched ? "with-live" : ""}`}>{body}</div>;
}

/** Where the live terminal of a run sits, under the details. */
export const LIVE_RECT = { left: "4px", top: "calc(45% + 28px)", width: "calc(100% - 8px)", height: "calc(55% - 32px)" };

function BeeDetail({ bee, live }: { bee: Bee; live: boolean }) {
  const { updateBee, setBeeView, repos } = useStore();
  const all = useBeeRuns((s) => s.runs);
  const runs = all.filter((r) => r.beeId === bee.id);
  const running = runs.find((r) => r.status === "running");
  const beeNote = useBeeNotes((n) => n[bee.id]);
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
            {TEMPLATES.find((t) => t.id === (bee.templateId ?? (bee.template === "review" ? "review" : "")))?.name ??
              "Sem template"}{" "}
            · {describeTrigger(bee.trigger)}
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
        ) : (
          <button className="primary" onClick={() => void runBee(bee, { manual: true })}>
            Rodar agora
          </button>
        )}
      </header>
      <div className="bee-detail-body">
        <section className="bee-facts">
          <div>
            <h4>Repositórios</h4>
            {bee.repos.length ? (
              <ul>
                {bee.repos.map((slug) => (
                  <li key={slug}>
                    {slug} <span className="muted">{repos.find((r) => r.slug === slug)?.path ?? "fora da lista"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">Nenhum.</p>
            )}
          </div>
          <div>
            <h4>Prompt</h4>
            <p className="bee-instructions">{bee.template === "review" ? reviewPromptOf(bee) : bee.instructions}</p>
          </div>
        </section>
        {beeNote && !running && <p className="hint">Última busca: {beeNote}</p>}
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
          {running.review && ` · ${running.review.prs.map((p) => `${p.repo.split("/")[1]}#${p.number}`).join(", ")}`}
        </div>
      )}
    </div>
  );
}

function RunRow({ run }: { run: BeeRun }) {
  const canOpen = run.status !== "running" && !!run.sessionId;
  return (
    <li className={`bee-run-row ${run.status}`}>
      <div className="row">
        <span className="bee-run-dot" />
        <time>{when(run.startedAt)}</time>
        <span className="bee-run-status">
          {STATUS_LABEL[run.status]}
          {run.endedAt && ` · ${duration(run.startedAt, run.endedAt)}`}
        </span>
        {canOpen && (
          <button className="link" onClick={() => openBeeRun(run)} title="Retoma a sessão numa aba">
            abrir sessão
          </button>
        )}
      </div>
      {run.review && (
        <ul className="bee-run-prs">
          {run.review.prs.map((p) => (
            <li key={`${p.repo}#${p.number}`}>
              <button className="link" onClick={() => void openUrl(p.url)}>
                {p.repo.split("/")[1]}#{p.number}
              </button>{" "}
              {p.title}
            </li>
          ))}
        </ul>
      )}
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
  const onClose = () => onDone(beeId);
  const { bees, repos, addBee, updateBee, removeBee } = useStore();
  const editing = bees.find((b) => b.id === beeId);
  const [step, setStep] = useState<"start" | "template" | "config">(editing ? "config" : "start");
  const [template, setTemplate] = useState<Bee["template"]>(editing?.template ?? "free");
  const [templateId, setTemplateId] = useState<string | undefined>(editing?.templateId);
  const [name, setName] = useState(editing?.name ?? "");
  // The whole prompt is the bee's, templates included; an old review bee shows the one it runs with.
  const [instructions, setInstructions] = useState(
    editing ? (editing.template === "review" ? reviewPromptOf(editing) : editing.instructions) : BLANK_PROMPT,
  );
  const [picked, setPicked] = useState<string[]>(editing?.repos ?? []);
  const [filter, setFilter] = useState("");
  const [trigger, setTrigger] = useState<BeeTrigger>(editing?.trigger ?? { kind: "manual" });
  const [missed, setMissed] = useState<Bee["missed"]>(editing?.missed ?? "run");

  const review = template === "review";
  // A review run fills these in; without them it has nowhere to put its findings.
  const missing = review ? REVIEW_VARIABLES.filter((v) => !instructions.includes(v)) : [];
  const unfilled = /\[[^\]\n]{3,}\]/.test(instructions);
  const ready =
    name.trim() &&
    instructions.trim() &&
    missing.length === 0 &&
    (!review || picked.length > 0) &&
    (trigger.kind !== "schedule" || trigger.days.length > 0);
  const save = () => {
    if (!ready) return;
    const fields = { name: name.trim(), instructions: instructions.trim(), repos: picked, trigger, missed, templateId };
    if (editing) return void (updateBee(editing.id, fields), onDone(editing.id));
    const id = crypto.randomUUID();
    addBee({ id, template, enabled: true, createdAt: Date.now(), lastRunAt: null, ...fields });
    onDone(id);
  };
  const pick = (t: BeeTemplate) => {
    setTemplate(t.kind);
    setTemplateId(t.id);
    setName(t.name);
    setTrigger(t.trigger);
    setInstructions(t.prompt);
    setStep("config");
  };

  if (step === "start") {
    const options: Array<{ id: Start; title: string; text: string }> = [
      {
        id: "template",
        title: "Com template",
        text: "Parte de uma abelha pronta, como a de review. Você ajusta as instruções e os repositórios.",
      },
      { id: "free", title: "Sem template", text: "Você escreve o prompt da abelha e escolhe os repositórios e quando ela roda." },
      {
        id: "claude",
        title: "Com o Claude",
        text: "Você descreve o que quer numa sessão com o Claude, e ele monta a abelha para você conferir.",
      },
    ];
    return (
      <Frame
        title="Como você quer começar?"
        step="Nova abelha · etapa 1"
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
                setTemplate("free");
                setTemplateId(undefined);
                setInstructions(BLANK_PROMPT);
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
        step="Nova abelha · etapa 2 de 3"
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

  const shownRepos = repos.filter((r) => !filter || r.slug.toLowerCase().includes(filter.toLowerCase()));
  const toggleRepo = (slug: string) =>
    setPicked((p) => (p.includes(slug) ? p.filter((s) => s !== slug) : [...p, slug]));
  const toggleDay = (d: number) =>
    trigger.kind === "schedule" &&
    setTrigger({ ...trigger, days: trigger.days.includes(d) ? trigger.days.filter((x) => x !== d) : [...trigger.days, d] });

  return (
    <Frame
      title={editing ? `Editar ${editing.name}` : "Configure a abelha"}
      step={
        editing
          ? undefined
          : templateId
            ? `Nova abelha · etapa 3 de 3 · template ${TEMPLATES.find((t) => t.id === templateId)?.name ?? ""}`
            : "Nova abelha · etapa 2 de 2"
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
      <label className="field">
        <span>Nome</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Limpar worktrees" autoFocus />
      </label>
      <label className="field">
        <span>Prompt da abelha</span>
        <textarea
          className="bee-textarea bee-prompt"
          rows={18}
          spellCheck={false}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
        <span className="hint">
          Troque as partes entre [colchetes]. O app preenche a cada execução:{" "}
          {[...COMMON_VARIABLES, ...(review ? REVIEW_VARIABLES : [])].join(", ")}.
        </span>
        {unfilled && <span className="hint bee-warn">Ainda há partes entre [colchetes] para trocar.</span>}
        {missing.length > 0 && <span className="error">O prompt da abelha de review precisa de {missing.join(", ")}.</span>}
      </label>
      <div className="field">
        <span>Repositórios {picked.length > 0 && `· ${picked.length} escolhido(s)`}</span>
        {repos.length === 0 ? (
          <p className="hint">Nenhum repositório na lista. Veja em Configurações › Repositórios.</p>
        ) : (
          <>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar" />
            <ul className="bee-repos">
              {shownRepos.map((r) => (
                <li key={r.slug}>
                  <label>
                    <input type="checkbox" checked={picked.includes(r.slug)} onChange={() => toggleRepo(r.slug)} />
                    <span>{r.slug}</span>
                    <span className="muted">{r.path}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="field">
        <span>Quando roda</span>
        <div className="chip-row">
          <button className={`chip ${trigger.kind === "manual" ? "on" : ""}`} onClick={() => setTrigger({ kind: "manual" })}>
            Só manual
          </button>
          <button
            className={`chip ${trigger.kind === "interval" ? "on" : ""}`}
            onClick={() => setTrigger({ kind: "interval", minutes: 60 })}
          >
            A cada intervalo
          </button>
          <button
            className={`chip ${trigger.kind === "schedule" ? "on" : ""}`}
            onClick={() => setTrigger({ kind: "schedule", days: WORKDAYS, time: "09:00" })}
          >
            Dias e horário
          </button>
        </div>
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
      </div>
      {trigger.kind !== "manual" && (
        <div className="field">
          <span>Horário perdido com o app fechado</span>
          <div className="chip-row">
            <button className={`chip ${missed === "run" ? "on" : ""}`} onClick={() => setMissed("run")}>
              Rodar uma vez ao abrir
            </button>
            <button className={`chip ${missed === "skip" ? "on" : ""}`} onClick={() => setMissed("skip")}>
              Pular
            </button>
          </div>
        </div>
      )}
    </Frame>
  );
}
