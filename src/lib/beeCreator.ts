import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { markPendingPrompt } from "./restored";
import { describeTrigger, runBee } from "./bees";
import type { ToolReply } from "./plugins";
import type { Bee, BeeTrigger } from "./types";

/** The first message of a bee-creation session: what bees are and how to make one. */
const GUIDE = `Esta é a sessão de criação de abelhas do Worker bee do Shellhive. Ajude o usuário a montar uma abelha e crie com a ferramenta create_bee.

Uma abelha é uma rotina que o Shellhive roda numa sessão do Claude escondida, sem ninguém acompanhando:
- Tipo "free": roda o prompt escrito em instructions, nos repositórios escolhidos. Exemplos: limpar worktrees de branches mergeadas, resumir os PRs abertos do time.
- Tipo "review": revisa os PRs que pedem a revisão do usuário nos repositórios escolhidos, publica só os problemas e nunca aprova. Em instructions vai só o jeito do usuário revisar, como acréscimo ao método pronto.
- Repositórios: só os da lista do Shellhive, que list_bees mostra.
- Quando roda: manual, a cada intervalo em minutos, ou em dias da semana e horário. Só roda com o app aberto; um horário perdido com o app fechado roda uma vez ao abrir (padrão) ou é pulado.

Como conduzir:
1. Chame list_bees para ver as abelhas que já existem e os repositórios disponíveis.
2. Pergunte o que a abelha deve fazer, em quais repositórios e quando, uma coisa por vez e sem se estender.
3. Escreva o prompt da abelha livre como uma tarefa autônoma: ela roda sem poder perguntar nada.
4. Antes de criar, mostre um resumo (nome, tipo, repositórios, quando roda, horário perdido, prompt) e peça confirmação.
5. A abelha nasce desligada. Depois de criar, diga que ela está no painel do Worker bee para conferir e ligar, e ofereça rodar uma vez agora com run_bee.

Comece perguntando o que a abelha deve fazer.`;

/** Opens the session that creates bees with Claude, in the active tab's group. */
export function openBeeCreator(): void {
  const s = useStore.getState();
  const active = s.tabs.find((t) => t.id === s.activeTabId);
  const groupId = active?.groupId ?? s.groups.find((g) => !g.fixed)?.id ?? s.groups[0]?.id;
  if (!groupId) return;
  const id = s.addTab(groupId, { title: "Criar abelha", customTitle: true, beeCreator: true });
  syncBeeCreators();
  markPendingPrompt(id, GUIDE);
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
    const bees = s.bees.map((b) => ({
      id: b.id,
      name: b.name,
      template: b.template,
      enabled: b.enabled,
      repos: b.repos,
      trigger: describeTrigger(b.trigger),
    }));
    const repos = s.repos.map((r) => ({ repo: r.slug, folder: r.path }));
    return { text: JSON.stringify({ bees, repos }, null, 2) };
  }
  if (tool === "run_bee") {
    const bee = s.bees.find((b) => b.id === args.id);
    if (!bee) return { text: "Abelha não encontrada; veja os ids em list_bees.", isError: true };
    void runBee(bee);
    return { text: `A abelha ${bee.name} começou a rodar; o resultado aparece no painel do Worker bee.` };
  }
  if (tool === "create_bee") {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const template = args.template === "review" ? "review" : args.template === "free" ? "free" : null;
    const instructions = typeof args.instructions === "string" ? args.instructions.trim() : "";
    const repos = Array.isArray(args.repos) ? args.repos.filter((r): r is string => typeof r === "string") : [];
    const unknown = repos.filter((r) => !s.repos.some((x) => x.slug === r));
    const trigger = parseTrigger(args.trigger);
    if (!name) return { text: "Informe o nome.", isError: true };
    if (!template) return { text: 'template deve ser "free" ou "review".', isError: true };
    if (template === "free" && !instructions) return { text: "Uma abelha free precisa do prompt em instructions.", isError: true };
    if (template === "review" && !repos.length) return { text: "A abelha de review precisa de ao menos um repositório.", isError: true };
    if (unknown.length) return { text: `Fora da lista de repositórios: ${unknown.join(", ")}. Veja em list_bees.`, isError: true };
    if (typeof trigger === "string") return { text: trigger, isError: true };
    const bee: Bee = {
      id: crypto.randomUUID(),
      name,
      template,
      instructions,
      repos,
      trigger,
      missed: args.missed === "skip" ? "skip" : "run",
      enabled: false,
      createdAt: Date.now(),
      lastRunAt: null,
    };
    s.addBee(bee);
    return { text: `Abelha criada, desligada: ${name} (id ${bee.id}). O usuário confere e liga no painel do Worker bee.` };
  }
  return { text: `Ferramenta desconhecida: ${tool}`, isError: true };
}
