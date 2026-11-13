import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { markPendingPrompt } from "./restored";
import { describeTrigger, runBee } from "./bees";
import type { ToolReply } from "./plugins";
import type { Bee, BeeTrigger, PathCheck } from "./types";
import { PLACEHOLDER, TEMPLATES } from "./beeTemplates";

const MODES = ["manual", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"];

/** The first message of a bee-creation session: what bees are and how to make one. */
const GUIDE = `Esta é a sessão de criação de worker bees do Shellhive. Ajude o usuário a montar uma worker bee e crie com a ferramenta create_bee.

Uma worker bee é um prompt que o Shellhive roda numa sessão do Claude escondida, sem ninguém acompanhando, na hora marcada. O prompt é tudo o que ela sabe: tarefa, pastas e repositórios, regras e o que responder no fim. Ela não pode fazer perguntas enquanto roda.

Quando roda: manual, a cada intervalo em minutos, ou em dias da semana e horário. Só roda com o app aberto; um horário perdido com o app fechado roda uma vez ao abrir (padrão) ou é pulado.

Onde roda: a worker bee é genérica e não tem pasta própria. Quem pede a execução diz a pasta: o usuário ao rodar, a sessão que disparou o evento, ou a worker bee anterior numa cadeia. Por agenda ou intervalo, roda numa pasta vazia só das worker bees, então o prompt diz onde trabalhar. Com worktree, uma execução que recebe um repositório trabalha numa worktree nova dele, sem tocar na cópia do usuário. Permissões: permissionMode e allowedTools (regras do Claude Code, como "Bash(gh pr:*)") liberam o que a worker bee faz sem perguntar; o resto espera o usuário aprovar.

Enquanto roda, a worker bee tem três ferramentas, que o prompt pode mandar usar: bee_state_get e bee_state_set guardam um JSON de uma execução para a outra (o que já tentou, o que já viu), e bee_needs_you avisa o usuário quando ela não consegue seguir sem ele.

Há templates prontos que você pode usar de base com list_bees (campo templates): troque cada {{...}} pelo conteúdo do usuário.

Como conduzir:
1. Chame list_bees para ver as worker bees que já existem e os templates.
2. Pergunte o que a worker bee deve fazer, quando e o que ela pode fazer sem perguntar, uma coisa por vez e sem se estender.
3. Escreva o prompt completo, autônomo, com as pastas e repositórios escritos nele, sem nenhum {{...}} sobrando.
4. Antes de criar, mostre o resumo (nome, quando roda, horário perdido, worktree, permissões) e o prompt inteiro, e peça confirmação.
5. A worker bee nasce desligada. Depois de criar, diga que ela está no painel do Worker bee para conferir e ligar, e ofereça rodar uma vez agora com run_bee.

Comece perguntando o que a worker bee deve fazer.`;

/** Opens the session that creates bees with Claude, in the active tab's group. */
export function openBeeCreator(): void {
  const s = useStore.getState();
  const active = s.tabs.find((t) => t.id === s.activeTabId);
  const groupId = active?.groupId ?? s.groups.find((g) => !g.fixed)?.id ?? s.groups[0]?.id;
  if (!groupId) return;
  const id = s.addTab(groupId, { title: "Criar worker bee", customTitle: true, beeCreator: true });
  syncBeeCreators();
  markPendingPrompt(id, GUIDE);
  // The new session takes the center from the Worker bee.
  s.setPanelTab(s.layout === "sidebar" ? "tabs" : "queue");
}

/** Tells the MCP server which tabs create bees, so only they see the bee tools. */
export function syncBeeCreators(): void {
  const ids = useStore.getState().tabs.filter((t) => t.beeCreator).map((t) => t.id);
  void invoke("bee_creator_tabs", { ids }).catch(console.error);
}

function parseTrigger(raw: unknown): BeeTrigger | string {
  const t = (raw ?? {}) as Record<string, unknown>;
  if (t.kind === "manual") return { kind: "manual" };
  if (t.kind === "interval") {
    const minutes = Number(t.minutes);
    return minutes >= 5 ? { kind: "interval", minutes: Math.round(minutes) } : "O intervalo precisa ter ao menos 5 minutos.";
  }
  if (t.kind === "schedule") {
    const days = Array.isArray(t.days) ? t.days.map(Number).filter((d) => d >= 0 && d <= 6) : [];
    const time = typeof t.time === "string" && /^\d{2}:\d{2}$/.test(t.time) ? t.time : null;
    if (!days.length || !time) return "Informe days (0 a 6) e time no formato HH:MM.";
    return { kind: "schedule", days: [...new Set(days)], time };
  }
  return 'trigger.kind deve ser "manual", "interval" ou "schedule".';
}

/** The bee tools, answered by the interface. */
export async function callBeeTool(tool: string, args: Record<string, unknown>): Promise<ToolReply> {
  const s = useStore.getState();
  if (tool === "list_bees") {
    const bees = s.bees.map((b) => ({ id: b.id, name: b.name, enabled: b.enabled, trigger: describeTrigger(b.trigger) }));
    const templates = TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, prompt: t.prompt }));
    return { text: JSON.stringify({ bees, templates }, null, 2) };
  }
  if (tool === "run_bee") {
    const bee = s.bees.find((b) => b.id === args.id);
    if (!bee) return { text: "Worker bee não encontrada; veja os ids em list_bees.", isError: true };
    let dir: string | null = null;
    if (typeof args.cwd === "string" && args.cwd.trim()) {
      const check = await invoke<PathCheck>("path_check", { path: args.cwd.trim() }).catch(() => null);
      if (!check?.exists || !check.is_dir) return { text: `Pasta não encontrada: ${args.cwd}`, isError: true };
      dir = check.expanded;
    }
    void runBee(bee, dir);
    return { text: `A worker bee ${bee.name} começou a rodar; o resultado aparece no painel do Worker bee.` };
  }
  if (tool === "create_bee") {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    const trigger = parseTrigger(args.trigger);
    if (!name) return { text: "Informe o nome.", isError: true };
    if (!prompt) return { text: "Informe o prompt da worker bee.", isError: true };
    if (PLACEHOLDER.test(prompt)) return { text: "O prompt ainda tem partes {{...}}; troque pelo conteúdo do usuário.", isError: true };
    if (typeof trigger === "string") return { text: trigger, isError: true };
    const templateId = TEMPLATES.some((t) => t.id === args.template) ? String(args.template) : undefined;
    const mode = typeof args.permissionMode === "string" && MODES.includes(args.permissionMode) ? args.permissionMode : null;
    const allowedTools = Array.isArray(args.allowedTools) ? args.allowedTools.filter((r): r is string => typeof r === "string" && !!r.trim()) : [];
    const bee: Bee = {
      id: crypto.randomUUID(),
      name,
      instructions: prompt,
      templateId,
      trigger,
      missed: args.missed === "skip" ? "skip" : "run",
      enabled: false,
      createdAt: Date.now(),
      lastRunAt: null,
      worktree: args.worktree === true,
      permissionMode: mode,
      allowedTools,
    };
    s.addBee(bee);
    return { text: `Worker bee criada, desligada: ${name} (id ${bee.id}). O usuário confere e liga no painel do Worker bee.` };
  }
  return { text: `Ferramenta desconhecida: ${tool}`, isError: true };
}
