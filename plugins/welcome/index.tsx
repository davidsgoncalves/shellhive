import { useEffect } from "react";
import type { PluginHost, ShellhivePlugin } from "../../src/lib/plugins";
import { useStore } from "../../src/lib/store";
import { RailIcon } from "../../src/components/RailIcon";
import { ymd } from "./collect";
import { useWelcome } from "./state";
import { summary } from "./summary";
import { WelcomePage } from "./WelcomePage";
import manifest from "./plugin.json";
import "./welcome.css";

/** Not before this hour, so a night left open does not greet at midnight. */
const FIRST_HOUR = 6;

/** A tab whose terminal is on screen in this window. */
function onScreen(tabId: string | null): tabId is string {
  const s = useStore.getState();
  return !!tabId && s.panes.includes(tabId) && !s.detached.includes(tabId);
}

/** Opens the page over the active terminal the first time each day. */
async function greetOncePerDay() {
  const w = useWelcome.getState();
  await w.load();
  const now = new Date();
  if (now.getHours() < FIRST_HOUR || useWelcome.getState().shownOn === ymd(now)) return;
  const tabId = useStore.getState().activeTabId;
  if (onScreen(tabId)) await w.show(tabId, true);
}

/** The page in place of a tab's terminal. */
function WelcomeOverlay({ host }: { host: PluginHost }) {
  const { shownOver, hide } = useWelcome();
  useEffect(() => {
    void greetOncePerDay();
    const timer = setInterval(() => void greetOncePerDay(), 60_000);
    return () => clearInterval(timer);
  }, []);
  // Bringing up the session under it shows its terminal again.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.pickedTab && s.pickedTab !== prev.pickedTab && s.pickedTab.id === useWelcome.getState().shownOver)
          useWelcome.getState().hide();
      }),
    [],
  );
  if (!shownOver) return null;
  return (
    <div
      className="welcome-view"
      style={host.paneRect(shownOver) ?? { display: "none" }}
      tabIndex={-1}
      onKeyDown={(e) => e.key === "Escape" && (e.target as HTMLElement).tagName !== "INPUT" && hide()}
    >
      <WelcomePage onClose={hide} />
    </div>
  );
}

function WelcomeSide() {
  const { data, refresh, show } = useWelcome();
  const activeTabId = useStore((s) => s.activeTabId);
  useEffect(() => {
    if (!data || Date.now() - data.at > 10 * 60_000) void refresh();
  }, [data, refresh]);
  return (
    <div className="welcome-side">
      {onScreen(activeTabId) && (
        <button className="ghost" onClick={() => void show(activeTabId)}>
          Abrir no lugar do terminal
        </button>
      )}
      <WelcomePage compact />
    </div>
  );
}

const plugin: ShellhivePlugin = {
  manifest,
  Overlay: WelcomeOverlay,
  SideTab: {
    title: "Bom dia",
    Component: WelcomeSide,
    icon: <RailIcon><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></RailIcon>,
  },
  tools: {
    daily_summary: async (_args, { tabId }) => {
      const w = useWelcome.getState();
      const data = await w.refresh();
      if (onScreen(tabId)) await w.show(tabId);
      return { text: summary(data, useWelcome.getState().place) };
    },
  },
};

export default plugin;
