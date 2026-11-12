import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { SearchAddon } from "@xterm/addon-search";
import { searches, serializers, terminals } from "../lib/terminals";
import { terminalOptions, trackTerminal } from "../lib/theme";
import { actionOf, copyKeyOf, isAppShortcut } from "../lib/shortcuts";
import { copySelection } from "../lib/copyLine";
import { reportError } from "../lib/errors";
import { sessionFromDrag, useStore, type SessionRef } from "../lib/store";
import { attachLinks, carriesFiles, carriesSession, carriesTab, fixEmojiWidth, fixLinuxInput, pasteDroppedFiles } from "../lib/termExtras";
import { openAgentTerminal } from "../lib/agents";
import { runOfTab } from "../lib/bees";
import { droneOfTab } from "../lib/colony";
import { takePendingFork, takePendingLaunch, takePendingPrompt, takePendingResume } from "../lib/restored";
import type { Tab } from "../lib/types";

interface Props {
  tab: Tab;
  /** Drawn on screen; a tab in no pane stays mounted but hidden. */
  visible: boolean;
  /** Receives keyboard focus and the highlighted frame. */
  focused: boolean;
  /** Absolute placement inside the terminal area. */
  rect: { left: string; top: string; width: string; height: string };
  color: string;
  onFocus: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  /** A tab dragged from the list was dropped here. */
  onDropTab: (tabId: string) => void;
  /** A saved session dragged from the sessions list was dropped here. */
  onDropSession: (ref: SessionRef) => void;
  /** Something in this session waits on the user: a permission, a question or a command. */
  attention: boolean;
  /** Drawn above the Worker bee view, for a bee's run watched live. */
  raised?: boolean;
}

export function TerminalView({
  tab,
  visible,
  focused,
  rect,
  color,
  onFocus,
  onContextMenu,
  onDropTab,
  onDropSession,
  attention,
  raised = false,
}: Props) {
  const [dropping, setDropping] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const cwdRef = useRef(tab.cwd);
  cwdRef.current = tab.cwd;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const term = new Terminal(terminalOptions());
    const fit = new FitAddon();
    const serializer = new SerializeAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(serializer);
    term.loadAddon(search);
    fixEmojiWidth(term);
    const links = attachLinks(term, () => cwdRef.current);
    term.open(el);
    const input = fixLinuxInput(term);
    fit.fit();

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (actionOf(e) === "clear") {
        term.clear();
        return false;
      }
      const copy = copyKeyOf(e);
      if (copy) {
        copySelection(term, copy === "oneLine");
        return false;
      }
      // App shortcuts bubble up to the window handler instead of reaching the shell.
      return !isAppShortcut(e);
    });

    terminals.set(tab.id, term);
    serializers.set(tab.id, serializer);
    searches.set(tab.id, search);
    termRef.current = term;
    fitRef.current = fit;

    // Resume only when this tab was opened to continue a session, or to start
    // a copy of one; the backend types the command through the shim, which
    // supplies the settings.
    // A Codex tab shown as its terminal reopens Codex there, as a new tab
    // asked for it or a restored one. OpenCode attaches once its server is up.
    const agentTab = !!tab.provider;
    const openCodex = tab.provider === "codex" && tab.view !== "chat" && (takePendingResume(tab.id) || takePendingLaunch(tab.id));
    const fork = agentTab ? null : takePendingFork(tab.id);
    const resume = fork ?? (!agentTab && tab.claudeSessionId && takePendingResume(tab.id) ? tab.claudeSessionId : null);
    const prompt = resume || agentTab ? null : takePendingPrompt(tab.id);
    // The group's model and permission mode apply to every `claude` started in
    // the tab; a bee's own permissions win in the tab it runs in.
    const launch = useStore.getState().groups.find((g) => g.id === tab.groupId)?.launch;
    const beeRun = runOfTab(tab.id);
    const bee = beeRun && useStore.getState().bees.find((b) => b.id === beeRun.beeId);
    // A colony's drone on Claude runs with its own model and permissions.
    const drone = droneOfTab(tab.id);
    const own = bee ?? (drone?.agent === "claude" ? drone : undefined);
    invoke("pty_spawn", {
      id: tab.id,
      cols: term.cols,
      rows: term.rows,
      cwd: tab.cwd,
      resume,
      fork: !!fork,
      prompt,
      launch: !agentTab && takePendingLaunch(tab.id),
      model: (drone?.agent === "claude" ? drone.model : null) ?? launch?.model ?? null,
      permissionMode: own?.permissionMode ?? launch?.permissionMode ?? null,
      allowedTools: own?.allowedTools ?? null,
    })
      .then(() => {
        const now = useStore.getState().tabs.find((t) => t.id === tab.id);
        if (openCodex && now) void openAgentTerminal(now);
      })
      .catch((e) => {
        term.writeln(`\x1b[31mpty_spawn failed: ${e}\x1b[0m`);
        reportError("pty", `pty_spawn failed: ${e}`);
      });

    const dataSub = term.onData((data) => invoke("pty_write", { id: tab.id, data }));

    // Hidden panes measure as zero; they fit when shown again.
    const refit = () => {
      if (el.offsetParent === null) return;
      fit.fit();
      invoke("pty_resize", { id: tab.id, cols: term.cols, rows: term.rows }).catch(() => {});
    };
    // Fitting changes layout; doing it on the next frame keeps the observer
    // from looping within one.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refit);
    });
    observer.observe(el);
    const untrack = trackTerminal(term, refit);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      dataSub.dispose();
      terminals.delete(tab.id);
      serializers.delete(tab.id);
      searches.delete(tab.id);
      links.dispose();
      input.dispose();
      untrack();
      term.dispose();
      invoke("pty_kill", { id: tab.id }).catch(() => {});
    };
    // The pty lives as long as the tab id; other tab fields must not respawn it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  useEffect(() => {
    if (!visible) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    requestAnimationFrame(() => {
      fit.fit();
      invoke("pty_resize", { id: tab.id, cols: term.cols, rows: term.rows }).catch(() => {});
      if (focused) term.focus();
    });
  }, [visible, focused, rect.left, rect.top, rect.width, rect.height, tab.id]);

  return (
    <div
      ref={ref}
      className={`term-pane ${focused ? "focused" : ""} ${dropping ? "drop-target" : ""} ${attention ? "attention" : ""}`}
      style={{
        display: visible ? "block" : "none",
        ...rect,
        ...(raised ? { zIndex: 60 } : {}),
        ["--group-color" as string]: color,
      }}
      onMouseDown={onFocus}
      onContextMenu={onContextMenu}
      onDragOver={(e) => {
        if (carriesTab(e.dataTransfer) || carriesSession(e.dataTransfer)) {
          e.preventDefault();
          setDropping(true);
        } else if (carriesFiles(e.dataTransfer)) e.preventDefault();
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        const dragged = e.dataTransfer.getData("text/tab-id");
        if (dragged) {
          e.preventDefault();
          onDropTab(dragged);
          return;
        }
        const session = sessionFromDrag(e.dataTransfer);
        if (session) {
          e.preventDefault();
          onDropSession(session);
          return;
        }
        if (!carriesFiles(e.dataTransfer)) return;
        e.preventDefault();
        onFocus();
        void pasteDroppedFiles(tab.id, e.dataTransfer).then(() => termRef.current?.focus());
      }}
    />
  );
}
