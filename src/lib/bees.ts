import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { openSession, useStore } from "./store";
import { markPendingPrompt } from "./restored";
import { notify } from "./notify";
import { useAgentEntries } from "./agents";
import { agentCommand } from "./providers";
import type { Check } from "./connections";
import { BEE_GROUP_ID, type AgentSpec, type Bee, type BeeEvent, type BeeRun, type BeeTrigger, type DroneAgent, type FlowTrigger, type GithubEvent, type RateWindow, type SlackEvent } from "./types";
import { PLACEHOLDER } from "./beeTemplates";

/** Runs kept per bee or per flow node, newest first. */
const KEEP_RUNS = 20;
/** How often running tabs are looked at. */
const TICK_MS = 30_000;
/** How long a run's agent has to start before the run counts as failed. */
const START_TIMEOUT_MS = 2 * 60_000;

export const DAY_NAMES = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

/**
 * An agent run waiting its turn or being started: a bee run by hand, or a
 * flow's bee, AI or AI condition node.
 */
export interface Job {
  /** One run per key at a time: the bee's id, or the flow run and node. */
  key: string;
  name: string;
  prompt: string;
  /** The folder to work on; null runs in the bees' empty folder. */
  dir: string | null;
  worktree: boolean;
  agent: DroneAgent;
  beeId: string;
  spec?: AgentSpec;
  flowRunId?: string;
  nodeId?: string;
}

interface RunStore {
  runs: BeeRun[];
  loaded: boolean;
  load: () => Promise<void>;
  /** Adds a run or replaces the one with its id. */
  put: (run: BeeRun) => void;
  /** Jobs due while the most runs at once were going, oldest first. */
  queued: Job[];
  setQueued: (queued: Job[]) => void;
}

const saveRuns = (runs: BeeRun[]) =>
  invoke("bee_runs_set", { value: { runs } }).catch((err) => console.error("bee runs save failed", err));

/** What a run's kept history is counted by: its bee, or its flow node. */
const ownerOf = (r: BeeRun) => (r.nodeId ? `node:${r.nodeId}` : r.beeId);

/** Every bee's and flow node's recent runs, kept across restarts. */
export const useBeeRuns = create<RunStore>()((set, get) => ({
  runs: [],
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    const stored = await invoke<{ runs?: BeeRun[] } | null>("bee_runs_get").catch(() => null);
    // A run still marked running was cut short by the app closing.
    const runs = (Array.isArray(stored?.runs) ? stored.runs : []).map((r) =>
      r.status === "running"
        ? { ...r, status: "error" as const, tabId: null, endedAt: r.endedAt ?? r.startedAt, summary: "O app fechou durante a execução." }
        : r,
    );
    set({ runs, loaded: true });
  },
  put: (run) => {
    const owner = ownerOf(run);
    const others = get().runs.filter((r) => r.id !== run.id);
    const mine = [run, ...others.filter((r) => ownerOf(r) === owner)]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, KEEP_RUNS);
    const runs = [...mine, ...others.filter((r) => ownerOf(r) !== owner)].sort((a, b) => b.startedAt - a.startedAt);
    set({ runs });
    void saveRuns(runs);
  },
  queued: [],
  setQueued: (queued) => set({ queued }),
}));

const keyOf = (r: BeeRun) => (r.flowRunId ? `${r.flowRunId}:${r.nodeId}` : r.beeId);

/** A bee's run started by hand that is still going. */
export const runningRun = (beeId: string) =>
  useBeeRuns.getState().runs.find((r) => r.beeId === beeId && !r.flowRunId && r.status === "running");

/** The run going on in a bee tab. */
export const runOfTab = (tabId: string | null | undefined) =>
  tabId ? useBeeRuns.getState().runs.find((r) => r.tabId === tabId && r.status === "running") : undefined;

/** Stands for what reached the bee in a flow, or nothing when run by hand; {{previous}} is the older name. */
export const PREVIOUS = /\{\{(?:entrada|previous)\}\}/g;
const HAS_INPUT = /\{\{(?:entrada|previous)\}\}/;

/** True while the prompt holds {{...}} parts the user still has to fill in. */
export function hasUnfilled(prompt: string): boolean {
  return PLACEHOLDER.test(prompt.replace(PREVIOUS, ""));
}

/** Asked of a bee run by hand, so the summaries of different bees read the same way. */
const REPLY_FORMAT = `

Ao terminar, responda só com estas três linhas:
Resultado: o que mudou ou o que você concluiu, numa frase.
O que fiz: as ações principais, em poucas palavras.
Pendências: o que ficou para depois ou para o usuário, ou "nenhuma".`;

/** A bee's prompt, given what reached it: {{previous}} takes it, or it follows the prompt. */
export function beePrompt(bee: Bee, input: string): string {
  return withInput(bee.instructions, input);
}

/** A prompt given what reached its node: {{entrada}} takes it, or it follows the prompt. */
export function withInput(prompt: string, input: string): string {
  const own = prompt.trim();
  const text = input.trim();
  if (HAS_INPUT.test(own)) return own.replace(PREVIOUS, text || "(nada chegou)");
  if (!own) return text;
  return text ? `${own}\n\nO que chegou do passo anterior:\n${text}` : own;
}

/** How many ended runs the user has not opened. */
export const useUnreadRuns = () => useBeeRuns((s) => s.runs.filter((r) => r.read === false).length);

export function markRunRead(run: BeeRun): void {
  if (run.read === false) useBeeRuns.getState().put({ ...run, read: true });
}

/** The ended fields of a run whose tab is `tabId`: unread, with its transcript. */
function ended(tabId: string | null) {
  const tab = tabId ? useStore.getState().tabs.find((t) => t.id === tabId) : undefined;
  return { read: false, endedAt: Date.now(), transcriptPath: tab?.transcriptPath ?? null };
}

/** Jobs being set up to run, not yet listed as running. */
const starting = new Set<string>();

function runningCount(): number {
  return useBeeRuns.getState().runs.filter((r) => r.status === "running").length + starting.size;
}

/** Starts the jobs waiting their turn, as far as the most runs at once allows. */
function drainQueue(): void {
  const max = useStore.getState().beeMaxRunning;
  const { queued, setQueued } = useBeeRuns.getState();
  if (!queued.length) return;
  const next = [...queued];
  while (next.length && (max === null || runningCount() < max)) {
    const job = next.shift()!;
    setQueued(next);
    void runJob(job);
  }
  setQueued(next);
}

/** How a trigger reads in the list. */
export function describeTrigger(t: BeeTrigger | FlowTrigger): string {
  if (t.kind === "manual") return "Só manual";
  if (t.kind === "github") return `GitHub: ${GITHUB_EVENTS[t.event]}${t.repo ? ` em ${t.repo}` : ""}`;
  if (t.kind === "jira") return t.preset && t.preset !== "custom" ? `Jira${t.project ? ` ${t.project}` : ""}: busca pronta` : t.jql.trim() ? `Jira: ${t.jql.trim()}` : "Jira: escreva a busca";
  if (t.kind === "slack") {
    const where = t.event === "channel" && t.channel ? ` #${t.channel.replace(/^#/, "")}` : t.event === "dm" && t.personName ? ` de ${t.personName}` : "";
    return `Slack: ${SLACK_EVENTS[t.event]}${where}`;
  }
  if (t.kind === "webhook") return "Webhook local";
  if (t.kind === "event") return describeEvent(t.event);
  if (t.kind === "interval") return t.minutes % 60 === 0 ? `A cada ${t.minutes / 60}h` : `A cada ${t.minutes} min`;
  const days = t.days.length === 7 ? "Todo dia" : [...t.days].sort().map((d) => DAY_NAMES[d]).join(", ");
  return `${days} às ${t.time}`;
}

export const GITHUB_EVENTS: Record<GithubEvent, string> = {
  pr_opened: "PR aberto",
  review_requested: "revisão pedida para você",
  ci_failed: "CI falhou",
  ci_passed: "CI passou",
  comment: "comentário novo",
  issue_assigned: "issue atribuída a você",
};

export const SLACK_EVENTS: Record<SlackEvent, string> = {
  mention: "menção a você",
  channel: "mensagem no canal",
  dm: "mensagem direta",
};

/** How an event trigger reads in the list. */
export function describeEvent(e: BeeEvent): string {
  switch (e.on) {
    case "stop":
      return "Quando uma sessão termina de responder";
    case "sessionEnd":
      return "Quando uma sessão é encerrada";
    case "tool":
      return `Depois de ${e.tool || "uma ferramenta"}${e.match ? ` com "${e.match}"` : ""}`;
    case "notification":
      return "Quando uma sessão espera você";
    case "subagentStop":
      return "Quando um subagente termina";
    case "beeDone": {
      const other = useStore.getState().bees.find((b) => b.id === e.beeId);
      return `Depois da worker bee ${other?.name ?? "removida"}`;
    }
    case "flowDone": {
      const other = useStore.getState().flows.find((f) => f.id === e.flowId);
      return `Depois do fluxo ${other?.name ?? "removido"}`;
    }
    case "usage":
      return `Quando o uso ${e.window === "session" ? "da sessão (5h)" : "semanal (7d)"} passa de ${e.percent}%`;
    case "appOpen":
      return "Quando o app abre";
  }
}

/**
 * When the usage window over its ceiling resets, or null when no ceiling holds
 * scheduled runs back. Usage last reported for a window already reset counts as reset.
 */
export function quotaResetAt(now: number): number | null {
  const { beeQuota, rateLimits } = useStore.getState();
  const over = (win: RateWindow | undefined, ceiling: number | null) =>
    ceiling !== null && win && win.resets_at * 1000 > now && win.used_percentage >= ceiling ? win.resets_at * 1000 : null;
  const resets = [over(rateLimits?.five_hour, beeQuota.session), over(rateLimits?.seven_day, beeQuota.weekly)].filter(
    (t): t is number => t !== null,
  );
  return resets.length ? Math.max(...resets) : null;
}

/** Called with a flow node's run once it ended, so the flow moves on. */
type FlowListener = (run: BeeRun) => void;
let flowListener: FlowListener | null = null;
export const onFlowRunEnded = (listener: FlowListener) => {
  flowListener = listener;
};

/** Records a run that ended badly, telling its flow. */
function failRun(run: BeeRun, summary: string): void {
  const done: BeeRun = { ...run, status: "error", endedAt: Date.now(), summary, read: false, tabId: null };
  useBeeRuns.getState().put(done);
  if (done.flowRunId) flowListener?.(done);
}

/** Starts a bee run by hand: its prompt, in a hidden tab, unless one of it is still going. */
export function runBee(bee: Bee, dir: string | null = null): Promise<void> {
  return runJob({
    key: bee.id,
    name: bee.name,
    prompt: bee.instructions.replace(PREVIOUS, "").trim() + REPLY_FORMAT,
    dir,
    worktree: !!bee.worktree,
    agent: "claude",
    beeId: bee.id,
  });
}

/** Starts a job in a hidden tab, or queues it while the most runs at once are going. */
export async function runJob(job: Job): Promise<void> {
  const store = useStore.getState();
  if (starting.has(job.key) || useBeeRuns.getState().runs.some((r) => r.status === "running" && keyOf(r) === job.key)) return;
  const { queued, setQueued } = useBeeRuns.getState();
  const max = store.beeMaxRunning;
  if (max !== null && runningCount() >= max) {
    if (!queued.some((q) => q.key === job.key)) setQueued([...queued, job]);
    return;
  }
  if (queued.some((q) => q.key === job.key)) setQueued(queued.filter((q) => q.key !== job.key));
  if (job.beeId) store.updateBee(job.beeId, { lastRunAt: Date.now() });
  starting.add(job.key);
  try {
    await startRun(job);
  } finally {
    starting.delete(job.key);
  }
}

/** Takes a job out of the queue. */
export function unqueue(key: string): void {
  const { queued, setQueued } = useBeeRuns.getState();
  setQueued(queued.filter((q) => q.key !== key));
}

/** Codex and OpenCode take their prompt once their process is up, by tab. */
const firstPrompt = new Map<string, { agent: Exclude<DroneAgent, "claude">; model: string | null; text: string }>();

async function startRun(job: Job): Promise<void> {
  const store = useStore.getState();
  const run: BeeRun = {
    id: crypto.randomUUID(),
    beeId: job.beeId,
    flowRunId: job.flowRunId,
    nodeId: job.nodeId,
    spec: job.spec,
    tabId: null,
    sessionId: null,
    startedAt: Date.now(),
    endedAt: null,
    status: "running",
    summary: null,
    dir: job.dir,
  };
  if (!job.prompt.trim()) return failRun(run, "Nada para rodar: o prompt está vazio.");
  // A bee still holding {{...}} parts would send the agent placeholders instead of a task.
  const bee = job.beeId ? store.bees.find((b) => b.id === job.beeId) : undefined;
  if (job.beeId && !bee) return failRun(run, "A worker bee foi removida.");
  if (bee && hasUnfilled(bee.instructions)) return failRun(run, "O prompt da worker bee ainda tem partes {{...}} para substituir.");
  if (job.agent === "claude") {
    // Without Claude Code ready there is nothing to run with.
    const checks = await invoke<Check[]>("connections_check").catch(() => []);
    const claude = checks.find((c) => c.id === "claude");
    if (!claude?.ok) {
      return failRun(run, `Claude Code não está pronto: ${claude?.detail ?? "não foi possível conferir."} Veja em Configurações › Conexões.`);
    }
  }
  let cwd: string;
  try {
    cwd = job.dir
      ? await invoke<string>("bee_prepare_dir", { beeId: job.beeId || job.nodeId || job.key, dir: job.dir, worktree: job.worktree })
      : await invoke<string>("bee_workdir");
  } catch (err) {
    return failRun(run, job.dir ? `Não consegui preparar a pasta ${job.dir}: ${err}` : "Não consegui criar a pasta onde as worker bees rodam.");
  }
  const opts = { title: job.name, customTitle: true, background: true, cwd };
  let tabId: string;
  if (job.agent === "claude") {
    tabId = store.addTab(BEE_GROUP_ID, opts);
    markPendingPrompt(tabId, job.prompt);
  } else {
    tabId = store.addTab(BEE_GROUP_ID, { ...opts, provider: job.agent });
    const model = job.spec?.model ?? null;
    if (model) useStore.getState().patchTab(tabId, { agentModel: model });
    firstPrompt.set(tabId, { agent: job.agent, model, text: job.prompt });
  }
  useBeeRuns.getState().put({ ...run, tabId, cwd });
}

/** Sends Codex and OpenCode runs their prompt once their session is up. */
function sendFirstPrompts(): void {
  if (!firstPrompt.size) return;
  const tabs = useStore.getState().tabs;
  for (const [tabId, first] of firstPrompt) {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) {
      firstPrompt.delete(tabId);
      continue;
    }
    if (!tab.agentSessionId || tab.state === "working" || tab.state === "dormant") continue;
    firstPrompt.delete(tabId);
    // Marked at once, so the turn's end is seen as one.
    useStore.getState().patchTab(tabId, { state: "working" });
    void invoke(agentCommand(first.agent, "send"), { tabId, text: first.text, model: first.model, images: [] }).catch((err) => {
      const run = runOfTab(tabId);
      if (run) stopBeeRun(run, `Não consegui mandar o prompt: ${err}`);
    });
  }
}

function lastAgentText(tabId: string): string {
  const entries = useAgentEntries.getState().byTab[tabId] ?? [];
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].kind === "text") return entries[i].text;
  return "";
}

/** Ends the run a bee tab holds, once its agent stops: keeps its reply and closes the tab. */
export async function finishBeeRun(tabId: string, reply?: string): Promise<void> {
  const run = useBeeRuns.getState().runs.find((r) => r.tabId === tabId && r.status === "running");
  if (!run) return;
  // A Codex or OpenCode tab reports ready before its prompt went out.
  if (firstPrompt.has(tabId)) return;
  const s = useStore.getState();
  const tab = s.tabs.find((t) => t.id === tabId);
  const bee = s.bees.find((b) => b.id === run.beeId);
  // The Stop event carries the last reply; the transcript may not have it written yet.
  const summary = reply?.trim()
    ? reply
    : tab?.provider
      ? lastAgentText(tabId) || null
      : tab?.transcriptPath
        ? await invoke<string | null>("session_last_reply", { path: tab.transcriptPath }).catch(() => null)
        : null;
  const done: BeeRun = {
    ...run,
    ...ended(tabId),
    status: "done",
    sessionId: tab?.claudeSessionId ?? tab?.agentSessionId ?? run.sessionId,
    summary,
    tabId: run.revealed ? tabId : null,
    // A flow's runs are read in the flow.
    read: run.flowRunId ? true : false,
  };
  useBeeRuns.getState().put(done);
  if (!run.revealed) s.closeTab(tabId);
  if (run.flowRunId) flowListener?.(done);
  else if (!run.attention) void notify(`Worker bee ${bee?.name ?? ""} terminou`, summary?.slice(0, 160) ?? "Sem resumo.", true);
  drainQueue();
}

/** Ends a run by hand, or when its agent is gone: the tab closes and the run is marked failed. */
export function stopBeeRun(run: BeeRun, reason = "Parada por você."): void {
  const tabId = run.tabId;
  if (tabId) firstPrompt.delete(tabId);
  const done: BeeRun = { ...run, ...ended(tabId), status: "error", tabId: null, summary: reason };
  useBeeRuns.getState().put(done);
  if (tabId && !run.revealed) useStore.getState().closeTab(tabId);
  if (done.flowRunId) flowListener?.(done);
  drainQueue();
}

/** A bee tab that went away before its agent stopped. */
export function dropBeeRun(tabId: string, reason: string): void {
  const run = useBeeRuns.getState().runs.find((r) => r.tabId === tabId && r.status === "running");
  if (!run) return;
  firstPrompt.delete(tabId);
  const done: BeeRun = { ...run, ...ended(tabId), status: "error", tabId: null, summary: reason };
  useBeeRuns.getState().put(done);
  if (done.flowRunId) flowListener?.(done);
  drainQueue();
}

/**
 * Shows a run's session in a normal tab: the hidden tab itself while it runs,
 * which then stays open, or the saved session once it ended.
 */
export function openBeeRun(run: BeeRun): void {
  const s = useStore.getState();
  const active = s.tabs.find((t) => t.id === s.activeTabId && t.groupId !== BEE_GROUP_ID);
  const groupId = active?.groupId ?? s.groups.find((g) => !g.fixed)?.id;
  const live = run.tabId ? s.tabs.find((t) => t.id === run.tabId) : undefined;
  if (live && groupId) {
    if (live.groupId === BEE_GROUP_ID) s.moveTab(live.id, groupId);
    s.activateTab(live.id);
    if (run.status === "running") useBeeRuns.getState().put({ ...run, revealed: true });
    return;
  }
  if (!run.sessionId) return;
  const bee = s.bees.find((b) => b.id === run.beeId);
  const title = bee?.name ?? run.spec?.name ?? "Worker bee";
  const agent = run.spec?.agent;
  // Claude finds a session by the folder it ran in.
  openSession({ id: run.sessionId, cwd: run.cwd ?? null, title, provider: agent && agent !== "claude" ? agent : undefined }, { groupId });
}

/** Keeps runs honest about their tabs and hands Codex and OpenCode runs their prompt. */
export function startBeeWatch(): () => void {
  // Only a running bee's tab sees the tools that read its state and call the user.
  let tabIds = "";
  const unsubscribeRuns = useBeeRuns.subscribe(({ runs }) => {
    const ids = runs.filter((r) => r.status === "running" && r.tabId).map((r) => r.tabId as string);
    if (ids.join() === tabIds) return;
    tabIds = ids.join();
    void invoke("bee_run_tabs", { ids }).catch(console.error);
  });
  const unsubscribeTabs = useStore.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs) sendFirstPrompts();
  });
  const tick = () => {
    const now = Date.now();
    // A run whose tab was closed or whose terminal ended before its agent stopped.
    const tabs = useStore.getState().tabs;
    for (const run of useBeeRuns.getState().runs) {
      if (run.status !== "running" || !run.tabId) continue;
      const tab = tabs.find((t) => t.id === run.tabId);
      if (!tab) dropBeeRun(run.tabId, "A aba foi fechada antes do fim.");
      else if (tab.state === "dormant") dropBeeRun(run.tabId, "O terminal fechou antes do fim.");
      // The agent never got going: no session after a couple of minutes.
      else if (!(tab.claudeSessionId ?? tab.agentSessionId) && now - run.startedAt > START_TIMEOUT_MS) {
        stopBeeRun(run, "O agente não iniciou. Abra a sessão pelo histórico do terminal para ver o erro.");
      }
    }
    drainQueue();
  };
  void useBeeRuns.getState().load().then(tick);
  const timer = setInterval(tick, TICK_MS);
  return () => {
    clearInterval(timer);
    unsubscribeRuns();
    unsubscribeTabs();
  };
}

/** Most a bee keeps between runs. */
const MAX_STATE = 16_000;

/** The tools a bee uses while it runs, answered for the run in tab `tabId`. */
export function callBeeRunTool(tool: string, args: Record<string, unknown>, tabId: string | null): { text: string; isError?: boolean } {
  const run = runOfTab(tabId);
  const s = useStore.getState();
  const bee = run && s.bees.find((b) => b.id === run.beeId);
  if (!run) return { text: "Esta sessão não é uma execução de worker bee.", isError: true };
  if (tool === "bee_needs_you") {
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!reason) return { text: "Informe o motivo em reason.", isError: true };
    useBeeRuns.getState().put({ ...run, attention: reason });
    void notify(`${bee?.name ?? run.spec?.name ?? "Worker bee"} precisa de você`, reason.slice(0, 160), true);
    return { text: "O usuário foi avisado. Termine a execução com o que já foi feito." };
  }
  if (!bee) return { text: "Só uma worker bee guarda estado entre execuções.", isError: true };
  if (tool === "bee_state_get") return { text: bee.state ?? "null" };
  if (tool === "bee_state_set") {
    const text = JSON.stringify(args.state ?? null);
    if (text.length > MAX_STATE) return { text: `O estado passa de ${MAX_STATE} caracteres; guarde só o essencial.`, isError: true };
    s.updateBee(bee.id, { state: text });
    return { text: "Estado salvo. A próxima execução lê com bee_state_get." };
  }
  return { text: `Ferramenta desconhecida: ${tool}`, isError: true };
}
