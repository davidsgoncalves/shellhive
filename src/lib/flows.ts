import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { notify } from "./notify";
import { sendMessage } from "./typing";
import { agentCommand } from "./providers";
import { beePrompt, withInput, describeTrigger, onFlowRunEnded, quotaResetAt, runJob, stopBeeRun, unqueue, useBeeRuns, DAY_NAMES } from "./bees";
import { makeNode, NODE_GAP, NODE_W } from "./flowGraph";
import type { BeeEvent, BeeRun, Flow, FlowNode, FlowNodeState, FlowRun, FlowTrigger, HookEvent, Tab } from "./types";

/** Runs kept per flow, newest first. */
const KEEP_RUNS = 30;
const TICK_MS = 30_000;
const DAY_MS = 86_400_000;
/** The model that answers an AI condition: quick and cheap, as a yes or no needs. */
const CONDITION_MODEL = "haiku";

interface FlowRunStore {
  runs: FlowRun[];
  loaded: boolean;
  load: () => Promise<void>;
  put: (run: FlowRun) => void;
  /** Flows due but held back by the usage ceilings, with when the window resets. */
  held: Record<string, number>;
  setHeld: (held: Record<string, number>) => void;
}

const saveRuns = (runs: FlowRun[]) =>
  invoke("flow_runs_set", { value: { runs } }).catch((err) => console.error("flow runs save failed", err));

export const useFlowRuns = create<FlowRunStore>()((set, get) => ({
  runs: [],
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    const stored = await invoke<{ runs?: FlowRun[] } | null>("flow_runs_get").catch(() => null);
    // Agents do not outlive the app; an approval still waiting does.
    const runs = (Array.isArray(stored?.runs) ? stored.runs : []).map((r) => {
      if (r.status !== "running") return r;
      const cut = Object.values(r.states).some((s) => s.status === "running");
      if (!cut) return r;
      const states = Object.fromEntries(
        Object.entries(r.states).map(([id, s]) => [
          id,
          s.status === "running" ? { ...s, status: "error" as const, output: "O app fechou durante a execução.", endedAt: Date.now() } : s,
        ]),
      );
      return { ...r, states, status: "error" as const, error: "O app fechou durante a execução.", endedAt: Date.now() };
    });
    set({ runs, loaded: true });
  },
  put: (run) => {
    const others = get().runs.filter((r) => r.id !== run.id);
    const mine = [run, ...others.filter((r) => r.flowId === run.flowId)]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, KEEP_RUNS);
    const runs = [...mine, ...others.filter((r) => r.flowId !== run.flowId)].sort((a, b) => b.startedAt - a.startedAt);
    set({ runs });
    void saveRuns(runs);
  },
  held: {},
  setHeld: (held) => set({ held }),
}));

const runById = (id: string) => useFlowRuns.getState().runs.find((r) => r.id === id);

/** Approvals waiting for the user, across every flow run. */
export function useFlowApprovals(): Array<{ run: FlowRun; node: FlowNode }> {
  const runs = useFlowRuns((s) => s.runs);
  const out: Array<{ run: FlowRun; node: FlowNode }> = [];
  for (const run of runs) {
    if (run.status !== "running") continue;
    for (const node of run.nodes) if (run.states[node.id]?.status === "waiting") out.push({ run, node });
  }
  return out;
}

/** What happened, as the hooks and the app report it, for flow triggers to match. */
/** `cwd` is the folder of the session or run it came from, where agents then work. */
export type Happening =
  | { on: "stop" | "sessionEnd" | "notification" | "subagentStop"; groupId: string; tabId: string; title: string; cwd: string | null }
  | { on: "tool"; groupId: string; tabId: string; title: string; cwd: string | null; tool: string; input: string }
  | { on: "flowDone"; flowId: string; cwd: string | null; output: string }
  | { on: "usage"; window: "session" | "weekly"; from: number; to: number }
  | { on: "appOpen" };

const HOOKS: Record<string, "stop" | "sessionEnd" | "notification" | "subagentStop"> = {
  Stop: "stop",
  SessionEnd: "sessionEnd",
  Notification: "notification",
  SubagentStop: "subagentStop",
};

/** The happening a hook event from a tab stands for, if any flow can start on it. */
export function happeningOf(e: HookEvent, tab: Tab): Happening | null {
  const name = String(e.payload.hook_event_name ?? "");
  const cwd = typeof e.payload.cwd === "string" && e.payload.cwd ? e.payload.cwd : tab.cwd ?? null;
  const base = { groupId: tab.groupId, tabId: tab.id, title: tab.title, cwd };
  if (HOOKS[name]) return { on: HOOKS[name], ...base };
  if (name === "PostToolUse" && typeof e.payload.tool_name === "string") {
    return { on: "tool", ...base, tool: e.payload.tool_name, input: JSON.stringify(e.payload.tool_input ?? {}) };
  }
  return null;
}

function matches(e: BeeEvent, h: Happening): boolean {
  if (e.on !== h.on) return false;
  if (e.on === "tool" && h.on === "tool") {
    return (!e.tool || e.tool === h.tool) && (!e.match || h.input.toLowerCase().includes(e.match.toLowerCase()));
  }
  if (e.on === "flowDone" && h.on === "flowDone") return e.flowId === h.flowId;
  // Fires once, when usage crosses the line, not on every report above it.
  if (e.on === "usage" && h.on === "usage") return e.window === h.window && h.from < e.percent && h.to >= e.percent;
  return true;
}

/** What the trigger hands the next node, in words. */
function told(h: Happening): string {
  switch (h.on) {
    case "stop":
      return `A sessão "${h.title}" terminou de responder.${h.cwd ? ` Pasta: ${h.cwd}` : ""}`;
    case "sessionEnd":
      return `A sessão "${h.title}" foi encerrada.${h.cwd ? ` Pasta: ${h.cwd}` : ""}`;
    case "notification":
      return `A sessão "${h.title}" está esperando o usuário.${h.cwd ? ` Pasta: ${h.cwd}` : ""}`;
    case "subagentStop":
      return `Um subagente da sessão "${h.title}" terminou.${h.cwd ? ` Pasta: ${h.cwd}` : ""}`;
    case "tool":
      return `A sessão "${h.title}" usou ${h.tool}: ${h.input.slice(0, 2000)}${h.cwd ? `\nPasta: ${h.cwd}` : ""}`;
    case "flowDone":
      return h.output;
    case "usage":
      return `O uso ${h.window === "session" ? "da sessão (5h)" : "semanal (7d)"} chegou a ${Math.round(h.to)}%.`;
    case "appOpen":
      return "O app abriu.";
  }
}

const triggerOf = (flow: Flow) => flow.nodes.find((n): n is Extract<FlowNode, { kind: "trigger" }> => n.kind === "trigger");

const running = (flowId: string) => useFlowRuns.getState().runs.some((r) => r.flowId === flowId && r.status === "running");

/**
 * Starts the enabled flows whose event trigger `h` matches. They wait out the
 * cooldown and the usage ceilings; a run that cannot start now is dropped.
 */
export function fireFlowEvent(h: Happening): void {
  const now = Date.now();
  const held = quotaResetAt(now) !== null;
  for (const flow of useStore.getState().flows) {
    const node = triggerOf(flow);
    const t = node?.trigger;
    if (!flow.enabled || !t || t.kind !== "event" || !matches(t.event, h)) continue;
    if ("groupId" in h && t.groupId && t.groupId !== h.groupId) continue;
    if ("tabId" in h && t.tabId && t.tabId !== h.tabId) continue;
    if (flow.lastRunAt && now - flow.lastRunAt < t.cooldown * 60_000) continue;
    // An open wait is the user's own request; the ceilings hold back only the automatic.
    if (held && !flow.wait) continue;
    startFlow(flow, { text: told(h), cwd: "cwd" in h ? h.cwd : null });
  }
}

/** The latest moment at or before `now` the schedule asks for a run. */
function latestSlot(t: Extract<FlowTrigger, { kind: "schedule" }>, now: number): number | null {
  const [h, m] = t.time.split(":").map(Number);
  for (let back = 0; back <= 7; back++) {
    const day = new Date(now - back * DAY_MS);
    day.setHours(h, m, 0, 0);
    if (day.getTime() <= now && t.days.includes(day.getDay())) return day.getTime();
  }
  return null;
}

/** When a flow is due, the time it was due at; null when it is not. */
function dueAt(flow: Flow, t: FlowTrigger, now: number): number | null {
  const last = flow.lastRunAt ?? flow.createdAt;
  if (t.kind === "interval") {
    const at = last + t.minutes * 60_000;
    return at <= now ? at : null;
  }
  if (t.kind === "schedule") {
    const slot = latestSlot(t, now);
    return slot !== null && slot > last ? slot : null;
  }
  return null;
}

/** Starts a run of a flow from its trigger, unless one of it is still going. */
export function startFlow(flow: Flow, from: { text: string; cwd: string | null }): FlowRun | null {
  const store = useStore.getState();
  store.updateFlow(flow.id, { lastRunAt: Date.now() });
  if (running(flow.id)) return null;
  const trigger = triggerOf(flow);
  if (!trigger) return null;
  const states: Record<string, FlowNodeState> = Object.fromEntries(flow.nodes.map((n) => [n.id, { status: "pending" as const }]));
  states[trigger.id] = { status: "done", output: from.text, startedAt: Date.now(), endedAt: Date.now() };
  const run: FlowRun = {
    id: crypto.randomUUID(),
    flowId: flow.id,
    flowName: flow.name,
    nodes: flow.nodes,
    edges: flow.edges,
    startedAt: Date.now(),
    endedAt: null,
    status: "running",
    cwd: from.cwd,
    states,
  };
  useFlowRuns.getState().put(run);
  void advance(run.id);
  return run;
}

/** Runs one node alone, as a test: it gets nothing from before it. */
export function runNodeAlone(flow: Flow, nodeId: string): FlowRun | null {
  const node = flow.nodes.find((n) => n.id === nodeId);
  if (!node || node.kind === "trigger") return null;
  const start = makeNode({ kind: "trigger", trigger: { kind: "manual" }, missed: "run" }, node.x - NODE_W - NODE_GAP, node.y);
  const run: FlowRun = {
    id: crypto.randomUUID(),
    flowId: flow.id,
    flowName: `${flow.name} · só ${labelOf(node)}`,
    nodes: [start, node],
    edges: [{ id: crypto.randomUUID(), from: start.id, port: "out", to: node.id }],
    startedAt: Date.now(),
    endedAt: null,
    status: "running",
    cwd: null,
    states: {
      [start.id]: { status: "done", output: "", startedAt: Date.now(), endedAt: Date.now() },
      [node.id]: { status: "pending" },
    },
  };
  useFlowRuns.getState().put(run);
  void advance(run.id);
  return run;
}

/** When a flow's trigger next starts it on its own, if it does. */
export function nextRunAt(flow: Flow, now = Date.now()): number | null {
  const t = triggerOf(flow)?.trigger;
  if (!t || !flow.enabled) return null;
  if (t.kind === "interval") return Math.max(now, (flow.lastRunAt ?? flow.createdAt) + t.minutes * 60_000);
  if (t.kind !== "schedule" || !t.days.length) return null;
  const [h, m] = t.time.split(":").map(Number);
  for (let ahead = 0; ahead <= 7; ahead++) {
    const day = new Date(now + ahead * DAY_MS);
    day.setHours(h, m, 0, 0);
    if (day.getTime() > now && t.days.includes(day.getDay())) return day.getTime();
  }
  return null;
}

/** Starts a flow by hand, from its first node after the trigger. */
export function runFlowNow(flow: Flow, cwd: string | null = null): void {
  startFlow(flow, { text: "Rodado à mão pelo usuário.", cwd });
}

function patchNode(runId: string, nodeId: string, patch: Partial<FlowNodeState>): FlowRun | undefined {
  const run = runById(runId);
  if (!run) return undefined;
  const next = { ...run, states: { ...run.states, [nodeId]: { ...run.states[nodeId], ...patch } } };
  useFlowRuns.getState().put(next);
  return next;
}

/** What reaches a node: the outputs of the nodes linked to it whose exit was taken. */
function inputOf(run: FlowRun, node: FlowNode): { ready: boolean; active: boolean; text: string } {
  const incoming = run.edges.filter((e) => e.to === node.id);
  if (!incoming.length) return { ready: true, active: false, text: "" };
  const parts: Array<{ y: number; text: string }> = [];
  let active = false;
  for (const e of incoming) {
    const st = run.states[e.from];
    if (!st || st.status === "pending" || st.status === "running" || st.status === "waiting") return { ready: false, active: false, text: "" };
    if (st.status !== "done") continue;
    if (e.port !== "out" && st.port !== e.port) continue;
    active = true;
    const from = run.nodes.find((n) => n.id === e.from);
    if (st.output?.trim()) parts.push({ y: from?.y ?? 0, text: st.output.trim() });
  }
  parts.sort((a, b) => a.y - b.y);
  return { ready: true, active, text: parts.map((p) => p.text).join("\n\n") };
}

/** Moves a run as far as it can: starts every node whose inputs are in, and ends the run when nothing is left. */
async function advance(runId: string): Promise<void> {
  for (let guard = 0; guard < 500; guard++) {
    const run = runById(runId);
    if (!run || run.status !== "running") return;
    let moved = false;
    for (const node of run.nodes) {
      if (run.states[node.id]?.status !== "pending") continue;
      const input = inputOf(run, node);
      if (!input.ready) continue;
      moved = true;
      // A failed run starts nothing new; nodes no exit led to are skipped.
      if (!input.active || run.error) {
        patchNode(runId, node.id, { status: "skipped" });
        break;
      }
      await startNode(runById(runId)!, node, input.text);
      break;
    }
    if (!moved) break;
  }
  settle(runId);
}

/** Ends a run once none of its nodes is pending, going or waiting. */
function settle(runId: string): void {
  const run = runById(runId);
  if (!run || run.status !== "running") return;
  const open = Object.values(run.states).some((s) => s.status === "pending" || s.status === "running" || s.status === "waiting");
  if (open) return;
  const status = run.error ? "error" : "done";
  useFlowRuns.getState().put({ ...run, status, endedAt: Date.now() });
  const flow = useStore.getState().flows.find((f) => f.id === run.flowId);
  // An open wait goes away once it fired.
  if (flow?.wait) useStore.getState().removeFlow(flow.id);
  if (status === "error") void notify(`Fluxo ${run.flowName} falhou`, run.error?.slice(0, 160) ?? "", true);
  if (status === "done") {
    const last = lastOutput(runById(runId)!);
    fireFlowEvent({ on: "flowDone", flowId: run.flowId, cwd: run.cwd, output: last });
  }
}

/** The output of the last node that ran, for a flow started after this one. */
function lastOutput(run: FlowRun): string {
  let best: { at: number; text: string } | null = null;
  for (const s of Object.values(run.states)) {
    if (s.status === "done" && s.output && (!best || (s.endedAt ?? 0) >= best.at)) best = { at: s.endedAt ?? 0, text: s.output };
  }
  return best?.text ?? "";
}

function failNode(runId: string, nodeId: string, why: string): void {
  const run = patchNode(runId, nodeId, { status: "error", output: why, endedAt: Date.now() });
  if (run && !run.error) {
    const node = run.nodes.find((n) => n.id === nodeId);
    useFlowRuns.getState().put({ ...run, error: `${node ? labelOf(node) : "Nó"}: ${why}` });
  }
}

const labelOf = (n: FlowNode) =>
  n.kind === "ai" ? "IA" : n.kind === "bee" ? "Abelha" : n.kind === "condition" ? "Condição" : n.kind === "approval" ? "Aprovação" : n.kind === "output" ? "Saída" : n.kind === "instruction" ? "Instrução" : "Gatilho";

function textTest(op: "contains" | "notContains" | "startsWith", value: string, text: string): boolean {
  const a = text.trim().toLowerCase();
  const b = value.trim().toLowerCase();
  if (op === "startsWith") return a.startsWith(b);
  if (op === "notContains") return !a.includes(b);
  return a.includes(b);
}

async function startNode(run: FlowRun, node: FlowNode, input: string): Promise<void> {
  const now = Date.now();
  const done = (output: string, port?: FlowNodeState["port"]) =>
    patchNode(run.id, node.id, { status: "done", output, port, startedAt: now, endedAt: Date.now() });
  const flowStore = useStore.getState();
  switch (node.kind) {
    case "trigger":
      return void done("");
    case "instruction": {
      const text = node.text.trim();
      return void done(text && input ? `${text}\n\n${input}` : text || input);
    }
    case "ai": {
      const prompt = withInput(node.prompt, input);
      if (!prompt.trim()) return failNode(run.id, node.id, "Diga ao agente o que fazer, ou ligue uma Instrução antes dele.");
      patchNode(run.id, node.id, { status: "running", startedAt: now });
      return runJob({
        key: `${run.id}:${node.id}`,
        name: `${run.flowName} · IA`,
        prompt,
        dir: node.dir ?? run.cwd,
        worktree: node.worktree,
        agent: node.agent,
        beeId: "",
        flowRunId: run.id,
        nodeId: node.id,
        spec: { name: `${run.flowName} · IA`, agent: node.agent, model: node.model, permissionMode: node.permissionMode, allowedTools: node.allowedTools },
      });
    }
    case "bee": {
      const bee = flowStore.bees.find((b) => b.id === node.beeId);
      if (!bee) return failNode(run.id, node.id, "Escolha a worker bee deste nó.");
      patchNode(run.id, node.id, { status: "running", startedAt: now });
      return runJob({
        key: `${run.id}:${node.id}`,
        name: bee.name,
        prompt: beePrompt(bee, input),
        dir: node.dir ?? run.cwd,
        worktree: !!bee.worktree,
        agent: "claude",
        beeId: bee.id,
        flowRunId: run.id,
        nodeId: node.id,
      });
    }
    case "condition": {
      if (node.mode === "text") return void done(input, textTest(node.op, node.value, input) ? "yes" : "no");
      if (!node.question.trim()) return failNode(run.id, node.id, "Escreva a pergunta da condição.");
      patchNode(run.id, node.id, { status: "running", startedAt: now });
      return runJob({
        key: `${run.id}:${node.id}`,
        name: `${run.flowName} · Condição`,
        prompt: `${node.question.trim()}\n\nTexto:\n${input || "(vazio)"}\n\nResponda só "sim" ou "não", sem mais nada. Não use ferramentas.`,
        dir: null,
        worktree: false,
        agent: "claude",
        beeId: "",
        flowRunId: run.id,
        nodeId: node.id,
        spec: { name: `${run.flowName} · Condição`, agent: "claude", model: CONDITION_MODEL, permissionMode: "plan", allowedTools: [] },
      });
    }
    case "approval": {
      patchNode(run.id, node.id, { status: "waiting", output: input, startedAt: now });
      void notify(`${run.flowName}: aprovação`, (node.question || "Um fluxo espera sua aprovação.").slice(0, 160), true);
      return;
    }
    case "output": {
      if (node.action === "none") return void done(input);
      if (node.action === "notify") {
        void notify(run.flowName, input.slice(0, 160) || "Fluxo concluído.", true);
        return void done(input);
      }
      const tabId = node.tabId ?? flowStore.flows.find((f) => f.id === run.flowId)?.wait?.tabId ?? null;
      const tab = tabId ? flowStore.tabs.find((t) => t.id === tabId) : undefined;
      if (!tab || tab.state === "dormant") {
        void notify(run.flowName, input.slice(0, 160) || "Fluxo concluído.", true);
        return void done("A sessão não estava aberta; o resultado foi como notificação.");
      }
      // Marked first, so a second look at the run does not send it twice.
      patchNode(run.id, node.id, { status: "running", startedAt: now });
      try {
        await deliver(tab, `[Fluxo · ${run.flowName}]\n\n${input || "Concluído."}`);
        return void done(input);
      } catch (err) {
        return failNode(run.id, node.id, `Não consegui mandar para a sessão: ${err}`);
      }
    }
  }
}

/** Types a message into a session, as the user would. */
async function deliver(tab: Tab, text: string): Promise<void> {
  if (tab.provider) {
    useStore.getState().patchTab(tab.id, { state: "working" });
    await invoke(agentCommand(tab.provider, "send"), { tabId: tab.id, text, model: tab.agentModel ?? null, images: [] });
    return;
  }
  await sendMessage(tab.id, text);
}

/** An agent run behind a node ended. */
function nodeRunEnded(run: BeeRun): void {
  if (!run.flowRunId || !run.nodeId) return;
  const flowRun = runById(run.flowRunId);
  const node = flowRun?.nodes.find((n) => n.id === run.nodeId);
  if (!flowRun || !node) return;
  if (flowRun.states[node.id]?.status !== "running") return;
  if (run.status !== "done") {
    failNode(flowRun.id, node.id, run.summary ?? "A execução falhou.");
  } else if (node.kind === "condition") {
    const input = inputOf(flowRun, node).text;
    const yes = /^\W*sim\b/i.test(run.summary ?? "");
    patchNode(flowRun.id, node.id, { status: "done", output: input, port: yes ? "yes" : "no", runId: run.id, endedAt: Date.now() });
  } else {
    patchNode(flowRun.id, node.id, { status: "done", output: run.summary ?? "", runId: run.id, endedAt: Date.now() });
  }
  void advance(flowRun.id);
}

/** Answers an approval: yes leaves by Aprovado, no by Recusado. */
export function answerApproval(runId: string, nodeId: string, yes: boolean): void {
  const run = runById(runId);
  if (!run || run.states[nodeId]?.status !== "waiting") return;
  patchNode(runId, nodeId, { status: "done", port: yes ? "yes" : "no", endedAt: Date.now() });
  void advance(runId);
}

/** Stops a run: its agents end, and nothing else starts. */
export function cancelFlowRun(runId: string): void {
  const run = runById(runId);
  if (!run || run.status !== "running") return;
  const states = { ...run.states };
  for (const [id, s] of Object.entries(states)) {
    if (s.status === "pending" || s.status === "waiting") states[id] = { ...s, status: "skipped" };
  }
  useFlowRuns.getState().put({ ...run, states, status: "cancelled", error: "Cancelado por você.", endedAt: Date.now() });
  for (const r of useBeeRuns.getState().runs) {
    if (r.flowRunId === runId && r.status === "running") stopBeeRun(r, "Fluxo cancelado.");
  }
  for (const node of run.nodes) unqueue(`${runId}:${node.id}`);
}

/** Bees no longer have triggers; their runs by hand are the only ones outside a flow. */
export function startFlows(): () => void {
  onFlowRunEnded(nodeRunEnded);
  const launchedAt = Date.now();
  // Usage crossing a line, as each status report updates it.
  const unsubscribe = useStore.subscribe((s, prev) => {
    const at = s.rateLimits;
    const was = prev.rateLimits;
    if (!at || at === was) return;
    const windows = [
      ["session", at.five_hour, was?.five_hour],
      ["weekly", at.seven_day, was?.seven_day],
    ] as const;
    for (const [window, now, before] of windows) {
      // The first report after launch is a starting point, not a crossing.
      if (!now || !before) continue;
      // A new window starts from zero, whatever the last one reached.
      const from = before.resets_at === now.resets_at ? before.used_percentage : 0;
      if (now.used_percentage > from) fireFlowEvent({ on: "usage", window, from, to: now.used_percentage });
    }
  });
  const tick = async () => {
    await useFlowRuns.getState().load();
    await useBeeRuns.getState().load();
    const now = Date.now();
    // A due run over the ceiling stays due, so it starts once the window resets.
    const heldUntil = quotaResetAt(now);
    const held: Record<string, number> = {};
    for (const flow of useStore.getState().flows) {
      const node = triggerOf(flow);
      if (!flow.enabled || !node) continue;
      const at = dueAt(flow, node.trigger, now);
      if (at === null) continue;
      if (at < launchedAt && node.missed === "skip") useStore.getState().updateFlow(flow.id, { lastRunAt: now });
      else if (heldUntil !== null) held[flow.id] = heldUntil;
      else startFlow(flow, { text: `Execução agendada (${describeTrigger(node.trigger)}).`, cwd: null });
    }
    useFlowRuns.getState().setHeld(held);
  };
  // Runs are loaded first, so a flow still marked running is not started twice.
  void tick().then(() => fireFlowEvent({ on: "appOpen" }));
  const timer = setInterval(() => void tick(), TICK_MS);
  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}

/** Opens a wait for a session: when `on` happens, the session gets `message` back. */
function openWait(tab: Tab, trigger: FlowTrigger, message: string, label: string): Flow {
  const t = makeNode({ kind: "trigger", trigger, missed: "run" }, 40, 80);
  const say = makeNode({ kind: "instruction", text: message }, 40 + NODE_W + NODE_GAP, 80);
  const out = makeNode({ kind: "output", action: "session", tabId: tab.id }, 40 + 2 * (NODE_W + NODE_GAP), 80);
  const flow: Flow = {
    id: crypto.randomUUID(),
    name: label,
    enabled: true,
    nodes: [t, say, out],
    edges: [
      { id: crypto.randomUUID(), from: t.id, port: "out", to: say.id },
      { id: crypto.randomUUID(), from: say.id, port: "out", to: out.id },
    ],
    createdAt: Date.now(),
    lastRunAt: Date.now(),
    wait: { tabId: tab.id, title: tab.title },
  };
  useStore.getState().addFlow(flow);
  return flow;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The wait tools any session has, answered for the session in tab `tabId`. */
export function callFlowTool(tool: string, args: Record<string, unknown>, tabId: string | null): { text: string; isError?: boolean } {
  const s = useStore.getState();
  const tab = tabId ? s.tabs.find((t) => t.id === tabId) : undefined;
  if (!tab) return { text: "Esta ferramenta só funciona dentro de uma aba do Shellhive.", isError: true };
  if (tool === "list_waits") {
    const mine = s.flows.filter((f) => f.wait?.tabId === tab.id);
    if (!mine.length) return { text: "Nenhuma espera aberta nesta sessão." };
    return { text: mine.map((f) => `${f.id}: ${f.name}`).join("\n") };
  }
  if (tool === "cancel_wait") {
    const flow = s.flows.find((f) => f.id === str(args.id) && f.wait?.tabId === tab.id);
    if (!flow) return { text: "Espera não encontrada nesta sessão. Veja os ids com list_waits.", isError: true };
    s.removeFlow(flow.id);
    return { text: "Espera cancelada." };
  }
  if (tool !== "wait_for") return { text: `Ferramenta desconhecida: ${tool}`, isError: true };
  const message = str(args.message);
  if (!message) return { text: "Diga em message o que você deve fazer quando acordar.", isError: true };
  const kind = str(args.on);
  if (kind === "session") {
    const name = str(args.session).toLowerCase();
    const others = s.tabs.filter((t) => t.id !== tab.id && t.groupId !== "worker-bee");
    const target = others.find((t) => t.id === str(args.session)) ?? others.find((t) => t.title.toLowerCase() === name) ?? others.find((t) => name && t.title.toLowerCase().includes(name));
    if (!target) {
      const names = others.map((t) => `"${t.title}"`).join(", ") || "nenhuma";
      return { text: `Não achei a sessão "${str(args.session)}". Abas abertas: ${names}.`, isError: true };
    }
    const event = str(args.event) === "ended" ? ({ on: "sessionEnd" } as const) : ({ on: "stop" } as const);
    const flow = openWait(tab, { kind: "event", event, groupId: null, cooldown: 0, tabId: target.id }, message, `Esperando "${target.title}" ${event.on === "stop" ? "terminar" : "encerrar"}`);
    return { text: `Espera aberta (${flow.id}). Quando "${target.title}" ${event.on === "stop" ? "terminar de responder" : "for encerrada"}, esta sessão recebe sua mensagem. Termine o turno agora.` };
  }
  if (kind === "time") {
    const minutes = Number(args.minutes);
    if (!Number.isFinite(minutes) || minutes < 1) return { text: "Informe minutes, 1 ou mais.", isError: true };
    const at = new Date(Date.now() + minutes * 60_000);
    const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    const flow = openWait(tab, { kind: "schedule", days: [at.getDay()], time }, message, `Esperando até ${DAY_NAMES[at.getDay()]} ${time}`);
    // Due from now on, not from a slot before.
    s.updateFlow(flow.id, { lastRunAt: Date.now() });
    return { text: `Espera aberta (${flow.id}). Às ${time} esta sessão recebe sua mensagem. Termine o turno agora.` };
  }
  return { text: 'Informe on: "session" (com session e event) ou "time" (com minutes).', isError: true };
}
