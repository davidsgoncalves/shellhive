import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { openSessionInGroup, useStore } from "../lib/store";
import type { SessionKind } from "../lib/types";
import { ClaudeMark, CodexMark, OpencodeMark, TerminalMark } from "./ProviderMarks";

type Agent = "claude" | "codex" | "opencode";
type Style = "chat" | "terminal";

const AGENTS: { id: Agent; name: string; mark: () => React.ReactNode }[] = [
  { id: "claude", name: "Claude", mark: ClaudeMark },
  { id: "codex", name: "Codex", mark: CodexMark },
  { id: "opencode", name: "OpenCode", mark: OpencodeMark },
];

const KINDS: Record<Agent, Record<Style, SessionKind>> = {
  claude: { chat: "claude-chat", terminal: "claude-terminal" },
  codex: { chat: "codex", terminal: "codex-terminal" },
  opencode: { chat: "opencode", terminal: "opencode-terminal" },
};

function split(kind: SessionKind): [Agent, Style] | null {
  for (const agent of AGENTS) {
    if (KINDS[agent.id].chat === kind) return [agent.id, "chat"];
    if (KINDS[agent.id].terminal === kind) return [agent.id, "terminal"];
  }
  return null;
}

const LAST_STYLE_KEY = "shellhive.newSession.lastStyle";

function lastStyles(): Partial<Record<Agent, Style>> {
  try {
    return JSON.parse(localStorage.getItem(LAST_STYLE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function rememberStyle(agent: Agent, style: Style) {
  try {
    localStorage.setItem(LAST_STYLE_KEY, JSON.stringify({ ...lastStyles(), [agent]: style }));
  } catch {
    // A convenience only; the menu works without it.
  }
}

/**
 * The + menu of a group, in two steps: what to open (a plain terminal or an
 * agent), then, for an agent, whether it opens as a chat or in the terminal.
 */
export function NewSessionMenu() {
  const menu = useStore((s) => s.newSessionMenu);
  const openMenu = useStore((s) => s.openNewSessionMenu);
  const group = useStore((s) => s.groups.find((g) => g.id === menu?.groupId));
  const ref = useRef<HTMLDivElement>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [cursor, setCursor] = useState(0);
  const steps = useRef<(HTMLDivElement | null)[]>([]);
  const [height, setHeight] = useState<number>();

  const preferred = group?.launch?.open ?? "terminal";
  const preferredSplit = split(preferred);

  // Each time the menu opens it starts on the first step, at the group's default.
  useEffect(() => {
    if (!menu) return;
    setAgent(null);
    setCursor(preferredSplit ? AGENTS.findIndex((a) => a.id === preferredSplit[0]) + 1 : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);

  const styleFor = (a: Agent): Style =>
    lastStyles()[a] ?? (preferredSplit?.[0] === a ? preferredSplit[1] : "chat");

  const open = (kind: SessionKind) => {
    if (!group) return;
    openMenu(null);
    openSessionInGroup(group.id, kind);
  };

  const pickAgent = (a: Agent) => {
    setAgent(a);
    setCursor(styleFor(a) === "chat" ? 0 : 1);
  };

  const pickStyle = (style: Style) => {
    if (!agent) return;
    rememberStyle(agent, style);
    open(KINDS[agent][style]);
  };

  const back = () => {
    if (!agent) return;
    setCursor(AGENTS.findIndex((a) => a.id === agent) + 1);
    setAgent(null);
  };

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) openMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      const count = agent ? 2 : AGENTS.length + 1;
      if (e.key === "Escape" || (e.key === "ArrowLeft" && agent)) {
        e.preventDefault();
        if (agent) back();
        else openMenu(null);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => (c + 1) % count);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => (c + count - 1) % count);
      } else if (e.key === "Enter" || (e.key === "ArrowRight" && !agent && cursor > 0)) {
        e.preventDefault();
        if (agent) pickStyle(cursor === 0 ? "chat" : "terminal");
        else if (cursor === 0) open("terminal");
        else pickAgent(AGENTS[cursor - 1].id);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  });

  // The menu takes the height of the step on screen, so the short second step leaves no gap.
  useLayoutEffect(() => {
    setHeight(steps.current[agent ? 1 : 0]?.offsetHeight);
  }, [agent, menu]);

  if (!menu || !group) return null;
  const current = AGENTS.find((a) => a.id === agent);
  const preferredStyle = preferredSplit?.[0] === agent ? preferredSplit?.[1] : undefined;

  return (
    <div
      ref={ref}
      className="group-menu new-session-menu"
      style={{ left: Math.min(menu.x, window.innerWidth - 230), top: menu.y + 4 }}
    >
      <div className={`ns-track${agent ? " second" : ""}`} style={{ height }}>
        <div className="ns-step" ref={(el) => void (steps.current[0] = el)} aria-hidden={!!agent}>
          <button
            className={`menu-item ns-item${cursor === 0 && !agent ? " active" : ""}`}
            tabIndex={agent ? -1 : 0}
            onMouseEnter={() => setCursor(0)}
            onClick={() => open("terminal")}
          >
            <TerminalMark />
            <span className="ns-label">Terminal</span>
            {preferred === "terminal" && <span className="muted">padrão</span>}
          </button>
          {AGENTS.map((a, i) => (
            <button
              key={a.id}
              className={`menu-item ns-item${cursor === i + 1 && !agent ? " active" : ""}`}
              tabIndex={agent ? -1 : 0}
              onMouseEnter={() => setCursor(i + 1)}
              onClick={() => pickAgent(a.id)}
            >
              <a.mark />
              <span className="ns-label">{a.name}</span>
              {preferredSplit?.[0] === a.id && <span className="muted">padrão</span>}
              <span className="ns-chevron">›</span>
            </button>
          ))}
        </div>
        <div className="ns-step" ref={(el) => void (steps.current[1] = el)} aria-hidden={!agent}>
          <button className="ns-back" tabIndex={agent ? 0 : -1} onClick={back}>
            <span className="ns-chevron">‹</span>
            {current && <current.mark />}
            <span>{current?.name}</span>
          </button>
          {(["chat", "terminal"] as Style[]).map((style, i) => (
            <button
              key={style}
              className={`menu-item ns-item${cursor === i && agent ? " active" : ""}`}
              tabIndex={agent ? 0 : -1}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pickStyle(style)}
            >
              <span className="ns-label">{style === "chat" ? "Chat" : "Terminal"}</span>
              {preferredStyle === style && <span className="muted">padrão</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
