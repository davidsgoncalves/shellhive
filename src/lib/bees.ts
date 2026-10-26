import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { openSession, useStore } from "./store";
import { markPendingPrompt } from "./restored";
import { notify } from "./notify";
import type { Check } from "./connections";
import { BEE_GROUP_ID, type Bee, type BeeRun, type BeeTrigger } from "./types";
import { PLACEHOLDER } from "./beeTemplates";

/** Runs kept per bee, newest first. */
const KEEP_RUNS = 20;
/** How often the schedule is looked at. */
const TICK_MS = 30_000;
const DAY_MS = 86_400_000;
/** How long a run's Claude has to start before the run counts as failed. */
const START_TIMEOUT_MS = 2 * 60_000;

export const DAY_NAMES = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

interface RunStore {
  runs: BeeRun[];
  loaded: boolean;
  load: () => Promise<void>;
  /** Adds a run or replaces the one with its id. */
  put: (run: BeeRun) => void;
}

const saveRuns = (runs: BeeRun[]) =>
  invoke("bee_runs_set", { value: { runs } }).catch((err) => console.error("bee runs save failed", err));

/** Every bee's recent runs, kept across restarts. */
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
    const others = get().runs.filter((r) => r.id !== run.id);
    const mine = [run, ...others.filter((r) => r.beeId === run.beeId)]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, KEEP_RUNS);
    const runs = [...mine, ...others.filter((r) => r.beeId !== run.beeId)].sort((a, b) => b.startedAt - a.startedAt);
    set({ runs });
    void saveRuns(runs);
  },
}));

export const runningRun = (beeId: string) =>
  useBeeRuns.getState().runs.find((r) => r.beeId === beeId && r.status === "running");

/** How a trigger reads in the list. */
export function describeTrigger(t: BeeTrigger): string {
  if (t.kind === "manual") return "Só manual";
  if (t.kind === "interval") return t.minutes % 60 === 0 ? `A cada ${t.minutes / 60}h` : `A cada ${t.minutes} min`;
  const days = t.days.length === 7 ? "Todo dia" : [...t.days].sort().map((d) => DAY_NAMES[d]).join(", ");
  return `${days} às ${t.time}`;
}

/** The latest moment at or before `now` the schedule asks for a run. */
function latestSlot(t: Extract<BeeTrigger, { kind: "schedule" }>, now: number): number | null {
  const [h, m] = t.time.split(":").map(Number);
  for (let back = 0; back <= 7; back++) {
    const day = new Date(now - back * DAY_MS);
    day.setHours(h, m, 0, 0);
    if (day.getTime() <= now && t.days.includes(day.getDay())) return day.getTime();
  }
  return null;
}

/** When a bee is due, the time it was due at; null when it is not. */
function dueAt(bee: Bee, now: number): number | null {
  const last = bee.lastRunAt ?? bee.createdAt;
  if (bee.trigger.kind === "interval") {
    const at = last + bee.trigger.minutes * 60_000;
    return at <= now ? at : null;
  }
  if (bee.trigger.kind === "schedule") {
    const slot = latestSlot(bee.trigger, now);
    return slot !== null && slot > last ? slot : null;
  }
  return null;
}

/** Records a run that could not start, unless the last one failed the same way. */
function fail(run: BeeRun, summary: string): void {
  const last = useBeeRuns.getState().runs.find((r) => r.beeId === run.beeId);
  if (last?.status === "error" && last.summary === summary) return;
  useBeeRuns.getState().put({ ...run, status: "error", endedAt: Date.now(), summary });
}

/** Starts a run of a bee: its prompt, in a hidden tab, unless a run of it is still going. */
export async function runBee(bee: Bee): Promise<void> {
  const store = useStore.getState();
  store.updateBee(bee.id, { lastRunAt: Date.now() });
  if (runningRun(bee.id)) return;
  const run: BeeRun = {
    id: crypto.randomUUID(),
    beeId: bee.id,
    tabId: null,
    sessionId: null,
    startedAt: Date.now(),
    endedAt: null,
    status: "running",
    summary: null,
  };
  // A prompt still holding {{...}} parts would send Claude placeholders instead of a task.
  if (!bee.instructions.trim()) return fail(run, "A worker bee não tem prompt. Use Editar para escrever.");
  if (PLACEHOLDER.test(bee.instructions)) return fail(run, "O prompt ainda tem partes {{...}} para substituir. Use Editar.");
  // Without Claude Code ready there is nothing to run the bee with.
  const checks = await invoke<Check[]>("connections_check").catch(() => []);
  const claude = checks.find((c) => c.id === "claude");
  if (!claude?.ok) {
    return fail(run, `Claude Code não está pronto: ${claude?.detail ?? "não foi possível conferir."} Veja em Configurações › Conexões.`);
  }
  const cwd = await invoke<string>("bee_workdir").catch(() => null);
  if (!cwd) return fail(run, "Não consegui criar a pasta onde as worker bees rodam.");
  const tabId = store.addTab(BEE_GROUP_ID, { title: bee.name, customTitle: true, background: true, cwd });
  markPendingPrompt(tabId, bee.instructions);
  useBeeRuns.getState().put({ ...run, tabId, cwd });
}

/** Ends the run a bee tab holds, once Claude stops: keeps its reply and closes the tab. */
export async function finishBeeRun(tabId: string): Promise<void> {
  const run = useBeeRuns.getState().runs.find((r) => r.tabId === tabId && r.status === "running");
  if (!run) return;
  const s = useStore.getState();
  const tab = s.tabs.find((t) => t.id === tabId);
  const bee = s.bees.find((b) => b.id === run.beeId);
  const summary = tab?.transcriptPath
    ? await invoke<string | null>("session_last_reply", { path: tab.transcriptPath }).catch(() => null)
    : null;
  useBeeRuns.getState().put({
    ...run,
    status: "done",
    endedAt: Date.now(),
    sessionId: tab?.claudeSessionId ?? run.sessionId,
    summary,
    tabId: run.revealed ? tabId : null,
  });
  if (!run.revealed) s.closeTab(tabId);
  void notify(`Worker bee ${bee?.name ?? ""} terminou`, summary?.slice(0, 160) ?? "Sem resumo.", true);
}

/** Ends a run by hand, or when its Claude is gone: the tab closes and the run is marked failed. */
export function stopBeeRun(run: BeeRun, reason = "Parada por você."): void {
  const tabId = run.tabId;
  useBeeRuns.getState().put({ ...run, status: "error", endedAt: Date.now(), tabId: null, summary: reason });
  if (tabId && !run.revealed) useStore.getState().closeTab(tabId);
}

/** A bee tab that went away before Claude stopped. */
export function dropBeeRun(tabId: string, reason: string): void {
  const run = useBeeRuns.getState().runs.find((r) => r.tabId === tabId && r.status === "running");
  if (!run) return;
  useBeeRuns.getState().put({ ...run, status: "error", endedAt: Date.now(), tabId: null, summary: reason });
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
  // Claude finds a session by the folder it ran in.
  openSession({ id: run.sessionId, cwd: run.cwd ?? null, title: bee?.name ?? "Worker bee" }, { groupId });
}

/** Runs the enabled bees when due; one missed while the app was closed follows the bee's setting. */
export function startBeeScheduler(): () => void {
  const launchedAt = Date.now();
  const tick = async () => {
    await useBeeRuns.getState().load();
    const now = Date.now();
    // A run whose tab was closed or whose terminal ended before Claude stopped.
    const tabs = useStore.getState().tabs;
    for (const run of useBeeRuns.getState().runs) {
      if (run.status !== "running" || !run.tabId) continue;
      const tab = tabs.find((t) => t.id === run.tabId);
      if (!tab) dropBeeRun(run.tabId, "A aba foi fechada antes do fim.");
      else if (tab.state === "dormant") dropBeeRun(run.tabId, "O terminal fechou antes do fim.");
      // Claude never got going: no session after a couple of minutes.
      else if (!tab.claudeSessionId && now - run.startedAt > START_TIMEOUT_MS) {
        stopBeeRun(run, "O Claude não iniciou. Abra a sessão pelo histórico do terminal para ver o erro.");
      }
    }
    for (const bee of useStore.getState().bees) {
      if (!bee.enabled) continue;
      const at = dueAt(bee, now);
      if (at === null) continue;
      if (at < launchedAt && bee.missed === "skip") useStore.getState().updateBee(bee.id, { lastRunAt: now });
      else void runBee(bee);
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  return () => clearInterval(timer);
}
