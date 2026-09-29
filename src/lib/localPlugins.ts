/** A plugin the user made, found in the plugins folder of the data dir. */
export interface LocalPlugin {
  id: string;
  name: string;
  description: string;
  status: "approved" | "pending" | "invalid";
  error: string | null;
  /** Fingerprint of its files; approving ties the approval to it. */
  hash: string;
  dir: string;
  tools: Array<{ name: string; description: string; run: string[] }>;
  panel: { title: string } | null;
  permissions: string[];
}

/** A plugin panel on screen, over the pane of the tab it belongs to. */
export interface PluginPanel {
  plugin: string;
  tabId: string | null;
  /** What a tool sent along with its reply; null when opened from the menu. */
  data: unknown;
}

export const PERMISSION_LABEL: Record<string, string> = {
  tab: "ver a aba e a pasta dela",
  tools: "chamar as próprias ferramentas",
  prompt: "escrever no prompt do agente",
  storage: "guardar dados próprios",
  events: "ver o que o agente faz em cada aba (arquivos e comandos)",
};
