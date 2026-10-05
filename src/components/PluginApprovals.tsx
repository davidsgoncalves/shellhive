import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../lib/store";
import { PERMISSION_LABEL, type LocalPlugin } from "../lib/localPlugins";
import { pluginShortcutLabel } from "../lib/shortcuts";

/** Plugins waiting for approval that the user has not put off for this version of their files. */
export function pendingApprovals(list: LocalPlugin[], deferred: Record<string, string>): LocalPlugin[] {
  return list.filter((p) => p.status === "pending" && deferred[p.id] !== p.hash);
}

/** Shows what a new or changed local plugin will run, and nothing runs until approved. */
function ApprovalCard({ plugin }: { plugin: LocalPlugin }) {
  const deferApproval = useStore((s) => s.deferApproval);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("local_plugin_approve", { id: plugin.id, hash: plugin.hash });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="perm-item plugin-approval">
      <div className="perm-head">
        <span className="perm-tool">Plugin: {plugin.name}</span>
      </div>
      {plugin.description && <p className="question-text">{plugin.description}</p>}
      {plugin.tools.length > 0 && (
        <>
          <p className="plugin-approval-label">Programas que o agente vai poder rodar</p>
          {plugin.tools.map((t) => (
            <code key={t.name} className="perm-cmd" title={t.description}>
              {t.name}: {t.run.join(" ")}
            </code>
          ))}
        </>
      )}
      {plugin.panel && (
        <p className="plugin-approval-label">
          Painel "{plugin.panel.title}"
          {plugin.permissions.length > 0
            ? `, que pode ${plugin.permissions.map((p) => PERMISSION_LABEL[p] ?? p).join(", ")}`
            : ""}
        </p>
      )}
      {plugin.sidePanel && <p className="plugin-approval-label">Aba "{plugin.sidePanel.title}" na coluna da direita</p>}
      {plugin.menu.length > 0 && (
        <p className="plugin-approval-label">No menu das abas: {plugin.menu.map((m) => m.label).join(", ")}</p>
      )}
      {plugin.schedule.length > 0 && (
        <p className="plugin-approval-label">
          Roda sozinho: {plugin.schedule.map((j) => `${j.tool} a cada ${j.every}s`).join(", ")}
        </p>
      )}
      {plugin.view && <p className="plugin-approval-label">Vista "{plugin.view.title}" num espaço da tela dividida</p>}
      {plugin.window && <p className="plugin-approval-label">Janela própria "{plugin.window.title}"</p>}
      {plugin.band && (
        <p className="plugin-approval-label">
          Faixa {plugin.band.position === "top" ? "em cima" : "embaixo"} do terminal das abas que ele escolher
        </p>
      )}
      {plugin.shortcuts.length > 0 && (
        <p className="plugin-approval-label">
          Atalhos: {plugin.shortcuts.map((k) => `${pluginShortcutLabel(k.key)} (${k.tool ?? `abrir ${k.open}`})`).join(", ")}
        </p>
      )}
      {!plugin.panel && plugin.permissions.length > 0 && (
        <p className="plugin-approval-label">
          Pode {plugin.permissions.map((p) => PERMISSION_LABEL[p] ?? p).join(", ")}
        </p>
      )}
      <p className="hint">Roda com as suas permissões, a partir de {plugin.dir}.</p>
      {error && <p className="error">{error}</p>}
      <div className="perm-actions">
        <button className="deny" onClick={() => deferApproval(plugin.id, plugin.hash)}>
          Agora não
        </button>
        <button className="allow" disabled={busy} onClick={() => void approve()}>
          Aprovar
        </button>
      </div>
    </li>
  );
}

export function PluginApprovals() {
  const localPlugins = useStore((s) => s.localPlugins);
  const deferred = useStore((s) => s.deferredApprovals);
  return (
    <>
      {pendingApprovals(localPlugins, deferred).map((p) => (
        <ApprovalCard key={`${p.id}-${p.hash}`} plugin={p} />
      ))}
    </>
  );
}
