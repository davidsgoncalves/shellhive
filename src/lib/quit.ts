import { ask } from "@tauri-apps/plugin-dialog";
import { useStore } from "./store";
import type { Tab } from "./types";

/**
 * Tabs whose Claude is in the middle of something a restart would cut off:
 * a turn still running, a permission it waits on, or subagents it left
 * running in the background.
 */
export function busyTabs(): Tab[] {
  const s = useStore.getState();
  return s.tabs.filter(
    (t) => t.state === "working" || t.state === "permission" || (s.subagentsByTab[t.id]?.length ?? 0) > 0,
  );
}

/**
 * Asks before closing or restarting the app while a tab is busy, since the
 * sessions come back with `--resume` but the work in progress does not.
 * True when nothing is running or the user agrees.
 */
export async function confirmQuit(action: "close" | "restart"): Promise<boolean> {
  const busy = busyTabs();
  if (busy.length === 0) return true;
  const verb = action === "close" ? "Fechar" : "Reiniciar";
  const names = busy.map((t) => `• ${t.title}`).join("\n");
  const count = busy.length === 1 ? "Uma aba ainda está trabalhando" : `${busy.length} abas ainda estão trabalhando`;
  return ask(
    `${count}:\n${names}\n\n${verb} o Shellhive interrompe esse trabalho. ` +
      "As conversas voltam ao reabrir, mas o que estava em andamento não continua sozinho.",
    { title: "Sessões em andamento", kind: "warning", okLabel: `${verb} mesmo assim`, cancelLabel: "Cancelar" },
  );
}
