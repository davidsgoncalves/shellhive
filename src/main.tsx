import ReactDOM from "react-dom/client";
import App from "./App";
import { useStore } from "./lib/store";
import { markPendingResume } from "./lib/restored";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { tabIdOfLabel } from "./lib/detach";
import { DetachedTerminal } from "./components/DetachedTerminal";
import { MiniPanel } from "./components/MiniPanel";
import { MINI_LABEL } from "./lib/mini";
import { watchUncaughtErrors } from "./lib/errors";
import { applyTheme, followSharedTheme } from "./lib/theme";

// State lives in a file, so it loads before the first render. Rendering first
// would let early writes persist an empty layout over the saved one.
watchUncaughtErrors();
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
const label = getCurrentWebviewWindow().label;
const detachedTab = tabIdOfLabel(label);
// Secondary windows only draw what the main window sends; they never load or
// save state.
if (label === MINI_LABEL || detachedTab) followSharedTheme();
if (label === MINI_LABEL) root.render(<MiniPanel />);
else if (detachedTab) root.render(<DetachedTerminal tabId={detachedTab} />);
else useStore.persist
  .rehydrate()
  ?.catch((err: unknown) => console.error("state load failed", err))
  .finally(() => {
    markPendingResume(useStore.getState().tabs.map((t) => t.id));
    // Before the first render, so terminals open in the saved theme.
    applyTheme(useStore.getState().theme);
    root.render(<App />);
  });
