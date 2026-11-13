import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useStore } from "../lib/store";
import { AGENT_NAMES, droneTab, removeColony, wakeDrone } from "../lib/colony";
import { CLAUDE_MODELS } from "../lib/providers";
import { STATE_LABEL, type Colony, type ColonyMessage, type Drone, type DroneAgent, type PathCheck } from "../lib/types";
import { BeeAvatar } from "./BeeAvatar";
import { Modal } from "./Modal";
import { PERMISSION_MODES } from "./Dialogs";

/** Where a drone's chat sits: the whole of the Colony screen. */
export const COLONY_RECT = { left: "4px", top: "4px", width: "calc(100% - 8px)", height: "calc(100% - 8px)" };

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

const stateOf = (drone: Drone) => droneTab(drone.id)?.state ?? "dormant";

type Menu = { x: number; y: number } & ({ colonyId: string } | { droneId: string });
type Editing = { colonyId: string } | { droneId: string } | null;

/** The side panel: the colonies, each opened or closed, with their drones. */
export function ColonyPanel() {
  const colonies = useStore((s) => s.colonies);
  const drones = useStore((s) => s.drones);
  const openColonies = useStore((s) => s.openColonies);
  const toggle = useStore((s) => s.toggleColony);
  const setView = useStore((s) => s.setColonyView);
  useStore((s) => s.tabs);
  const { colony: current, show } = useShown();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [editing, setEditing] = useState<Editing>(null);

  if (colonies.length === 0) {
    return (
      <p className="hint">
        Nenhuma colony ainda. Uma colony é uma equipe de agentes: você conversa com a Queen Bee, ela cria os drones e distribui o
        trabalho entre eles.
      </p>
    );
  }
  const at = (e: React.MouseEvent) => {
    e.preventDefault();
    return { x: e.clientX, y: e.clientY };
  };
  return (
    <>
      <ul className="colony-list">
        {colonies.map((c) => {
          const open = openColonies.includes(c.id);
          const members = ordered(drones.filter((d) => d.colonyId === c.id));
          return (
            <li key={c.id} className={`colony-item ${current?.id === c.id ? "current" : ""}`}>
              <div className="colony-head" onContextMenu={(e) => setMenu({ ...at(e), colonyId: c.id })}>
                <button className="colony-caret" onClick={() => toggle(c.id)} title={open ? "Fechar" : "Abrir"} aria-expanded={open}>
                  {open ? "▾" : "▸"}
                </button>
                <button
                  className="colony-name"
                  onClick={() => {
                    toggle(c.id, true);
                    setView({ colonyId: c.id, show: members[0]?.id ?? "messages" });
                  }}
                >
                  {c.name}
                </button>
                <MessagesButton colony={c} />
              </div>
              {open && (
                <ul className="drone-list">
                  {members.map((d) => (
                    <li key={d.id}>
                      <button
                        className={`drone-row ${current?.id === c.id && show === d.id ? "on" : ""}`}
                        onClick={() => setView({ colonyId: c.id, show: d.id })}
                        onContextMenu={(e) => setMenu({ ...at(e), droneId: d.id })}
                      >
                        <BeeAvatar seed={d.id} queen={d.queen} size={32} state={stateOf(d)} />
                        <span className="drone-main">
                          <span className="drone-name">
                            {d.name}
                            {d.queen && <span className="drone-queen">Queen Bee</span>}
                          </span>
                          <span className="drone-role">{d.queen ? "Monta a equipe e distribui o trabalho" : d.role || AGENT_NAMES[d.agent]}</span>
                        </span>
                        <span className={`dot state-${stateOf(d)}`} title={STATE_LABEL[stateOf(d)]} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {menu && <ColonyMenu menu={menu} onClose={() => setMenu(null)} onEdit={setEditing} />}
      {editing && "colonyId" in editing && <EditColony colonyId={editing.colonyId} onClose={() => setEditing(null)} />}
      {editing && "droneId" in editing && <EditDrone droneId={editing.droneId} onClose={() => setEditing(null)} />}
    </>
  );
}

const STATUS: Record<ColonyMessage["status"], string> = {
  queued: "na fila",
  delivered: "trabalhando",
  answered: "respondida",
  failed: "falhou",
};

/** Beside a colony's name: the messages in flight, the latest in a dropdown, and the full list. */
function MessagesButton({ colony }: { colony: Colony }) {
  const all = useStore((s) => s.colonyMessages);
  const drones = useStore((s) => s.drones);
  const setView = useStore((s) => s.setColonyView);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const mine = all.filter((m) => m.colonyId === colony.id);
  const pending = mine.filter((m) => m.status === "queued" || m.status === "delivered").length;
  const name = (id: string) => (id === "user" ? "Você" : (drones.find((d) => d.id === id)?.name ?? "removido"));
  return (
    <div className="colony-mail" ref={ref}>
      <button className={`colony-mail-btn ${pending ? "busy" : ""}`} title="Mensagens entre os drones" onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden>
          <path d="M4 6h16v12H4z" />
          <path d="M4 7l8 6 8-6" />
        </svg>
        {pending > 0 && <span>{pending}</span>}
      </button>
      {open && (
        <div className="colony-mail-menu">
          {mine.length === 0 && <p className="hint">Nenhuma mensagem ainda.</p>}
          {mine
            .slice(-8)
            .reverse()
            .map((m) => (
              <div key={m.id} className={`colony-mail-item ${m.status}`}>
                <strong>
                  {name(m.from)} → {name(m.to)}
                </strong>
                <span className="muted">{m.replyTo ? "resposta" : STATUS[m.status]}</span>
              </div>
            ))}
          <button
            className="link"
            onClick={() => {
              setOpen(false);
              setView({ colonyId: colony.id, show: "messages" });
            }}
          >
            Ver todas
          </button>
        </div>
      )}
    </div>
  );
}

/** The right-click menu of a colony or of a drone. */
function ColonyMenu({ menu, onClose, onEdit }: { menu: Menu; onClose: () => void; onEdit: (e: Editing) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drones = useStore((s) => s.drones);
  const removeDrone = useStore((s) => s.removeDrone);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const drone = "droneId" in menu ? drones.find((d) => d.id === menu.droneId) : undefined;
  const style = { left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 120) };
  const edit = () => {
    onEdit("colonyId" in menu ? { colonyId: menu.colonyId } : { droneId: menu.droneId });
    onClose();
  };
  return (
    <div ref={ref} className="group-menu" style={style}>
      <button className="menu-item" onClick={edit}>
        {"colonyId" in menu ? "Editar colony…" : "Editar drone…"}
      </button>
      {"colonyId" in menu ? (
        <button
          className={`menu-item danger ${confirm ? "confirming" : ""}`}
          onClick={() => (confirm ? (removeColony(menu.colonyId), onClose()) : setConfirm(true))}
        >
          {confirm ? "Confirmar: apagar a colony" : "Excluir colony"}
        </button>
      ) : (
        drone &&
        !drone.queen && (
          <button
            className={`menu-item danger ${confirm ? "confirming" : ""}`}
            onClick={() => {
              if (!confirm) return setConfirm(true);
              const tab = droneTab(drone.id);
              if (tab) useStore.getState().closeTab(tab.id);
              removeDrone(drone.id);
              onClose();
            }}
          >
            {confirm ? "Confirmar remoção" : "Remover drone"}
          </button>
        )
      )}
    </div>
  );
}

/** Checks a folder typed or picked; null for none, a message when it does not exist. */
async function checkFolder(raw: string): Promise<string | null | { error: string }> {
  if (!raw.trim()) return null;
  const check = await invoke<PathCheck>("path_check", { path: raw.trim() }).catch(() => null);
  return check?.exists && check.is_dir ? check.expanded : { error: "Pasta não encontrada." };
}

function FolderField({ value, onChange, error }: { value: string; onChange: (v: string) => void; error: string | null }) {
  return (
    <div className="field">
      <span>Pasta</span>
      <span className="hint">Onde os drones trabalham. Vazio usa uma pasta vazia do app.</span>
      <div className="row">
        <input value={value} placeholder="~/projects/app" onChange={(e) => onChange(e.target.value)} />
        <button
          className="ghost auto"
          onClick={async () => {
            const picked = await openDialog({ directory: true, multiple: false, title: "Pasta da colony" });
            if (typeof picked === "string") onChange(picked);
          }}
        >
          Procurar…
        </button>
      </div>
      {error && <span className="hint bee-warn">{error}</span>}
    </div>
  );
}

function EditColony({ colonyId, onClose }: { colonyId: string; onClose: () => void }) {
  const colony = useStore((s) => s.colonies.find((c) => c.id === colonyId));
  const updateColony = useStore((s) => s.updateColony);
  const [name, setName] = useState(colony?.name ?? "");
  const [goal, setGoal] = useState(colony?.goal ?? "");
  const [cwd, setCwd] = useState(colony?.cwd ?? "");
  const [error, setError] = useState<string | null>(null);
  if (!colony) return null;
  const save = async () => {
    const folder = await checkFolder(cwd);
    if (folder && typeof folder === "object") return setError(folder.error);
    updateColony(colony.id, { name: name.trim() || colony.name, goal: goal.trim(), cwd: folder });
    onClose();
  };
  return (
    <Modal
      title="Editar colony"
      onClose={onClose}
      footer={
        <>
          <button className="ghost auto" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary" onClick={() => void save()}>
            Salvar
          </button>
        </>
      }
    >
      <label className="field">
        <span>Nome</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span>Objetivo</span>
        <textarea className="bee-textarea" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} />
      </label>
      <FolderField value={cwd} onChange={(v) => (setCwd(v), setError(null))} error={error} />
      <p className="hint">A pasta nova vale para as sessões abertas daqui em diante.</p>
    </Modal>
  );
}

const AGENTS: DroneAgent[] = ["claude", "codex", "opencode"];

function ModelField({ agent, value, onChange }: { agent: DroneAgent; value: string; onChange: (v: string) => void }) {
  return agent === "claude" ? (
    <select className="bee-select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Modelo padrão</option>
      {CLAUDE_MODELS.map(([id, label]) => (
        <option key={id} value={id}>
          {label}
        </option>
      ))}
    </select>
  ) : (
    <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Modelo (vazio usa o padrão)" />
  );
}

function EditDrone({ droneId, onClose }: { droneId: string; onClose: () => void }) {
  const drone = useStore((s) => s.drones.find((d) => d.id === droneId));
  const updateDrone = useStore((s) => s.updateDrone);
  const [name, setName] = useState(drone?.name ?? "");
  const [role, setRole] = useState(drone?.role ?? "");
  const [description, setDescription] = useState(drone?.description ?? "");
  const [instructions, setInstructions] = useState(drone?.instructions ?? "");
  const [agent, setAgent] = useState<DroneAgent>(drone?.agent ?? "claude");
  const [model, setModel] = useState(drone?.model ?? "");
  const [mode, setMode] = useState(drone?.permissionMode ?? "");
  if (!drone) return null;
  const save = () => {
    const agentChanged = agent !== drone.agent;
    const restart = agentChanged || (model.trim() || null) !== drone.model;
    updateDrone(drone.id, {
      name: name.trim() || drone.name,
      role: role.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
      agent,
      model: model.trim() || null,
      permissionMode: mode || null,
      // Another agent cannot resume the old session.
      ...(agentChanged ? { sessionId: null } : {}),
    });
    const tab = droneTab(drone.id);
    if (tab && restart) useStore.getState().closeTab(tab.id);
    else if (tab) useStore.getState().patchTab(tab.id, { title: name.trim() || drone.name });
    onClose();
  };
  return (
    <Modal
      title={drone.queen ? "Editar a Queen Bee" : "Editar drone"}
      onClose={onClose}
      footer={
        <>
          <button className="ghost auto" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary" onClick={save}>
            Salvar
          </button>
        </>
      }
    >
      <label className="field">
        <span>Nome</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      {!drone.queen && (
        <>
          <label className="field">
            <span>Função</span>
            <input value={role} onChange={(e) => setRole(e.target.value)} />
          </label>
          <label className="field">
            <span>Descrição</span>
            <textarea className="bee-textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </>
      )}
      <label className="field">
        <span>Instruções</span>
        <textarea className="bee-textarea" rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </label>
      <div className="field">
        <span>Agente e modelo</span>
        <div className="chip-row">
          {AGENTS.map((a) => (
            <button key={a} className={`chip ${agent === a ? "on" : ""}`} onClick={() => (setAgent(a), setModel(""))}>
              {AGENT_NAMES[a]}
            </button>
          ))}
        </div>
        <ModelField agent={agent} value={model} onChange={setModel} />
      </div>
      {agent === "claude" && (
        <label className="field">
          <span>Permissões</span>
          <select className="bee-select" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">As do app</option>
            {PERMISSION_MODES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="hint">Mudar agente ou modelo reabre a sessão do drone. As instruções novas valem para a próxima sessão.</p>
    </Modal>
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

/** The Colony screen in place of the terminals; a drone's chat covers it once its session runs. */
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
    body = drone ? <DroneWaking key={drone.id} drone={drone} /> : <Messages colony={colony} />;
  }
  return <div className="bee-main colony-main">{body}</div>;
}

/** Opens the shown drone's session; its chat then covers this. */
function DroneWaking({ drone }: { drone: Drone }) {
  useEffect(() => {
    void wakeDrone(drone);
    // Wakes once per drone shown; a session that ends stays down until shown again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drone.id]);
  return (
    <div className="bee-blank">
      <BeeAvatar seed={drone.id} queen={drone.queen} size={64} state="working" />
      <p className="hint">Abrindo {drone.name}…</p>
    </div>
  );
}

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
        {list.length === 0 && <p className="hint">Nenhuma mensagem ainda. Peça algo à Queen Bee e ela distribui entre os drones.</p>}
        <ul className="colony-messages">
          {list.map((m) => (
            <li key={m.id} className={`colony-message ${m.status}`} onClick={() => setOpen(open === m.id ? null : m.id)}>
              <div className="row">
                <BeeAvatar seed={m.from} queen={drones.find((d) => d.id === m.from)?.queen} size={24} />
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

/** Creates a colony and its Queen Bee, then opens her chat. */
function NewColony() {
  const addColony = useStore((s) => s.addColony);
  const setView = useStore((s) => s.setColonyView);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [cwd, setCwd] = useState("");
  const [queenName, setQueenName] = useState("");
  const [agent, setAgent] = useState<DroneAgent>("claude");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    const folder = await checkFolder(cwd);
    if (folder && typeof folder === "object") return setError(folder.error);
    const colony: Colony = { id: crypto.randomUUID(), name: name.trim(), goal: goal.trim(), cwd: folder, createdAt: Date.now() };
    const queen: Drone = {
      id: crypto.randomUUID(),
      colonyId: colony.id,
      queen: true,
      name: queenName.trim() || "Queen",
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
          Você conversa com a Queen Bee. Ela propõe os drones (função, agente, modelo, permissões), cria depois que você confirmar e
          distribui o trabalho entre eles.
        </p>
        <label className="field">
          <span>Nome</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Shellhive" autoFocus />
        </label>
        <label className="field">
          <span>Objetivo</span>
          <textarea
            className="bee-textarea"
            rows={3}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Manter o Shellhive: revisar PRs, corrigir bugs e lançar versões."
          />
        </label>
        <FolderField value={cwd} onChange={(v) => (setCwd(v), setError(null))} error={error} />
        <div className="field">
          <span>Queen Bee</span>
          <input value={queenName} onChange={(e) => setQueenName(e.target.value)} placeholder="Nome (vazio fica Queen)" />
          <div className="chip-row">
            {AGENTS.map((a) => (
              <button key={a} className={`chip ${agent === a ? "on" : ""}`} onClick={() => (setAgent(a), setModel(""))}>
                {AGENT_NAMES[a]}
              </button>
            ))}
          </div>
          <ModelField agent={agent} value={model} onChange={setModel} />
        </div>
      </div>
      <footer className="bee-form-footer">
        <button className="ghost auto" onClick={() => setView(null)}>
          Cancelar
        </button>
        <button className="primary" disabled={!name.trim()} onClick={() => void create()}>
          Criar e falar com a Queen Bee
        </button>
      </footer>
    </div>
  );
}
