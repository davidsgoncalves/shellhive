import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { SearchAddon } from "@xterm/addon-search";
import { searches, serializers, terminals } from "../lib/terminals";
import { terminalOptions, trackTerminal } from "../lib/theme";
import { actionOf, isAppShortcut } from "../lib/shortcuts";
import { reportError } from "../lib/errors";
import { sessionFromDrag, type SessionRef } from "../lib/store";
import { attachLinks, carriesFiles, carriesSession, carriesTab, fixLinuxInput, pasteDroppedFiles } from "../lib/termExtras";
import { takePendingResume } from "../lib/restored";
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
    const links = attachLinks(term, () => cwdRef.current);
    term.open(el);
    const input = fixLinuxInput(term);
    fit.fit();
    const untrack = trackTerminal(term, fit);

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (actionOf(e) === "clear") {
        term.clear();
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

    // Resume only when this tab was opened to continue a session; the backend
    // types the command through the shim, which supplies the settings.
    const resume = tab.claudeSessionId && takePendingResume(tab.id) ? tab.claudeSessionId : null;
    invoke("pty_spawn", { id: tab.id, cols: term.cols, rows: term.rows, cwd: tab.cwd, resume })
      .catch((e) => {
        term.writeln(`\x1b[31mpty_spawn failed: ${e}\x1b[0m`);
        reportError("pty", `pty_spawn failed: ${e}`);
      });

    const dataSub = term.onData((data) => invoke("pty_write", { id: tab.id, data }));

    const observer = new ResizeObserver(() => {
      if (el.offsetParent === null) return;
      fit.fit();
      invoke("pty_resize", { id: tab.id, cols: term.cols, rows: term.rows }).catch(() => {});
    });
    observer.observe(el);

    return () => {
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
