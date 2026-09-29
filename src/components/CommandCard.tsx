import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../lib/store";
import { looksDestructive } from "../lib/describe";
import type { CommandSuggestion } from "../lib/types";
import { submit, typeText } from "../lib/typing";

/** Types into Claude's prompt as `! command` and runs it. */
export async function typeCommand(tabId: string, command: string): Promise<void> {
  // "!" on an empty prompt switches Claude Code to shell mode; it has to land
  // on its own, or it is read as part of a paste.
  await invoke("pty_write", { id: tabId, data: "!" });
  await new Promise((r) => setTimeout(r, 150));
  await typeText(tabId, command);
  await submit(tabId);
}

/**
 * A command Claude asked the user to run; it only runs on a click. Clicked
 * while Claude is still working, it waits and runs once the session is idle.
 */
export function CommandCard({ item, overlay = false }: { item: CommandSuggestion; overlay?: boolean }) {
  const { tabs, activateTab, dropCommand, setCommandQueued } = useStore();
  const [running, setRunning] = useState(false);
  const tab = tabs.find((t) => t.id === item.tab_id);
  const risky = looksDestructive("Bash", { command: item.command });
  // Typing while Claude works would land in the middle of its turn.
  const ready = tab?.state === "waiting";
  const live = !!tab && tab.state !== "dormant";

  const run = async () => {
    if (!tab) return;
    if (!ready) return setCommandQueued(item.id, true);
    setRunning(true);
    await typeCommand(tab.id, item.command).catch(() => {});
    dropCommand(item.id);
  };

  return (
    <li className={`perm-item command ${risky ? "risky" : ""} ${overlay ? "overlay" : ""}`}>
      <div className="perm-head">
        <span className="perm-tool">Comando</span>
        {risky && <span className="risk-tag" title="Padrão destrutivo detectado">risco</span>}
      </div>
      {item.reason && <p className="question-text">{item.reason}</p>}
      <code className="perm-cmd" title={item.command}>
        {item.command}
      </code>
      <div className="perm-meta">
        <button className="link" onClick={() => tab && activateTab(tab.id)} title="Ir para a aba">
          {tab?.title ?? "aba fechada"}
        </button>
      </div>
      {item.queued && <p className="command-queued">Agendado: roda assim que o Claude terminar a resposta.</p>}
      <div className="perm-actions">
        <button className="deny" onClick={() => dropCommand(item.id)}>
          Descartar
        </button>
        {item.queued ? (
          <button className="ask" onClick={() => setCommandQueued(item.id, false)}>
            Cancelar agendamento
          </button>
        ) : (
          <button
            className="allow"
            disabled={!live || running}
            onClick={() => void run()}
            title={ready ? "Roda nesta sessão como ! comando" : "Roda assim que o Claude terminar a resposta"}
          >
            {running ? "Executando…" : ready ? "Executar" : "Executar quando terminar"}
          </button>
        )}
      </div>
    </li>
  );
}
