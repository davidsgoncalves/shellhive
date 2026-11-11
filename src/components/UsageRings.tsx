import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import { useAgentUsage } from "../lib/agents";
import type { RateLimits, RateWindow } from "../lib/types";

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
  if (diff <= 0) return "renovando";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) {
    const d = new Date(resetsAt * 1000);
    return d.toLocaleDateString("pt-BR", { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
}

function level(pct: number): string {
  if (pct >= 90) return "crit";
  if (pct >= 70) return "warn";
  return "ok";
}

function windowLine(label: string, win: RateWindow | undefined, now: number): string {
  if (!win) return `${label}: sem dados`;
  const pct = Math.min(100, Math.max(0, win.used_percentage));
  return `${label}: ${Math.round(pct)}% usado, restam ${Math.round(100 - pct)}%, renova em ${resetLabel(win.resets_at, now)}`;
}

/** One circle of the ring, filled clockwise from the top. */
function Arc({ r, win }: { r: number; win: RateWindow | undefined }) {
  const pct = win ? Math.min(100, Math.max(0, win.used_percentage)) : 0;
  const length = 2 * Math.PI * r;
  return (
    <>
      <circle className="ring-track" cx="16" cy="16" r={r} />
      {win && (
        <circle
          className={`ring-fill ${level(pct)}`}
          cx="16"
          cy="16"
          r={r}
          strokeDasharray={`${(pct / 100) * length} ${length}`}
          transform="rotate(-90 16 16)"
        />
      )}
    </>
  );
}

/** A provider's limits: the week outside, the 5-hour window inside. */
function Ring({ name, mark, limits, now }: { name: string; mark: string; limits: RateLimits | null; now: number }) {
  const stale = limits ? now - limits.receivedAt > 10 * 60_000 : false;
  const title = [
    name,
    windowLine("5 horas", limits?.five_hour, now),
    windowLine("7 dias", limits?.seven_day, now),
    ...(limits?.spend_limit ? [windowLine("gasto", limits.spend_limit, now)] : []),
    ...(stale ? ["Último dado há mais de 10 min"] : []),
    ...(!limits ? ["Aparece depois da primeira resposta de uma sessão"] : []),
  ].join("\n");
  return (
    <div className={`usage-ring ${stale ? "stale" : ""}`} title={title} aria-label={title}>
      <svg viewBox="0 0 32 32" width="32" height="32">
        <Arc r={13} win={limits?.seven_day} />
        <Arc r={8.5} win={limits?.five_hour} />
      </svg>
      <span className="ring-mark">{mark}</span>
    </div>
  );
}

/** OpenCode bills by token, so it shows what its open sessions cost. */
function CostMark({ cost }: { cost: number }) {
  const title = `OpenCode\nCusto das sessões abertas: US$ ${cost.toFixed(cost < 1 ? 4 : 2)}`;
  return (
    <div className="usage-ring cost" title={title} aria-label={title}>
      <span className="ring-mark">OC</span>
    </div>
  );
}

/** Usage of each agent at the foot of the activity rail. */
export function UsageRings() {
  const now = useNow();
  const claude = useStore((s) => s.rateLimits);
  const codex = useAgentUsage((s) => s.codex);
  const costs = useAgentUsage((s) => s.opencodeCost);
  // Booleans, not a list: a selector must return the same value for the same state.
  const codexTab = useStore((s) => s.tabs.some((t) => t.provider === "codex"));
  const opencodeTab = useStore((s) => s.tabs.some((t) => t.provider === "opencode"));
  const usesCodex = !!codex || codexTab;
  const usesOpencode = Object.keys(costs).length > 0 || opencodeTab;
  const cost = Object.values(costs).reduce((a, b) => a + b, 0);
  return (
    <div className="usage-rings">
      <Ring name="Claude" mark="Cl" limits={claude} now={now} />
      {usesCodex && <Ring name="Codex" mark="Cx" limits={codex} now={now} />}
      {usesOpencode && <CostMark cost={cost} />}
    </div>
  );
}
