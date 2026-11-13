import type { FlowEdge, FlowNode, FlowNodeData, FlowNodeKind, FlowPort } from "./types";

/** A node's card on the canvas, in canvas pixels; its height follows its fields. */
export const NODE_W = 280;
/** Room between two nodes laid out side by side. */
export const NODE_GAP = 80;
/** How far down the card the entry and the first exit sit, and the room between exits. */
export const PORT_Y = 30;
export const PORT_STEP = 40;

export const KIND_LABEL: Record<FlowNodeKind, string> = {
  trigger: "Gatilho",
  instruction: "Instrução",
  ai: "IA",
  bee: "Abelha",
  condition: "Condição",
  approval: "Aprovação",
  output: "Saída",
};

export const KIND_GLYPH: Record<FlowNodeKind, string> = {
  trigger: "◷",
  instruction: "¶",
  ai: "✦",
  bee: "⬡",
  condition: "◇",
  approval: "✓",
  output: "→",
};

/** The kinds the toolbar adds; a flow has one trigger, made with it. */
export const ADDABLE: FlowNodeKind[] = ["instruction", "ai", "bee", "condition", "approval", "output"];

/** A fresh node of each kind. */
export function blankNode(kind: FlowNodeKind): FlowNodeData {
  switch (kind) {
    case "trigger":
      return { kind, trigger: { kind: "manual" }, missed: "run" };
    case "instruction":
      return { kind, text: "" };
    case "ai":
      return { kind, prompt: "", agent: "claude", model: null, dir: null, worktree: false, permissionMode: null, allowedTools: [] };
    case "bee":
      return { kind, beeId: "", dir: null };
    case "condition":
      return { kind, label: "", mode: "text", op: "contains", value: "", question: "" };
    case "approval":
      return { kind, question: "" };
    case "output":
      return { kind, action: "notify" };
  }
}

export function makeNode(data: FlowNodeData, x: number, y: number): FlowNode {
  return { ...data, id: crypto.randomUUID(), x, y };
}

/** The exits a node has, top to bottom. */
export function portsOf(kind: FlowNodeKind): FlowPort[] {
  if (kind === "condition" || kind === "approval") return ["yes", "no"];
  if (kind === "output") return [];
  return ["out"];
}

export function portLabel(kind: FlowNodeKind, port: FlowPort): string {
  if (port === "out") return "";
  if (kind === "approval") return port === "yes" ? "Aprovado" : "Recusado";
  return port === "yes" ? "Sim" : "Não";
}

/** Whether a node takes anything in: only the trigger starts from nothing. */
export const hasInput = (kind: FlowNodeKind) => kind !== "trigger";

/** Where a node's exit sits, relative to the canvas. */
export function portPoint(node: FlowNode, port: FlowPort): { x: number; y: number } {
  const i = Math.max(0, portsOf(node.kind).indexOf(port));
  return { x: node.x + NODE_W, y: node.y + PORT_Y + i * PORT_STEP };
}

export function inputPoint(node: FlowNode): { x: number; y: number } {
  return { x: node.x, y: node.y + PORT_Y };
}

/** A left-to-right curve from an exit to an entry. */
export function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const bend = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M${a.x} ${a.y} C${a.x + bend} ${a.y} ${b.x - bend} ${b.y} ${b.x} ${b.y}`;
}

/** True when linking `from` to `to` would bring the flow back to where it was. */
export function makesLoop(edges: FlowEdge[], from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edges) if (e.from === id) stack.push(e.to);
  }
  return false;
}
