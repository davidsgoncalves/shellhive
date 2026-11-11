import { useEffect, useRef, useState } from "react";
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

/** Time until a window renews, as "4 h 22 min" or "2 d 21 h". */
function untilReset(resetsAt: number, now: number): string {
  const min = Math.max(0, Math.round((resetsAt * 1000 - now) / 60_000));
  if (min <= 0) return "renovando";
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

const left = (win: RateWindow | undefined) => (win ? Math.min(100, Math.max(0, 100 - win.used_percentage)) : null);

function level(remaining: number): string {
  if (remaining <= 10) return "crit";
  if (remaining <= 30) return "warn";
  return "ok";
}

/** Claude's mark: a plain eight-ray burst. */
function ClaudeMark() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" className="mark-claude" aria-hidden>
      {[0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5].map((a) => (
        <line key={a} x1="12" y1="2.5" x2="12" y2="21.5" transform={`rotate(${a} 12 12)`} />
      ))}
    </svg>
  );
}

/** Codex's mark: a plain hexagon. */
function CodexMark() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" className="mark-codex" aria-hidden>
      <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" />
      <path d="M12 8.2l3.3 1.9v3.8L12 15.8l-3.3-1.9v-3.8z" />
    </svg>
  );
}

function OpencodeMark() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" className="mark-codex" aria-hidden>
      <rect x="5" y="4" width="14" height="16" rx="2" />
      <path d="M9 9h6M9 13h6" />
    </svg>
  );
}

/** One circle of a ring, showing what is left, full at the top. */
function Arc({ r, win }: { r: number; win: RateWindow | undefined }) {
  const rest = left(win);
  const length = 2 * Math.PI * r;
  return (
    <>
      <circle className="ring-track" cx="20" cy="20" r={r} />
      {rest !== null && rest > 0 && (
        <circle
          className={`ring-fill ${level(rest)}`}
          cx="20"
          cy="20"
          r={r}
          strokeDasharray={`${(rest / 100) * length} ${length}`}
          transform="rotate(-90 20 20)"
        />
      )}
    </>
  );
}

function Ring({ limits, mark }: { limits: RateLimits | null; mark: React.ReactNode }) {
  return (
    <span className="usage-ring">
      <svg viewBox="0 0 40 40" width="38" height="38">
        <Arc r={17} win={limits?.seven_day} />
        <Arc r={11.5} win={limits?.five_hour} />
      </svg>
      <span className="ring-mark">{mark}</span>
    </span>
  );
}

function Row({ label, win, now }: { label: string; win: RateWindow | undefined; now: number }) {
  const rest = left(win);
  return (
    <div className="usage-row">
      <span className="usage-label">{label}</span>
      <span className="usage-bar">
        {rest !== null && <span className={level(rest)} style={{ width: `${rest}%` }} />}
      </span>
      <span className="usage-left">{rest === null ? "sem dados" : `${Math.round(rest)}% restante`}</span>
      <span className="usage-reset">{win ? untilReset(win.resets_at, now) : ""}</span>
    </div>
  );
}

function Provider({ name, mark, limits, now }: { name: string; mark: React.ReactNode; limits: RateLimits | null; now: number }) {
  const stale = limits ? now - limits.receivedAt > 10 * 60_000 : false;
  return (
    <section className="usage-provider">
      <h4>
        {mark}
        {name}
        {stale && <span className="usage-stale">dado de mais de 10 min</span>}
      </h4>
      {limits ? (
        <>
          <Row label="5 horas" win={limits.five_hour} now={now} />
          <Row label="Semanal" win={limits.seven_day} now={now} />
          {limits.spend_limit && <Row label="Gasto" win={limits.spend_limit} now={now} />}
        </>
      ) : (
        <p className="usage-empty">Aparece depois da primeira resposta de uma sessão.</p>
      )}
    </section>
  );
}

/**
 * Usage of each agent at the foot of the activity rail: rings of what is
 * left (the week outside, the 5-hour window inside), and a card with the
 * numbers on hover, kept open by a click.
 */
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
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [anchor, setAnchor] = useState<number>(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setPinned(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPinned(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [pinned]);

  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setAnchor(window.innerHeight - r.bottom);
  };

  return (
    <div
      ref={ref}
      className="usage-rings"
      onMouseEnter={() => {
        place();
        setHover(true);
      }}
      onMouseLeave={() => setHover(false)}
    >
      <button
        className="usage-rings-btn"
        aria-label="Uso dos agentes"
        onClick={() => {
          place();
          setPinned(!pinned);
        }}
      >
        <Ring limits={claude} mark={<ClaudeMark />} />
        {usesCodex && <Ring limits={codex} mark={<CodexMark />} />}
        {usesOpencode && (
          <span className="usage-ring cost">
            <OpencodeMark />
          </span>
        )}
      </button>
      {(hover || pinned) && (
        <div className="usage-card" style={{ bottom: anchor }}>
          <h3>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
              <path d="M4 16a8 8 0 1 1 16 0" />
              <path d="M12 16l4-5" />
            </svg>
            Uso
          </h3>
          <Provider name="Claude" mark={<ClaudeMark />} limits={claude} now={now} />
          {usesCodex && <Provider name="Codex" mark={<CodexMark />} limits={codex} now={now} />}
          {usesOpencode && (
            <section className="usage-provider">
              <h4>
                <OpencodeMark />
                OpenCode
              </h4>
              <div className="usage-row">
                <span className="usage-label">Custo</span>
                <span className="usage-left">US$ {cost.toFixed(cost < 1 ? 4 : 2)}</span>
                <span className="usage-reset">sessões abertas</span>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
