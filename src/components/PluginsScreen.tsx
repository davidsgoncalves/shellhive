import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../lib/store";
import { PLUGINS } from "../lib/plugins";
import type { LocalPlugin } from "../lib/localPlugins";

/** One entry of the plugins screen, official or the user's own. */
interface Entry {
  id: string;
  name: string;
  description: string;
  local: LocalPlugin | null;
}

function useEntries(): { official: Entry[]; own: Entry[] } {
  const localPlugins = useStore((s) => s.localPlugins);
  return {
    official: PLUGINS.map(({ manifest }) => ({ ...manifest, local: null })),
    own: localPlugins.map((p) => ({ id: p.id, name: p.name, description: p.description, local: p })),
  };
}

/** The plugin shown in the center: the one picked, else the first. */
function useShownPlugin(): Entry | null {
  const { official, own } = useEntries();
  const view = useStore((s) => s.pluginView);
  const all = [...official, ...own];
  return all.find((e) => e.id === view) ?? all[0] ?? null;
}

const LOCAL_STATUS: Record<LocalPlugin["status"], string> = {
  approved: "",
  pending: "aguardando aprovação",
  invalid: "com erro",
};

/** The side panel: official plugins, then the user's own. */
export function PluginsPanel() {
  const { official, own } = useEntries();
  const enabled = useStore((s) => s.enabledPlugins);
  const setPluginView = useStore((s) => s.setPluginView);
  const shown = useShownPlugin();
  const [folder, setFolder] = useState<string | null>(null);
  useEffect(() => {
    void invoke<string | null>("local_plugins_folder").then(setFolder);
  }, []);

  const row = (e: Entry) => {
    const on = enabled.includes(e.id) && (!e.local || e.local.status === "approved");
    const status = e.local ? LOCAL_STATUS[e.local.status] : "";
    return (
      <li
        key={e.id}
        className={`bee-row ${shown?.id === e.id ? "on" : ""} ${on ? "" : "off"}`}
        onClick={() => setPluginView(e.id)}
      >
        <span className="bee-row-main">
          <span className="bee-name">{e.name}</span>
          <span className="bee-meta">{status || (on ? "ligado" : "desligado")}</span>
        </span>
        {on && <span className="bee-run-dot" />}
      </li>
    );
  };

  return (
    <div className="bee-panel">
      <section>
        <h4>Oficiais</h4>
        <ul className="bee-list">{official.map(row)}</ul>
      </section>
      <section>
        <h4>Seus plugins</h4>
        {own.length === 0 ? (
          <p className="hint">Nenhum plugin seu ainda.</p>
        ) : (
          <ul className="bee-list">{own.map(row)}</ul>
        )}
      </section>
      {folder && (
        <button className="ghost auto" onClick={() => void invoke("link_open", { target: folder, cwd: null })}>
          Abrir pasta de plugins
        </button>
      )}
    </div>
  );
}

/** The plugins screen in place of the terminals: the picked plugin and its switch. */
export function PluginsMain() {
  const shown = useShownPlugin();
  const { enabledPlugins, setPluginEnabled } = useStore();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setConfirming(false);
    setError(null);
  }, [shown?.id]);
  if (!shown) return <div className="bee-main" />;

  const local = shown.local;
  const on = enabledPlugins.includes(shown.id);
  const canSwitch = !local || local.status === "approved";
  const remove = async () => {
    if (!local) return;
    if (!confirming) return setConfirming(true);
    try {
      await invoke("local_plugin_remove", { id: local.id });
    } catch (err) {
      setError(String(err));
      setConfirming(false);
    }
  };

  return (
    <div className="bee-main">
      <div className="bee-detail">
        <header className="bee-detail-head">
          <div>
            <h2>{shown.name}</h2>
            <p className="hint">{local ? "Plugin seu, da pasta de plugins" : "Plugin oficial, vem com o Shellhive"}</p>
          </div>
          {canSwitch && (
            <div className="chip-row">
              <button className={`chip ${on ? "on" : ""}`} onClick={() => setPluginEnabled(shown.id, true)}>
                Ligado
              </button>
              <button className={`chip ${!on ? "on" : ""}`} onClick={() => setPluginEnabled(shown.id, false)}>
                Desligado
              </button>
            </div>
          )}
        </header>
        <div className="bee-detail-body">
          {shown.description && <p>{shown.description}</p>}
          {local?.status === "pending" && <p className="hint">Aguardando aprovação na Fila. Depois de aprovado, pode ser ligado aqui.</p>}
          {local?.status === "invalid" && <p className="error">{local.error}</p>}
          {error && <p className="error">{error}</p>}
          <p className="hint">
            Uma mudança vale para as sessões abertas depois dela; nas que já estão abertas, reabra a aba.
          </p>
          {!local && (
            <p className="hint">
              Para criar um plugin seu, peça ao Claude: ele lê o guia na pasta de plugins e escreve os arquivos. Um
              plugin novo ou alterado aparece na Fila para você aprovar.
            </p>
          )}
          {local && (
            <div className="row">
              <button className={`ghost auto ${confirming ? "danger" : ""}`} onClick={() => void remove()}>
                {confirming ? "Apagar a pasta?" : "Remover"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
