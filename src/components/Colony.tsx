import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useStore } from "../lib/store";
import { AGENT_NAMES, droneTab, removeColony, wakeDrone } from "../lib/colony";
import { CLAUDE_MODELS } from "../lib/providers";
import { STATE_LABEL, type Colony, type ColonyMessage, type Drone, type DroneAgent, type PathCheck } from "../lib/types";

/** Where a drone's chat or terminal sits, under the drone's header. */
export const COLONY_RECT = { left: "4px", top: "52px", width: "calc(100% - 8px)", height: "calc(100% - 56px)" };

/** The colony on screen and what of it: a drone's id or its messages. */
function useShown(): { colony: Colony | null; show: string | null } {
  const view = useStore((s) => s.colonyView);
  const colonies = useStore((s) => s.colonies);
  const drones = useStore((s) => s.drones);
  if (view && "mode" in view) return { colony: null, show: null };
  const colony = colonies.find((c) => c.id === view?.colonyId) ?? colonies[0] ?? null;
  if (!colony) return { colony: null, show: null };
  const queen = drones.find((d) => d.colonyId === colony.id && d.queen);
  const show = view && view.colonyId === colony.id ? view.show : (queen?.id ?? null);
  return { colony, show };
}

/** The tab of the drone on the Colony screen, shown live in the center. */
export function useWatchedDroneTab(): string | null {
  const on = useStore((s) => s.panelOpen && s.panelTab === "colony");
  useStore((s) => s.tabs);
  const { show } = useShown();
  if (!on || !show || show === "messages") return null;
  const tab = droneTab(show);
  return tab && tab.state !== "dormant" ? tab.id : null;
}

const ordered = (drones: Drone[]) => [...drones].sort((a, b) => Number(b.queen) - Number(a.queen) || a.createdAt - b.createdAt);

function stateOf(drone: Drone): string {
  const tab = droneTab(drone.id);
  return tab ? tab.state : "dormant";
}

/** The side panel: the colonies, each with its drones and messages. */
export function ColonyPanel() {
  const colonies = useStore((s) => s.colonies);
  const drones = useStore((s) => s.drones);
  const messages = useStore((s) => s.colonyMessages);
  const setView = useStore((s) => s.setColonyView);
  useStore((s) => s.tabs);
  const { colony: current, show } = useShown();

  if (colonies.length === 0) {
    return (
      <p className="hint">
        Nenhuma colony ainda. Uma colony é uma equipe de agentes: você conversa com a Queen, ela cria os drones e distribui o
        trabalho entre eles.
      </p>
    );
  }
  return (
    <ul className="colony-list">
      {colonies.map((c) => {
        const open = current?.id === c.id;
        const pending = messages.filter((m) => m.colonyId === c.id && (m.status === "queued" || m.status === "delivered")).length;
        return (
          <li key={c.id} className={`colony-item ${open ? "open" : ""}`}>
            <button className="colony-name" onClick={() => setView({ colonyId: c.id, show: ordered(drones.filter((d) => d.colonyId === c.id))[0]?.id ?? "messages" })}>
              <span className="colony-caret">{open ? "▾" : "▸"}</span>
              {c.name}
            </button>
            {open && (
              <ul className="drone-list">
                {ordered(drones.filter((d) => d.colonyId === c.id)).map((d) => (
                  <li key={d.id}>
                    <button className={`drone-row ${show === d.id ? "on" : ""}`} onClick={() => setView({ colonyId: c.id, show: d.id })}>
                      <span className={`dot state-${stateOf(d)}`} />
                      <span className="drone-main">
                        <span className="drone-name">
                          {d.name}
                          {d.queen && <span className="drone-queen">Queen</span>}
                        </span>
                        <span className="drone-role">{d.role || AGENT_NAMES[d.agent]}</span>
                      </span>
                    </button>
                  </li>
                ))}
                <li>
                  <button className={`drone-row ${show === "messages" ? "on" : ""}`} onClick={() => setView({ colonyId: c.id, show: "messages" })}>
                    <span className="drone-main">
                      <span className="drone-name">Mensagens</span>
                    </span>
                    {pending > 0 && <span className="badge">{pending}</span>}
                  </button>
                </li>
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The panel header's button for a new colony. */
export function NewColonyButton() {
  const setView = useStore((s) => s.setColonyView);
  return (
    <button className="ghost auto bee-new" onClick={() => setView({ mode: "new" })}>
      + Nova colony
    </button>
  );
}

/** The Colony screen in place of the terminals. */
export function ColonyMain() {
  const view = useStore((s) => s.colonyView);
  const setView = useStore((s) => s.setColonyView);
  const drones = useStore((s) => s.drones);
  const { colony, show } = useShown();
  let body: React.ReactNode;
  if (view && "mode" in view) body = <NewColony />;
  else if (!colony)
    body = (
      <div className="bee-blank">
        <p className="hint">Nenhuma colony ainda.</p>
        <button className="primary" onClick={() => setView({ mode: "new" })}>
          + Nova colony
        </button>
      </div>
    );
  else if (show === "messages") body = <Messages colony={colony} />;
  else {
    const drone = drones.find((d) => d.id === show);
    body = drone ? <DroneHead key={drone.id} colony={colony} drone={drone} /> : <Messages colony={colony} />;
  }
  return <div className="bee-main colony-main">{body}</div>;
}

/** A drone's header over its chat; opens the drone's session when it is not running. */
function DroneHead({ colony, drone }: { colony: Colony; drone: Drone }) {
  const tabs = useStore((s) => s.tabs);
  const removeDrone = useStore((s) => s.removeDrone);
  const setView = useStore((s) => s.setColonyView);
  const [confirm, setConfirm] = useState(false);
  const tab = droneTab(drone.id);
  const running = !!tab && tab.state !== "dormant";
  useEffect(() => {
    if (!running) void wakeDrone(drone);
    // Wakes once per drone shown; a session that ends stays down until shown again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drone.id]);
  void tabs;
  return (
    <header className="drone-head">
      <div>
        <h2>
          {drone.name}
          {drone.queen && <span className="drone-queen">Queen</span>}
        </h2>
        <p className="hint">
          {drone.queen ? colony.goal || colony.name : drone.role} · {AGENT_NAMES[drone.agent]}
          {drone.model ? ` · ${drone.model}` : ""} · {running ? STATE_LABEL[tab!.state] : "abrindo…"}
        </p>
      </div>
      {drone.queen ? (
        <button
          className={`ghost auto ${confirm ? "danger" : ""}`}
          onClick={() => (confirm ? removeColony(colony.id) : setConfirm(true))}
          onBlur={() => setConfirm(false)}
          title="Fecha as sessões dos drones e apaga a colony"
        >
          {confirm ? "Confirmar exclusão" : "Excluir colony"}
        </button>
      ) : (
        <button
          className={`ghost auto ${confirm ? "danger" : ""}`}
          onClick={() => {
            if (!confirm) return setConfirm(true);
            if (tab) useStore.getState().closeTab(tab.id);
            removeDrone(drone.id);
            setView({ colonyId: colony.id, show: "messages" });
          }}
          onBlur={() => setConfirm(false)}
        >
          {confirm ? "Confirmar remoção" : "Remover drone"}
        </button>
      )}
    </header>
  );
}

const STATUS: Record<ColonyMessage["status"], string> = {
  queued: "na fila",
  delivered: "trabalhando",
  answered: "respondida",
  failed: "falhou",
};

const when = (at: number) => new Date(at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** The colony's messages between drones, newest first. */
function Messages({ colony }: { colony: Colony }) {
  const all = useStore((s) => s.colonyMessages);
  const drones = useStore((s) => s.drones);
  const [open, setOpen] = useState<string | null>(null);
  const name = (id: string) => (id === "user" ? "Você" : (drones.find((d) => d.id === id)?.name ?? "removido"));
  const list = all.filter((m) => m.colonyId === colony.id).reverse();
  return (
    <div className="bee-detail">
      <header className="bee-detail-head">
        <div>
          <h2>Mensagens · {colony.name}</h2>
          <p className="hint">Os pedidos entre os drones e as respostas que voltaram, do mais novo para o mais antigo.</p>
        </div>
      </header>
      <div className="bee-detail-body">
        {list.length === 0 && <p className="hint">Nenhuma mensagem ainda. Peça algo à Queen e ela distribui entre os drones.</p>}
        <ul className="colony-messages">
          {list.map((m) => (
            <li key={m.id} className={`colony-message ${m.status}`} onClick={() => setOpen(open === m.id ? null : m.id)}>
              <div className="row">
                <strong>
                  {name(m.from)} → {name(m.to)}
                </strong>
                {m.replyTo && <span className="muted">resposta</span>}
                <span className="muted">
                  {when(m.createdAt)} · {STATUS[m.status]}
                </span>
              </div>
              <p className={open === m.id ? "full" : ""}>{m.text}</p>
              {open === m.id && m.reply && !m.replyTo && (
                <p className="colony-reply full">
                  <span className="muted">Resposta: </span>
                  {m.reply}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const AGENTS: DroneAgent[] = ["claude", "codex", "opencode"];

/** Creates a colony and its Queen, then opens the Queen's chat. */
function NewColony() {
  const addColony = useStore((s) => s.addColony);
  const setView = useStore((s) => s.setColonyView);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [cwd, setCwd] = useState("");
  const [agent, setAgent] = useState<DroneAgent>("claude");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    let folder: string | null = null;
    if (cwd.trim()) {
      const check = await invoke<PathCheck>("path_check", { path: cwd.trim() }).catch(() => null);
      if (!check?.exists || !check.is_dir) return setError("Pasta não encontrada.");
      folder = check.expanded;
    }
    const colony: Colony = { id: crypto.randomUUID(), name: name.trim(), goal: goal.trim(), cwd: folder, createdAt: Date.now() };
    const queen: Drone = {
      id: crypto.randomUUID(),
      colonyId: colony.id,
      queen: true,
      name: "Queen",
      role: "Monta a equipe e distribui o trabalho",
      description: "Conversa com o usuário, cria os drones e junta os resultados.",
      instructions: "",
      agent,
      model: model.trim() || null,
      permissionMode: null,
      allowedTools: [],
      sessionId: null,
      createdAt: Date.now(),
    };
    addColony(colony, queen);
  };

  return (
    <div className="bee-form">
      <div className="bee-form-body">
        <p className="hint">Nova colony</p>
        <h2>Monte uma equipe de agentes</h2>
        <p className="hint">
          Você conversa com a Queen. Ela propõe os drones (função, agente, modelo, permissões), cria depois que você confirmar e
          distribui o trabalho entre eles.
        </p>
        <label className="field">
          <span>Nome</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Shellhive" autoFocus />
        </label>
        <label className="field">
          <span>Objetivo</span>
          <textarea className="bee-textarea" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Manter o Shellhive: revisar PRs, corrigir bugs e lançar versões." />
        </label>
        <div className="field">
          <span>Pasta</span>
          <span className="hint">Onde os drones trabalham. Vazio usa uma pasta vazia do app.</span>
          <div className="row">
            <input
              value={cwd}
              placeholder="~/projects/app"
              onChange={(e) => {
                setCwd(e.target.value);
                setError(null);
              }}
            />
            <button
              className="ghost auto"
              onClick={async () => {
                const picked = await openDialog({ directory: true, multiple: false, title: "Pasta da colony" });
                if (typeof picked === "string") setCwd(picked);
              }}
            >
              Procurar…
            </button>
          </div>
          {error && <span className="hint bee-warn">{error}</span>}
        </div>
        <div className="field">
          <span>Agente da Queen</span>
          <div className="chip-row">
            {AGENTS.map((a) => (
              <button
                key={a}
                className={`chip ${agent === a ? "on" : ""}`}
                onClick={() => {
                  setAgent(a);
                  setModel("");
                }}
              >
                {AGENT_NAMES[a]}
              </button>
            ))}
          </div>
          {agent === "claude" ? (
            <select className="bee-select" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Modelo padrão</option>
              {CLAUDE_MODELS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          ) : (
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Modelo (vazio usa o padrão)" />
          )}
        </div>
      </div>
      <footer className="bee-form-footer">
        <button className="ghost auto" onClick={() => setView(null)}>
          Cancelar
        </button>
        <button className="primary" disabled={!name.trim()} onClick={() => void create()}>
          Criar e falar com a Queen
        </button>
      </footer>
    </div>
  );
}
