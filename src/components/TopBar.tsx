import { useEffect, useState } from "react";
import { Announcements } from "./Announcements";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "../lib/store";
import { SPLIT_MODES, type RateWindow, type TabState } from "../lib/types";
import { shortcutLabel } from "../lib/shortcuts";
import logo from "../assets/logo.png";

/** Vite sets this only on the dev server, so a packaged build never shows it. */
const IS_DEV = import.meta.env.DEV;
const APP_NAME = IS_DEV ? "Shellhive - dev" : "Shellhive";

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function resetLabel(resetsAt: number, now: number): string {
  const diff = resetsAt * 1000 - now;
  if (diff <= 0) return "resetando";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) {
    const d = new Date(resetsAt * 1000);
    return d.toLocaleDateString("pt-BR", { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
}

function levelClass(pct: number): string {
  if (pct >= 90) return "crit";
  if (pct >= 70) return "warn";
  return "ok";
}

function Meter({ label, win, now }: { label: string; win: RateWindow | undefined; now: number }) {
  if (!win) {
    return (
      <div className="meter no-data" title={`${label}: sem dados até a primeira resposta de uma sessão`}>
        <span className="meter-label">{label}</span>
        <span className="meter-bar"><span style={{ width: 0 }} /></span>
        <span className="meter-value">—</span>
      </div>
    );
  }
  const pct = Math.min(100, Math.max(0, win.used_percentage));
  return (
    <div className={`meter ${levelClass(pct)}`} title={`${label}: ${pct.toFixed(1)}% usado, reseta em ${resetLabel(win.resets_at, now)}`}>
      <span className="meter-label">{label}</span>
      <span className="meter-bar"><span style={{ width: `${pct}%` }} /></span>
      <span className="meter-value">{Math.round(pct)}%</span>
      <span className="meter-reset">↻ {resetLabel(win.resets_at, now)}</span>
    </div>
  );
}

const COUNTED: Array<{ state: TabState; label: string }> = [
  { state: "working", label: "trabalhando" },
  { state: "permission", label: "permissão" },
  { state: "waiting", label: "aguardando" },
];

export function TopBar() {
  const { tabs, activeTabId, statusByTab, rateLimits, openModal, splitMode, setSplitMode, barPosition } =
    useStore();
  const now = useNow();

  useEffect(() => {
    void getCurrentWindow().setTitle(APP_NAME);
  }, []);
  const active = tabs.find((t) => t.id === activeTabId);
  const activeStatus = active ? statusByTab[active.id] : undefined;

  const totalCost = Object.values(statusByTab).reduce((sum, s) => sum + (s.cost?.total_cost_usd ?? 0), 0);
  const liveSessions = tabs.filter((t) => t.claudeSessionId && t.state !== "dormant" && t.state !== "shell").length;
  const stale = rateLimits ? now - rateLimits.receivedAt > 10 * 60_000 : false;

  return (
    <header className={`topbar ${barPosition === "bottom" ? "at-bottom" : ""}`}>
      <div className={`brand ${IS_DEV ? "dev" : ""}`}>
        <img className="brand-logo" src={logo} alt="" />
        {APP_NAME}
      </div>

      <div className={`limits ${stale ? "stale" : ""}`} title={stale ? "Último dado há mais de 10 min" : undefined}>
        <Meter label="5h" win={rateLimits?.five_hour} now={now} />
        <Meter label="7d" win={rateLimits?.seven_day} now={now} />
        {rateLimits?.spend_limit && <Meter label="gasto" win={rateLimits.spend_limit} now={now} />}
      </div>

      <div className="counts">
        {COUNTED.map(({ state, label }) => {
          const n = tabs.filter((t) => t.state === state).length;
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

      <Announcements />
      <button className="icon-btn" title={`Configurações (${shortcutLabel("settings")})`} onClick={() => openModal({ kind: "settings" })}>
        ⚙
      </button>
    </header>
  );
}
