import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import { DAY_NAMES, describeTrigger, openBeeRun, runBee, useBeeRuns } from "../lib/bees";
import { isBeeTab, type Bee, type BeeRun, type BeeTrigger } from "../lib/types";
import { Modal } from "./Modal";
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

/** The bees, what they wait on, and their recent runs. */
export function BeePanel() {
  const bees = useStore((s) => s.bees);
  const openModal = useStore((s) => s.openModal);
  const load = useBeeRuns((s) => s.load);
  const waiting = useBeeWaiting();
  const runs = useBeeRuns((s) => s.runs);
  useEffect(() => void load(), [load]);
  // A hidden tab is shown through its run, which keeps it open once revealed.
  const openTab = (tabId: string | null) => {
    const run = runs.find((r) => r.tabId === tabId && r.status === "running");
    if (run) openBeeRun(run);
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
      {bees.length === 0 ? (
        <div className="bee-empty">
          <p className="hint">Nenhuma abelha ainda. Uma abelha roda uma tarefa do Claude em segundo plano, na hora que você escolher.</p>
          <button className="ghost" onClick={() => openModal({ kind: "bee" })}>
            + Nova abelha
          </button>
        </div>
      ) : (
        <ul className="bee-list">
          {bees.map((b) => (
            <BeeCard key={b.id} bee={b} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The panel header's button for a new bee. */
export function NewBeeButton() {
  const openModal = useStore((s) => s.openModal);
  return (
    <button className="ghost auto bee-new" onClick={() => openModal({ kind: "bee" })}>
      + Nova abelha
    </button>
  );
}

function BeeCard({ bee }: { bee: Bee }) {
  const { updateBee, openModal } = useStore();
  const all = useBeeRuns((s) => s.runs);
  const runs = all.filter((r) => r.beeId === bee.id).slice(0, 5);
  const running = runs.some((r) => r.status === "running");

  return (
    <li className={`bee-card ${bee.enabled ? "" : "off"}`}>
      <div className="bee-head">
        <label className="bee-toggle" title={bee.enabled ? "Desligar" : "Ligar"}>
          <input type="checkbox" checked={bee.enabled} onChange={(e) => updateBee(bee.id, { enabled: e.target.checked })} />
        </label>
        <span className="bee-name">{bee.name}</span>
        <button className="link" onClick={() => openModal({ kind: "bee", beeId: bee.id })}>
          Editar
        </button>
      </div>
      <div className="bee-meta">
        {describeTrigger(bee.trigger)}
        {bee.repos.length > 0 && ` · ${bee.repos.length === 1 ? bee.repos[0] : `${bee.repos.length} repositórios`}`}
      </div>
      <button className="ghost bee-run" disabled={running} onClick={() => void runBee(bee)}>
        {running ? "Rodando…" : "Rodar agora"}
      </button>
      {runs.length > 0 && (
        <ul className="bee-runs">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </ul>
      )}
    </li>
  );
}

function RunRow({ run }: { run: BeeRun }) {
  const [open, setOpen] = useState(false);
  const canOpen = !!run.tabId || !!run.sessionId;
  return (
    <li className={`bee-run-row ${run.status}`}>
      <div className="row">
        <span className="bee-run-dot" />
        <time>{when(run.startedAt)}</time>
        <span className="bee-run-status">{STATUS_LABEL[run.status]}</span>
        {canOpen && (
          <button className="link" onClick={() => openBeeRun(run)} title="Abre a sessão numa aba">
            abrir
          </button>
        )}
      </div>
      {run.summary && (
        <p className={`bee-run-summary ${open ? "open" : ""}`} onClick={() => setOpen((o) => !o)} title={open ? undefined : "Clique para ver tudo"}>
          {run.summary}
        </p>
      )}
    </li>
  );
}

const INTERVALS = [15, 30, 60, 120, 240, 480, 1440];
const WORKDAYS = [1, 2, 3, 4, 5];

type Start = "template" | "free" | "claude";

/** Creates a bee in steps, or edits the one given. */
export function BeeDialog({ beeId, onClose }: { beeId?: string; onClose: () => void }) {
  const { bees, repos, addBee, updateBee, removeBee } = useStore();
  const editing = bees.find((b) => b.id === beeId);
  const [step, setStep] = useState<"start" | "config">(editing ? "config" : "start");
  const [name, setName] = useState(editing?.name ?? "");
  const [instructions, setInstructions] = useState(editing?.instructions ?? "");
  const [picked, setPicked] = useState<string[]>(editing?.repos ?? []);
  const [filter, setFilter] = useState("");
  const [trigger, setTrigger] = useState<BeeTrigger>(editing?.trigger ?? { kind: "manual" });
  const [missed, setMissed] = useState<Bee["missed"]>(editing?.missed ?? "run");

  const ready = name.trim() && instructions.trim() && (trigger.kind !== "schedule" || trigger.days.length > 0);
  const save = () => {
    if (!ready) return;
    const fields = { name: name.trim(), instructions: instructions.trim(), repos: picked, trigger, missed };
    if (editing) updateBee(editing.id, fields);
    else
      addBee({
        id: crypto.randomUUID(),
        template: "free",
        enabled: true,
        createdAt: Date.now(),
        lastRunAt: null,
        ...fields,
      });
    onClose();
  };

  if (step === "start") {
    const options: Array<{ id: Start; title: string; text: string; soon?: string }> = [
      {
        id: "template",
        title: "Com template",
        text: "Parte de uma abelha pronta, como a de review. Você ajusta as instruções e os repositórios.",
        soon: "A abelha de review chega na próxima beta.",
      },
      { id: "free", title: "Sem template", text: "Você escreve o prompt da abelha e escolhe os repositórios e quando ela roda." },
      {
        id: "claude",
        title: "Com o Claude",
        text: "Você descreve o que quer numa sessão com o Claude, e ele monta a abelha para você conferir.",
        soon: "Chega numa próxima beta.",
      },
    ];
    return (
      <Modal title="Nova abelha" onClose={onClose}>
        <p className="hint">Etapa 1 · Como você quer começar?</p>
        <div className="bee-starts">
          {options.map((o) => (
            <button key={o.id} className="bee-start" disabled={!!o.soon} onClick={() => setStep("config")} title={o.soon}>
              <strong>{o.title}</strong>
              <span>{o.text}</span>
              {o.soon && <em>{o.soon}</em>}
            </button>
          ))}
        </div>
      </Modal>
    );
  }

  const shownRepos = repos.filter((r) => !filter || r.slug.toLowerCase().includes(filter.toLowerCase()));
  const toggleRepo = (slug: string) =>
    setPicked((p) => (p.includes(slug) ? p.filter((s) => s !== slug) : [...p, slug]));
  const toggleDay = (d: number) =>
    trigger.kind === "schedule" &&
    setTrigger({ ...trigger, days: trigger.days.includes(d) ? trigger.days.filter((x) => x !== d) : [...trigger.days, d] });

  return (
    <Modal
      title={editing ? `Abelha ${editing.name}` : "Nova abelha"}
      onClose={onClose}
      footer={
        <>
          {editing ? (
            <button
              className="ghost auto bee-delete"
              onClick={() => {
                removeBee(editing.id);
                onClose();
              }}
            >
              Excluir
            </button>
          ) : (
            <button className="ghost auto bee-delete" onClick={() => setStep("start")}>
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
      {!editing && <p className="hint">Etapa 2 · Configurar</p>}
      <label className="field">
        <span>Nome</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Limpar worktrees" autoFocus />
      </label>
      <label className="field">
        <span>Prompt da abelha</span>
        <textarea
          className="bee-textarea"
          rows={5}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="O que o Claude deve fazer a cada execução, por exemplo: apague as worktrees de branches já mergeadas."
        />
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
    </Modal>
  );
}
