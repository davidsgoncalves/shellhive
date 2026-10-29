import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { markPendingPrompt } from "./restored";

/** The group plugin-creation sessions open in, made on first use. */
const GROUP_NAME = "Plugins";

/** The first message of a plugin-creation session. */
function firstPrompt(folder: string, idea: string): string {
  const guide = `${folder}/GUIDE.md`;
  const ask = idea
    ? `O usuário quer um plugin que faça isto:\n\n${idea}\n\nSe faltar algo para montar o plugin, pergunte uma coisa por vez antes de escrever.`
    : "Comece perguntando o que o plugin deve fazer.";
  return `Esta é a sessão de criação de plugins do Shellhive. Leia antes o guia em ${guide} e crie o plugin nesta pasta seguindo o guia.

${ask}

Quando terminar, diga que o plugin aparece na Fila para aprovação e depois em Plugins › Seus plugins para ligar.`;
}

/** Opens a session in the plugins folder, in the Plugins group, to make a plugin with Claude. */
export async function openPluginCreator(idea: string): Promise<void> {
  const folder = await invoke<string | null>("local_plugins_folder");
  if (!folder) return;
  const s = useStore.getState();
  const groupId = s.groups.find((g) => !g.fixed && g.name === GROUP_NAME)?.id ?? s.addGroup(GROUP_NAME);
  const id = useStore.getState().addTab(groupId, { cwd: folder, title: "Criar plugin", customTitle: true });
  markPendingPrompt(id, firstPrompt(folder, idea.trim()));
  // The new session takes the center from the plugins screen.
  s.setPanelTab(s.layout === "sidebar" ? "tabs" : "queue");
}
