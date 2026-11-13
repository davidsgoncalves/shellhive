import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { describeTrigger, DAY_NAMES, openBeeRun, useBeeRuns } from "../lib/bees";
import {
  answerApproval,
  cancelFlowRun,
  nextRunAt,
  runFlowNow,
  runNodeAlone,
  useFlowRuns,
} from "../lib/flows";
import {
  ADDABLE,
  blankNode,
  edgePath,
  hasInput,
  inputPoint,
  KIND_GLYPH,
  KIND_LABEL,
  makeNode,
  makesLoop,
  NODE_GAP,
  NODE_W,
  portLabel,
  portPoint,
  portsOf,
  PORT_STEP,
  PORT_Y,
} from "../lib/flowGraph";
import { CLAUDE_MODELS } from "../lib/providers";
import { AGENT_NAMES } from "../lib/colony";
import { PERMISSION_MODES } from "./Dialogs";
import { EventFields, INTERVALS, WORKDAYS, type EventTrigger } from "./WorkerBee";
import { BeeAvatar } from "./BeeAvatar";
import type {
  DroneAgent,
  Flow,
  FlowEdge,
  FlowNode,
  FlowNodeData,
  FlowNodeKind,
  FlowNodeState,
  FlowPort,
  FlowRun,
  FlowTrigger,
} from "../lib/types";

const when = (at: number) =>
  new Date(at).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

const elapsed = (from: number, to: number) => {
  const s = Math.max(0, Math.round((to - from) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
};

/** The flow on screen: the one picked, else the first that is not an open wait. */
function useShownFlow(): Flow | null {
  const flows = useStore((s) => s.flows);
  const view = useStore((s) => s.flowView);
  return flows.find((f) => f.id === view?.flowId) ?? flows.find((f) => !f.wait) ?? null;
}

function triggerLine(flow: Flow): string {
  const t = flow.nodes.find((n) => n.kind === "trigger");
  return t && t.kind === "trigger" ? describeTrigger(t.trigger) : "Sem gatilho";
}

export function NewFlowButton() {
  const addFlow = useStore((s) => s.addFlow);
  const setFlowView = useStore((s) => s.setFlowView);
  return (
    <button
      className="ghost auto bee-new"
      onClick={() => {
        const trigger = makeNode(blankNode("trigger"), 60, 80);
        const flow: Flow = {
          id: crypto.randomUUID(),
          name: "Novo fluxo",
          enabled: true,
          nodes: [trigger],
          edges: [],
          createdAt: Date.now(),
          lastRunAt: null,
        };
        addFlow(flow);
        setFlowView({ flowId: flow.id });
      }}
    >
      + Novo fluxo
    </button>
  );
}

/** The side panel: the flows, and the waits sessions opened. */
export function FlowsPanel() {
  const flows = useStore((s) => s.flows);
  const setFlowView = useStore((s) => s.setFlowView);
  const updateFlow = useStore((s) => s.updateFlow);
  const removeFlow = useStore((s) => s.removeFlow);
  const runs = useFlowRuns((s) => s.runs);
  const held = useFlowRuns((s) => s.held);
  const load = useFlowRuns((s) => s.load);
  const shown = useShownFlow();
  useEffect(() => void load(), [load]);
  const own = flows.filter((f) => !f.wait);
  const waits = flows.filter((f) => f.wait);
  const dot = (f: Flow) => {
    const last = runs.find((r) => r.flowId === f.id);
    if (last?.status === "running") return Object.values(last.states).some((s) => s.status === "waiting") ? "p" : "w";
    if (!f.enabled) return "sl";
    return last?.status === "error" ? "err" : "ok";
  };
  const meta = (f: Flow) => {
    const last = runs.find((r) => r.flowId === f.id);
    if (last?.status === "running") {
      return Object.values(last.states).some((s) => s.status === "waiting") ? "esperando você" : "rodando agora";
    }
    if (held[f.id]) return `adiado por cota até ${when(held[f.id])}`;
    return f.enabled ? triggerLine(f) : `${triggerLine(f)} · desligado`;
  };

  return (
    <div className="flow-panel">
      {own.length === 0 ? (
        <p className="hint">
          Nenhum fluxo ainda. Um fluxo liga um gatilho a instruções, agentes e worker bees, e roda sozinho quando o gatilho
          dispara.
        </p>
      ) : (
        <ul className="flow-list">
          {own.map((f) => (
            <li key={f.id} className={`flow-row ${shown?.id === f.id ? "on" : ""}`} onClick={() => setFlowView({ flowId: f.id })}>
              <span className={`flow-dot ${dot(f)}`} />
              <span className="flow-row-main">
                <span className="flow-name">{f.name}</span>
                <span className="flow-meta">{meta(f)}</span>
              </span>
              <input
                type="checkbox"
                title={f.enabled ? "Desligar" : "Ligar"}
                checked={f.enabled}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => updateFlow(f.id, { enabled: e.target.checked })}
              />
            </li>
          ))}
        </ul>
      )}
      {waits.length > 0 && (
        <>
          <h4 className="flow-sub">Esperas abertas</h4>
          <ul className="flow-list">
            {waits.map((f) => (
              <li key={f.id} className={`flow-row ${shown?.id === f.id ? "on" : ""}`} onClick={() => setFlowView({ flowId: f.id })}>
                <span className="flow-dot p" />
                <span className="flow-row-main">
                  <span className="flow-name">{f.name}</span>
                  <span className="flow-meta">para {f.wait!.title}</span>
                </span>
                <button
                  className="icon-btn"
                  title="Cancelar a espera"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFlow(f.id);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Fluxos in place of the terminals: a flow's canvas, or one of its runs. */
export function FlowsMain() {
  const flow = useShownFlow();
  const view = useStore((s) => s.flowView);
  const runs = useFlowRuns((s) => s.runs);
  if (!flow) {
    return (
      <div className="bee-main flow-main">
        <div className="bee-blank">
          <p className="hint">Nenhum fluxo ainda.</p>
          <NewFlowButton />
        </div>
      </div>
    );
  }
  const run = view?.runId ? runs.find((r) => r.id === view.runId) : undefined;
  return (
    <div className="bee-main flow-main">{run ? <RunScreen flow={flow} run={run} /> : view?.runId === "" ? <RunScreen flow={flow} /> : <Editor key={flow.id} flow={flow} />}</div>
  );
}

function Editor({ flow }: { flow: Flow }) {
  const updateFlow = useStore((s) => s.updateFlow);
  const removeFlow = useStore((s) => s.removeFlow);
  const setFlowView = useStore((s) => s.setFlowView);
  const running = useFlowRuns((s) => s.runs.some((r) => r.flowId === flow.id && r.status === "running"));
  const canvas = useRef<CanvasApi | null>(null);

  return (
    <div className="flow-editor">
      <header className="flow-head">
        <input className="flow-title" value={flow.name} onChange={(e) => updateFlow(flow.id, { name: e.target.value })} />
        <span className="hint">
          {flow.nodes.length} {flow.nodes.length === 1 ? "nó" : "nós"}
          {flow.lastRunAt ? ` · última execução ${when(flow.lastRunAt)}` : ""}
        </span>
        <span className="grow" />
        {!flow.wait && (
          <label className="check flow-on">
            <input type="checkbox" checked={flow.enabled} onChange={(e) => updateFlow(flow.id, { enabled: e.target.checked })} />
            {flow.enabled ? "Ativo" : "Desligado"}
          </label>
        )}
        <button className="ghost auto" onClick={() => setFlowView({ flowId: flow.id, runId: "" })}>
          Execuções
        </button>
        <button
          className="ghost auto bee-delete"
          onClick={() => {
            if (window.confirm(`Excluir o fluxo ${flow.name}?`)) removeFlow(flow.id);
          }}
        >
          Excluir
        </button>
        <button className="primary" disabled={running} onClick={() => runFlowNow(flow)} title={running ? "Já está rodando" : undefined}>
          {running ? "Rodando…" : "Rodar agora"}
        </button>
      </header>
      <Canvas flow={flow} apiRef={canvas} onChange={(patch) => updateFlow(flow.id, patch)} />
    </div>
  );
}

interface CanvasApi {
  addAtView: (kind: FlowNodeKind) => void;
}

type Selection = { node: string } | { edge: string } | null;

/** A link being dragged out of an exit, in canvas coordinates. */
interface Linking {
  from: string;
  port: FlowPort;
  x: number;
  y: number;
}

/** The menu that opens when a link is dropped on empty canvas. */
interface DropMenu {
  /** The exit the new node links to; none for a menu opened on empty canvas. */
  from?: string;
  port?: FlowPort;
  x: number;
  y: number;
}

/**
 * The canvas: nodes as cards wired left to right. Read only with `run`, where
 * each card shows how its node went.
 */
function Canvas({
  flow,
  run,
  apiRef,
  onChange,
}: {
  flow: { nodes: FlowNode[]; edges: FlowEdge[] };
  run?: FlowRun;
  apiRef?: React.MutableRefObject<CanvasApi | null>;
  onChange?: (patch: Partial<Flow>) => void;
}) {
  const readOnly = !onChange;
  const box = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<Selection>(null);
  const [linking, setLinking] = useState<Linking | null>(null);
  const [menu, setMenu] = useState<DropMenu | null>(null);
  const wheel = useRef(0);
  // A zoom step glides; panning and dragging follow the pointer at once.
  const [gliding, setGliding] = useState(false);
  const glideTimer = useRef<number | undefined>(undefined);
  const glide = () => {
    setGliding(true);
    window.clearTimeout(glideTimer.current);
    glideTimer.current = window.setTimeout(() => setGliding(false), 200);
  };
  const lastStep = useRef(0);
  const drag = useRef<{ kind: "pan" | "node"; id?: string; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const { nodes, edges } = flow;

  const toCanvas = (clientX: number, clientY: number) => {
    const r = box.current!.getBoundingClientRect();
    return { x: (clientX - r.left - pan.x) / zoom, y: (clientY - r.top - pan.y) / zoom };
  };

  const setNodes = (next: FlowNode[], nextEdges = edges) => onChange?.({ nodes: next, edges: nextEdges });
  const patchNode = (id: string, patch: Partial<FlowNodeData> & { x?: number; y?: number; locked?: boolean }) =>
    setNodes(nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as FlowNode) : n)));

  const addNode = (kind: FlowNodeKind, x: number, y: number, link?: { from: string; port: FlowPort }) => {
    const node = makeNode(blankNode(kind), Math.round(x), Math.round(y));
    const nextEdges = link ? [...edges, { id: crypto.randomUUID(), from: link.from, port: link.port, to: node.id }] : edges;
    setNodes([...nodes, node], nextEdges);
    setSelected({ node: node.id });
  };

  if (apiRef) {
    apiRef.current = {
      addAtView: (kind) => {
        const r = box.current?.getBoundingClientRect();
        if (!r) return;
        // To the right of the selected node, or in the middle of the view.
        const sel = selected && "node" in selected ? nodes.find((n) => n.id === selected.node) : undefined;
        if (sel) {
          const port = portsOf(sel.kind)[0];
          return addNode(kind, sel.x + NODE_W + NODE_GAP, sel.y, port && hasInput(kind) ? { from: sel.id, port } : undefined);
        }
        const at = toCanvas(r.left + r.width / 2 - (NODE_W * zoom) / 2, r.top + r.height / 3);
        addNode(kind, at.x, at.y);
      },
    };
  }

  const remove = (sel: Selection) => {
    if (!sel || readOnly) return;
    if ("edge" in sel) return onChange!({ edges: edges.filter((e) => e.id !== sel.edge) });
    const node = nodes.find((n) => n.id === sel.node);
    // The trigger is what makes a flow run; it stays.
    if (!node || node.kind === "trigger") return;
    setNodes(
      nodes.filter((n) => n.id !== sel.node),
      edges.filter((e) => e.from !== sel.node && e.to !== sel.node),
    );
    setSelected(null);
  };

  const duplicate = (id: string) => {
    const node = nodes.find((n) => n.id === id);
    if (!node || node.kind === "trigger") return;
    const copy = { ...node, id: crypto.randomUUID(), x: node.x + 40, y: node.y + 40, locked: false };
    setNodes([...nodes, copy]);
    setSelected({ node: copy.id });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Delete" || e.key === "Backspace") remove(selected);
      if (e.key === "Escape") {
        setSelected(null);
        setMenu(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (e.button !== 0) return;
    if (target.closest("input, textarea, select, button, a, .flow-port, .flow-toolbar, .flow-menu")) return;
    setMenu(null);
    const card = target.closest<HTMLElement>("[data-node]");
    if (card) {
      const id = card.dataset.node!;
      setSelected({ node: id });
      const node = nodes.find((n) => n.id === id);
      if (readOnly || !node || node.locked) return;
      drag.current = { kind: "node", id, sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y };
    } else {
      if (!target.closest(".flow-edge")) setSelected(null);
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y };
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (linking) {
      const p = toCanvas(e.clientX, e.clientY);
      return setLinking({ ...linking, x: p.x, y: p.y });
    }
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.kind === "pan") setPan({ x: d.ox + dx, y: d.oy + dy });
    else if (d.id) patchNode(d.id, { x: Math.round(d.ox + dx / zoom), y: Math.round(d.oy + dy / zoom) });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    if (!linking) return;
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const id = under?.closest<HTMLElement>("[data-node]")?.dataset.node;
    const target = nodes.find((n) => n.id === id);
    const from = linking;
    setLinking(null);
    if (target) {
      if (!hasInput(target.kind) || makesLoop(edges, from.from, target.id)) return;
      if (edges.some((x) => x.from === from.from && x.port === from.port && x.to === target.id)) return;
      onChange?.({ edges: [...edges, { id: crypto.randomUUID(), from: from.from, port: from.port, to: target.id }] });
      return;
    }
    const p = toCanvas(e.clientX, e.clientY);
    setMenu({ from: from.from, port: from.port, x: p.x, y: p.y });
  };

  const onWheel = (e: React.WheelEvent) => {
    if ((e.target as HTMLElement).closest("textarea, .flow-output")) return;
    // Alt (or a pinch, which arrives as Ctrl) zooms in steps of 20%, one per stroke of the wheel.
    if (e.altKey || e.ctrlKey || e.metaKey) {
      wheel.current += e.deltaY;
      const now = Date.now();
      if (Math.abs(wheel.current) < 40 || now - lastStep.current < 160) return;
      const next = stepZoom(zoom, wheel.current < 0 ? 1 : -1);
      wheel.current = 0;
      lastStep.current = now;
      if (next === zoom) return;
      const r = box.current!.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      glide();
      setPan({ x: cx - ((cx - pan.x) * next) / zoom, y: cy - ((cy - pan.y) * next) / zoom });
      setZoom(next);
    } else {
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    }
  };

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const lit = (e: FlowEdge) => {
    if (!run) return "";
    const st = run.states[e.from];
    if (st?.status !== "done") return "dim";
    return e.port === "out" || st.port === e.port ? "lit" : "dim";
  };
  const selNode = selected && "node" in selected ? byId.get(selected.node) : undefined;
  // Zoomed out, the dots space out in steps instead of crowding together.
  let grid = 20 * zoom;
  while (grid < 18) grid *= 2;

  return (
    <div
      ref={box}
      className={`flow-canvas ${readOnly ? "readonly" : ""}`}
      style={{ backgroundPosition: `${pan.x}px ${pan.y}px`, backgroundSize: `${grid}px ${grid}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      onContextMenu={(e) => {
        e.preventDefault();
        if (readOnly || (e.target as HTMLElement).closest("[data-node], .flow-menu, .flow-toolbar")) return;
        const p = toCanvas(e.clientX, e.clientY);
        setMenu({ x: p.x, y: p.y });
      }}
    >
      <div className={`flow-layer ${gliding ? "gliding" : ""}`} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
        <svg className="flow-edges">
          {edges.map((e) => {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (!a || !b) return null;
            const d = edgePath(portPoint(a, e.port), inputPoint(b));
            const on = selected && "edge" in selected && selected.edge === e.id;
            return (
              <g key={e.id} className={`flow-edge ${on ? "on" : ""} ${lit(e)}`} onPointerDown={() => !readOnly && setSelected({ edge: e.id })}>
                <path className="hit" d={d} />
                <path className="line" d={d} />
              </g>
            );
          })}
          {linking &&
            (() => {
              const a = byId.get(linking.from);
              return a ? <path className="flow-linking" d={edgePath(portPoint(a, linking.port), { x: linking.x, y: linking.y })} /> : null;
            })()}
        </svg>
        {nodes.map((n) => (
          <NodeCard
            key={n.id}
            node={n}
            owner={readOnly ? undefined : (flow as Flow)}
            selected={selNode?.id === n.id}
            state={run?.states[n.id]}
            run={run}
            readOnly={readOnly}
            onPatch={(patch) => patchNode(n.id, patch)}
            onStartLink={(port, e) => {
              if (readOnly) return;
              e.stopPropagation();
              const p = toCanvas(e.clientX, e.clientY);
              setLinking({ from: n.id, port, x: p.x, y: p.y });
              box.current?.setPointerCapture(e.pointerId);
            }}
          />
        ))}
        {selNode && !readOnly && (
          <div className="flow-toolbar" style={{ left: selNode.x + NODE_W / 2, top: selNode.y - 64 }}>
            <button title="Duplicar" disabled={selNode.kind === "trigger"} onClick={() => duplicate(selNode.id)}>
              ⧉
            </button>
            <span className="sep" />
            <button title={selNode.locked ? "Destravar" : "Travar no lugar"} onClick={() => patchNode(selNode.id, { locked: !selNode.locked })}>
              {selNode.locked ? "🔒" : "🔓"}
            </button>
            <button title="Excluir" disabled={selNode.kind === "trigger"} onClick={() => remove({ node: selNode.id })}>
              🗑
            </button>
          </div>
        )}
        {menu && (
          <div className="flow-menu" style={{ left: menu.x, top: menu.y }}>
            <div className="flow-menu-title">{menu.from ? "Ligar a" : "Adicionar"}</div>
            {ADDABLE.map((k) => (
              <button
                key={k}
                onClick={() => {
                  addNode(k, menu.x, menu.y - PORT_Y, menu.from && menu.port ? { from: menu.from, port: menu.port } : undefined);
                  setMenu(null);
                }}
              >
                <span className="flow-glyph">{KIND_GLYPH[k]}</span>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        )}
      </div>
      {!readOnly && nodes.length < 3 && (
        <div className="flow-tip">Clique com o botão direito no fundo para adicionar um nó, ou arraste da bolinha de saída.</div>
      )}
      <div className="flow-zoom">
        <button onClick={() => (glide(), setZoom((z) => stepZoom(z, -1)))}>−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => (glide(), setZoom((z) => stepZoom(z, 1)))}>+</button>
        <button
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
          title="Voltar ao início"
        >
          ⌂
        </button>
      </div>
    </div>
  );
}

/** Zoom goes from 40% to 160%, 20% at a time. */
function stepZoom(zoom: number, dir: 1 | -1): number {
  const pct = Math.round((zoom * 100) / 20) * 20 + dir * 20;
  return Math.min(160, Math.max(40, pct)) / 100;
}

const STATUS_TEXT: Record<FlowNodeState["status"], string> = {
  pending: "",
  running: "rodando",
  waiting: "esperando você",
  done: "✓",
  skipped: "não seguido",
  error: "erro",
};

function NodeCard({
  node,
  owner,
  selected,
  state,
  run,
  readOnly,
  onPatch,
  onStartLink,
}: {
  node: FlowNode;
  owner?: Flow;
  selected: boolean;
  state?: FlowNodeState;
  run?: FlowRun;
  readOnly: boolean;
  onPatch: (patch: Partial<FlowNodeData> & { locked?: boolean }) => void;
  onStartLink: (port: FlowPort, e: React.PointerEvent) => void;
}) {
  const ports = portsOf(node.kind);
  const status = state?.status;
  const timing =
    state?.status === "done" && state.startedAt && state.endedAt && state.endedAt - state.startedAt > 1500
      ? ` ${elapsed(state.startedAt, state.endedAt)}`
      : "";
  return (
    <div
      data-node={node.id}
      className={`flow-node kind-${node.kind} ${selected ? "sel" : ""} ${status ? `st-${status}` : ""}`}
      style={{ left: node.x, top: node.y, width: NODE_W }}
    >
      <div className="flow-node-label">
        <span className="flow-glyph">{KIND_GLYPH[node.kind]}</span>
        {KIND_LABEL[node.kind]}
        {node.locked && <span className="hint"> · travado</span>}
        {status && status !== "pending" && (
          <span className={`flow-node-status ${status}`}>
            {STATUS_TEXT[status]}
            {node.kind !== "approval" && state?.port && state.port !== "out" ? ` · ${portLabel(node.kind, state.port)}` : ""}
            {timing}
          </span>
        )}
      </div>
      <div className="flow-card">
        {run ? <RunBody node={node} state={state} run={run} /> : <NodeFields node={node} flow={owner} onPatch={onPatch} />}
      </div>
      {hasInput(node.kind) && <span className="flow-port in" style={{ top: PORT_Y }} />}
      {ports.map((p, i) => (
        <span
          key={p}
          className={`flow-port out ${readOnly ? "" : "live"}`}
          style={{ top: PORT_Y + i * PORT_STEP }}
          onPointerDown={(e) => onStartLink(p, e)}
          title={readOnly ? undefined : "Arraste para ligar"}
        >
          {portLabel(node.kind, p) && <em>{portLabel(node.kind, p)}</em>}
        </span>
      ))}
    </div>
  );
}

/** What a node did in a run: its result, or the buttons when it waits for the user. */
function RunBody({ node, state, run }: { node: FlowNode; state?: FlowNodeState; run: FlowRun }) {
  const beeRun = useBeeRuns((s) => (state?.runId ? s.runs.find((r) => r.id === state.runId) : s.runs.find((r) => r.flowRunId === run.id && r.nodeId === node.id)));
  if (!state || state.status === "pending") return <p className="hint">Ainda não chegou aqui.</p>;
  if (state.status === "skipped") return <p className="hint">Nenhuma saída levou a este nó.</p>;
  if (state.status === "waiting" && node.kind === "approval") {
    return (
      <div className="flow-fields">
        <p className="flow-q">{node.question || "Seguir com o fluxo?"}</p>
        <div className="flow-row-btns">
          <button className="ghost auto" onClick={() => answerApproval(run.id, node.id, false)}>
            Recusar
          </button>
          <button className="primary" onClick={() => answerApproval(run.id, node.id, true)}>
            Aprovar
          </button>
        </div>
      </div>
    );
  }
  if (state.status === "running") {
    return (
      <div className="flow-fields">
        <p className="hint">Rodando desde {new Date(state.startedAt ?? run.startedAt).toLocaleTimeString()}.</p>
        {beeRun && (
          <button className="ghost auto" onClick={() => openBeeRun(beeRun)}>
            Acompanhar
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="flow-fields">
      {node.kind === "trigger" && !state.output ? <p className="hint">Disparado.</p> : <pre className={`flow-output ${state.status}`}>{state.output || "Sem texto."}</pre>}
      {beeRun?.sessionId && (
        <button className="ghost auto" onClick={() => openBeeRun(beeRun)}>
          Abrir a conversa
        </button>
      )}
    </div>
  );
}

function NodeFields({ node, flow, onPatch }: { node: FlowNode; flow?: Flow; onPatch: (patch: Partial<FlowNodeData>) => void }) {
  switch (node.kind) {
    case "trigger":
      return <TriggerFields node={node} flow={flow} onPatch={onPatch} />;
    case "instruction":
      return (
        <textarea
          className="flow-text"
          placeholder="Escreva a instrução. O que chegar antes vem depois dela."
          value={node.text}
          onChange={(e) => onPatch({ text: e.target.value })}
        />
      );
    case "ai":
      return <AiFields node={node} flow={flow} onPatch={onPatch} />;
    case "bee":
      return <BeeFields node={node} flow={flow} onPatch={onPatch} />;
    case "condition":
      return (
        <div className="flow-fields">
          <input placeholder="Nome, ex.: Achou algum PR?" value={node.label} onChange={(e) => onPatch({ label: e.target.value })} />
          <div className="flow-seg">
            <button className={node.mode === "text" ? "on" : ""} onClick={() => onPatch({ mode: "text" })}>
              Pelo texto
            </button>
            <button className={node.mode === "ai" ? "on" : ""} onClick={() => onPatch({ mode: "ai" })}>
              Perguntar à IA
            </button>
          </div>
          {node.mode === "text" ? (
            <div className="flow-inline">
              <select className="bee-select" value={node.op} onChange={(e) => onPatch({ op: e.target.value as typeof node.op })}>
                <option value="contains">contém</option>
                <option value="notContains">não contém</option>
                <option value="startsWith">começa com</option>
              </select>
              <input placeholder="texto" value={node.value} onChange={(e) => onPatch({ value: e.target.value })} />
            </div>
          ) : (
            <>
              <textarea
                className="flow-text short"
                placeholder="Pergunta de sim ou não sobre o que chegou"
                value={node.question}
                onChange={(e) => onPatch({ question: e.target.value })}
              />
              <span className="hint">Um modelo pequeno lê o que chegou e responde sim ou não.</span>
            </>
          )}
        </div>
      );
    case "approval":
      return (
        <div className="flow-fields">
          <input placeholder="Pergunta, ex.: Subir as correções?" value={node.question} onChange={(e) => onPatch({ question: e.target.value })} />
          <span className="hint">O fluxo para aqui até você aprovar ou recusar, na Fila ou na execução.</span>
        </div>
      );
    case "output":
      return <OutputFields node={node} onPatch={onPatch} />;
  }
}

function TriggerFields({
  node,
  flow,
  onPatch,
}: {
  node: Extract<FlowNode, { kind: "trigger" }>;
  flow?: Flow;
  onPatch: (patch: Partial<FlowNodeData>) => void;
}) {
  const t = node.trigger;
  const set = (trigger: FlowTrigger) => onPatch({ trigger });
  const next = flow ? nextRunAt(flow) : null;
  const running = useFlowRuns((s) => !!flow && s.runs.some((r) => r.flowId === flow.id && r.status === "running"));
  return (
    <div className="flow-fields">
      <select
        className="bee-select wide"
        value={t.kind}
        onChange={(e) => {
          const k = e.target.value;
          if (k === "manual") set({ kind: "manual" });
          if (k === "interval") set({ kind: "interval", minutes: 60 });
          if (k === "schedule") set({ kind: "schedule", days: WORKDAYS, time: "09:00" });
          if (k === "event") set({ kind: "event", event: { on: "stop" }, groupId: null, cooldown: 10 });
        }}
      >
        <option value="manual">Manual</option>
        <option value="schedule">Agendamento</option>
        <option value="interval">Intervalo</option>
        <option value="event">Evento</option>
      </select>
      {t.kind === "manual" && <span className="hint">Roda quando você pedir.</span>}
      {t.kind === "interval" && (
        <select className="bee-select wide" value={t.minutes} onChange={(e) => set({ kind: "interval", minutes: Number(e.target.value) })}>
          {INTERVALS.map((m) => (
            <option key={m} value={m}>
              {describeTrigger({ kind: "interval", minutes: m })}
            </option>
          ))}
        </select>
      )}
      {t.kind === "schedule" && (
        <div className="flow-days">
          {DAY_NAMES.map((d, i) => (
            <button
              key={d}
              className={t.days.includes(i) ? "on" : ""}
              onClick={() => set({ ...t, days: t.days.includes(i) ? t.days.filter((x) => x !== i) : [...t.days, i] })}
            >
              {d[0]}
            </button>
          ))}
          <span className="hint">às</span>
          <input type="time" className="bee-time" value={t.time} onChange={(e) => e.target.value && set({ ...t, time: e.target.value })} />
        </div>
      )}
      {t.kind === "event" && <EventFields trigger={t as EventTrigger} selfId={flow?.id} onChange={set} />}
      {(t.kind === "interval" || t.kind === "schedule") && (
        <>
          <label className="flow-kv">
            <span>Perdida com o app fechado</span>
            <select className="bee-select" value={node.missed} onChange={(e) => onPatch({ missed: e.target.value as "run" | "skip" })}>
              <option value="run">roda ao abrir</option>
              <option value="skip">pula</option>
            </select>
          </label>
          <div className="flow-kv">
            <span>Próxima execução</span>
            <b>{next ? when(next) : flow?.enabled ? "—" : "desligado"}</b>
          </div>
        </>
      )}
      {flow && (
        <button className="flow-run-btn" disabled={running} onClick={() => runFlowNow(flow)}>
          {running ? "Rodando…" : "Executar agora ▷"}
        </button>
      )}
    </div>
  );
}

const AGENTS: DroneAgent[] = ["claude", "codex", "opencode"];

function AiFields({ node, flow, onPatch }: { node: Extract<FlowNode, { kind: "ai" }>; flow?: Flow; onPatch: (patch: Partial<FlowNodeData>) => void }) {
  const [more, setMore] = useState(false);
  return (
    <div className="flow-fields">
      <textarea className="flow-text" placeholder="Diga ao agente o que fazer" value={node.prompt} onChange={(e) => onPatch({ prompt: e.target.value })} />
      <div className="flow-inline">
        <select className="bee-select" value={node.agent} onChange={(e) => onPatch({ agent: e.target.value as DroneAgent, model: null })}>
          {AGENTS.map((a) => (
            <option key={a} value={a}>
              {AGENT_NAMES[a]}
            </option>
          ))}
        </select>
        {node.agent === "claude" ? (
          <select className="bee-select" value={node.model ?? ""} onChange={(e) => onPatch({ model: e.target.value || null })}>
            <option value="">Modelo padrão</option>
            {CLAUDE_MODELS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        ) : (
          <input placeholder="Modelo padrão" value={node.model ?? ""} onChange={(e) => onPatch({ model: e.target.value || null })} />
        )}
      </div>
      <button className="link flow-more" onClick={() => setMore((v) => !v)}>
        {more ? "Menos opções" : "Pasta e permissões"}
      </button>
      {more && (
        <>
          <DirField value={node.dir} onChange={(dir) => onPatch({ dir })} />
          <label className="check">
            <input type="checkbox" checked={node.worktree} onChange={(e) => onPatch({ worktree: e.target.checked })} />
            Numa worktree nova, se for repositório
          </label>
          {node.agent === "claude" ? (
            <>
              <select className="bee-select wide" value={node.permissionMode ?? ""} onChange={(e) => onPatch({ permissionMode: e.target.value || null })}>
                <option value="">Permissões do app</option>
                {PERMISSION_MODES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <RulesField rules={node.allowedTools} onChange={(allowedTools) => onPatch({ allowedTools })} />
            </>
          ) : (
            <span className="hint">Permissões do Codex e do OpenCode seguem as do app.</span>
          )}
        </>
      )}
      {flow && <StepButton flow={flow} node={node} />}
    </div>
  );
}

function BeeFields({ node, flow, onPatch }: { node: Extract<FlowNode, { kind: "bee" }>; flow?: Flow; onPatch: (patch: Partial<FlowNodeData>) => void }) {
  const bees = useStore((s) => s.bees);
  const bee = bees.find((b) => b.id === node.beeId);
  const setBeeView = useStore((s) => s.setBeeView);
  return (
    <div className="flow-fields">
      <div className="flow-inline">
        {bee && <BeeAvatar seed={bee.id} size={24} />}
        <select className="bee-select wide" value={node.beeId} onChange={(e) => onPatch({ beeId: e.target.value })}>
          <option value="">Escolha a worker bee</option>
          {bees.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      {bee ? (
        <p className="flow-preview" title={bee.instructions}>
          {bee.instructions}
        </p>
      ) : (
        <span className="hint">O que chegar antes vai junto com o prompt dela.</span>
      )}
      <DirField value={node.dir} onChange={(dir) => onPatch({ dir })} />
      <div className="flow-row-btns">
        {bee && (
          <button className="link" onClick={() => setBeeView({ mode: "detail", id: bee.id })}>
            Abrir a worker bee
          </button>
        )}
      </div>
      {flow && bee && <StepButton flow={flow} node={node} />}
    </div>
  );
}

function OutputFields({ node, onPatch }: { node: Extract<FlowNode, { kind: "output" }>; onPatch: (patch: Partial<FlowNodeData>) => void }) {
  const tabs = useStore((s) => s.tabs);
  const sessions = tabs.filter((t) => t.groupId !== "worker-bee" && t.groupId !== "colony");
  return (
    <div className="flow-fields">
      <select
        className="bee-select wide"
        value={node.action}
        onChange={(e) => {
          const action = e.target.value;
          if (action === "session") onPatch({ action: "session", tabId: null } as Partial<FlowNodeData>);
          else onPatch({ action } as Partial<FlowNodeData>);
        }}
      >
        <option value="notify">Notificar</option>
        <option value="session">Mandar para uma sessão</option>
        <option value="none">Nada</option>
      </select>
      {node.action === "session" && (
        <select className="bee-select wide" value={node.tabId ?? ""} onChange={(e) => onPatch({ tabId: e.target.value || null } as Partial<FlowNodeData>)}>
          <option value="">A sessão que abriu a espera</option>
          {sessions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      )}
      <span className="hint">
        {node.action === "notify"
          ? "Mostra o resultado numa notificação."
          : node.action === "session"
            ? "Digita o resultado na sessão, como uma mensagem sua."
            : "O fluxo termina aqui sem avisar."}
      </span>
    </div>
  );
}

function DirField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (
    <input
      className="mono"
      placeholder="Pasta (vazio: a do gatilho)"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value.trim() ? e.target.value : null)}
    />
  );
}

function RulesField({ rules, onChange }: { rules: string[]; onChange: (r: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const r = draft.trim();
    if (r && !rules.includes(r)) onChange([...rules, r]);
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
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
        onBlur={add}
      />
    </div>
  );
}

/** Runs one node alone, to see how it does before wiring the rest. */
function StepButton({ flow, node }: { flow: Flow; node: FlowNode }) {
  const setFlowView = useStore((s) => s.setFlowView);
  return (
    <button
      className="flow-run-btn quiet"
      onClick={() => {
        const run = runNodeAlone(flow, node.id);
        if (run) setFlowView({ flowId: flow.id, runId: run.id });
      }}
    >
      Executar etapa ▷
    </button>
  );
}

/** A flow's runs, and the one picked on the canvas. */
function RunScreen({ flow, run }: { flow: Flow; run?: FlowRun }) {
  const runs = useFlowRuns((s) => s.runs).filter((r) => r.flowId === flow.id);
  const setFlowView = useStore((s) => s.setFlowView);
  const [, tick] = useState(0);
  useEffect(() => {
    if (run?.status !== "running") return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [run?.status]);
  const label = (r: FlowRun) => {
    if (r.status === "running") return Object.values(r.states).some((s) => s.status === "waiting") ? "esperando você" : "rodando";
    if (r.status === "cancelled") return "cancelada";
    if (r.status === "error") return r.error ?? "falhou";
    return `concluída · ${elapsed(r.startedAt, r.endedAt ?? r.startedAt)}`;
  };
  return (
    <div className="flow-runs-screen">
      <aside className="flow-runs">
        <button className="link" onClick={() => setFlowView({ flowId: flow.id })}>
          ← {flow.name}
        </button>
        <h4>Execuções</h4>
        {runs.length === 0 && <p className="hint">Ainda não rodou.</p>}
        <ul>
          {runs.map((r) => (
            <li key={r.id} className={r.id === run?.id ? "on" : ""} onClick={() => setFlowView({ flowId: flow.id, runId: r.id })}>
              <span className={`flow-dot ${r.status === "running" ? "w" : r.status === "done" ? "ok" : r.status === "cancelled" ? "sl" : "err"}`} />
              <span className="flow-row-main">
                <span className="flow-name">{when(r.startedAt)}</span>
                <span className="flow-meta">{label(r)}</span>
              </span>
            </li>
          ))}
        </ul>
      </aside>
      <div className="flow-editor">
        {run ? (
          <>
            <header className="flow-head">
              <b>{run.flowName}</b>
              <span className="hint">
                {when(run.startedAt)} · {run.status === "running" ? `${elapsed(run.startedAt, Date.now())} até agora` : label(run)}
              </span>
              <span className="grow" />
              {run.status === "running" && (
                <button className="ghost auto" onClick={() => cancelFlowRun(run.id)}>
                  Cancelar
                </button>
              )}
              <button className="ghost auto" onClick={() => setFlowView({ flowId: flow.id })}>
                Editar fluxo
              </button>
            </header>
            <Canvas key={run.id} flow={run} run={run} />
          </>
        ) : (
          <div className="bee-blank">
            <p className="hint">Escolha uma execução.</p>
          </div>
        )}
      </div>
    </div>
  );
}
