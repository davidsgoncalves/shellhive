import { useEffect } from "react";
import { Announcements } from "./Announcements";
import { openSurface } from "../lib/pluginEffects";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "../lib/store";
import { SPLIT_MODES, isHiddenTab, type TabState } from "../lib/types";
import { shortcutLabel } from "../lib/shortcuts";
import logo from "../assets/logo.png";
import { ProcessesButton } from "./ProcessesPopup";

/** Vite sets this only on the dev server, so a packaged build never shows it. */
const IS_DEV = import.meta.env.DEV;
const APP_NAME = IS_DEV ? "ShellHive - dev" : "ShellHive";

const COUNTED: Array<{ state: TabState; label: string }> = [
  { state: "working", label: "trabalhando" },
  { state: "permission", label: "permissão" },
  { state: "waiting", label: "aguardando" },
];

export function TopBar() {
  const { tabs, activeTabId, statusByTab, openModal, splitMode, setSplitMode, barPosition } = useStore();

  useEffect(() => {
    void getCurrentWindow().setTitle(APP_NAME);
  }, []);
  // The Colony takes the center: the sessions' counts and the split do not apply there.
  const colony = useStore((s) => s.panelOpen && s.panelTab === "colony");
  const active = tabs.find((t) => t.id === activeTabId);
  const activeStatus = active ? statusByTab[active.id] : undefined;

  const totalCost = Object.values(statusByTab).reduce((sum, s) => sum + (s.cost?.total_cost_usd ?? 0), 0);
  const liveSessions = tabs.filter(
    (t) => t.claudeSessionId && t.state !== "dormant" && t.state !== "shell" && !isHiddenTab(t),
  ).length;

  return (
    <header className={`topbar ${barPosition === "bottom" ? "at-bottom" : ""}`}>
      <div className={`brand ${IS_DEV ? "dev" : ""}`}>
        <img className="brand-logo" src={logo} alt="" />
        <span>
          Shell<span className="brand-hive">Hive</span>
          {IS_DEV && " - dev"}
        </span>
      </div>

      {!colony && (
        <>
          <div className="counts">
            {COUNTED.map(({ state, label }) => {
              const n = tabs.filter((t) => t.state === state && !isHiddenTab(t)).length;
              return (
                <span key={state} className={`count-chip ${n ? "" : "zero"}`} title={label}>
                  <span className={`dot state-${state}`} />
                  {n}
                </span>
              );
            })}
            <span className="muted">{liveSessions} sessões · ${totalCost.toFixed(2)}</span>
          </div>

          <div className="split-picker">
            {SPLIT_MODES.map((s) => (
              <button
                key={s.mode}
                className={splitMode === s.mode ? "on" : ""}
                title={s.label}
                onClick={() => setSplitMode(s.mode)}
              >
                {s.glyph}
              </button>
            ))}
          </div>

          <div className="active-info">
            {active && activeStatus ? (
              <>
                <span className="muted">{activeStatus.model?.display_name ?? "modelo ?"}</span>
                <span className="muted">${(activeStatus.cost?.total_cost_usd ?? 0).toFixed(2)}</span>
              </>
            ) : (
              active?.pendingMessage && <span className="muted">{active.pendingMessage}</span>
            )}
          </div>
        </>
      )}
      {colony && <div className="counts" />}

      <PluginStatus />
      <ProcessesButton />
      <Announcements />
      <button className="icon-btn" title={`Configurações (${shortcutLabel("settings")})`} onClick={() => openModal({ kind: "settings" })}>
        ⚙
      </button>
    </header>
  );
}

/** Indicators local plugins put in the bar; a click shows the plugin's side tab or view. */
function PluginStatus() {
  const status = useStore((s) => s.pluginStatus);
  const localPlugins = useStore((s) => s.localPlugins);
  const activeTabId = useStore((s) => s.activeTabId);
  const entries = Object.entries(status)
    .map(([id, st]) => ({ plugin: localPlugins.find((p) => p.id === id), st }))
    .filter((e) => e.plugin);
  if (!entries.length) return null;
  return (
    <div className="plugin-status">
      {entries.map(({ plugin, st }) => (
        <button
          key={plugin!.id}
          className="plugin-status-chip"
          title={st.title ?? plugin!.name}
          onClick={() => openSurface(plugin!, plugin!.sidePanel ? "side" : plugin!.view ? "view" : "window", activeTabId, null)}
        >
          {st.text}
        </button>
      ))}
    </div>
  );
}
