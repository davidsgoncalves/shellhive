import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { decodeBase64 } from "../lib/terminals";
import { terminalOptions, trackTerminal } from "../lib/theme";
import { actionOf, shortcutLabel } from "../lib/shortcuts";
import { attachLinks, carriesFiles, fixLinuxInput, pasteDroppedFiles } from "../lib/termExtras";
import {
  DETACH_CLOSED,
  DETACH_READY,
  DETACH_RESIZE,
  DETACH_SNAPSHOT,
  DETACH_TITLE,
  MAIN_LABEL,
  overMainWindow,
  type DetachSnapshot,
} from "../lib/detach";

type PtyData = { id: string; data: string };

/**
 * A window holding one tab's terminal. The main window keeps owning the tab,
 * its group and its hooks; this one only draws the screen and sends keys.
 */
export function DetachedTerminal({ tabId }: { tabId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState("");

  useEffect(() => {
    const win = getCurrentWebviewWindow();
    void win.title().then(setTitle);
    const unTitle = listen<string>(DETACH_TITLE, (ev) => setTitle(ev.payload));

    const el = ref.current;
    if (!el) return;
    const term = new Terminal(terminalOptions());
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const input = fixLinuxInput(term);
    let cwd: string | null = null;
    const links = attachLinks(term, () => cwd);

    const resize = () => {
      fit.fit();
      void invoke("pty_resize", { id: tabId, cols: term.cols, rows: term.rows }).catch(() => {});
      void emitTo(MAIN_LABEL, DETACH_RESIZE, { id: tabId, cols: term.cols, rows: term.rows });
    };
    const untrack = trackTerminal(term, resize);

    // Output that arrives before the snapshot is already part of it.
    let ready = false;
    const unData = listen<PtyData>("pty-data", (ev) => {
      if (ready && ev.payload.id === tabId) term.write(decodeBase64(ev.payload.data));
    });
    const unSnap = listen<DetachSnapshot>(DETACH_SNAPSHOT, (ev) => {
      if (ev.payload.id !== tabId || ready) return;
      cwd = ev.payload.cwd;
      term.resize(ev.payload.cols, ev.payload.rows);
      term.write(ev.payload.data, () => {
        ready = true;
        // The new size makes the program redraw for this window.
        resize();
        term.focus();
      });
    });
    const unExit = listen<{ id: string }>("pty-exit", (ev) => {
      if (ev.payload.id === tabId) void win.close();
    });
    void unSnap.then(() => emitTo(MAIN_LABEL, DETACH_READY, { id: tabId }));

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const action = actionOf(e);
      if (action === "clear") {
        term.clear();
        return false;
      }
      if (action === "closeTab") {
        void win.close();
        return false;
      }
      return true;
    });
    const dataSub = term.onData((data) => invoke("pty_write", { id: tabId, data }));

    const observer = new ResizeObserver(() => ready && resize());
    observer.observe(el);

    const unClose = win.onCloseRequested(() => emitTo(MAIN_LABEL, DETACH_CLOSED, { id: tabId }));

    return () => {
      observer.disconnect();
      dataSub.dispose();
      links.dispose();
      input.dispose();
      untrack();
      term.dispose();
      for (const p of [unTitle, unData, unSnap, unExit, unClose]) void p.then((u) => u());
    };
  }, [tabId]);

  const backToMain = () => void getCurrentWebviewWindow().close();

  return (
    <div className="detached">
      <header className="detached-bar">
        <span
          className="detached-handle"
          draggable
          title="Arraste para a janela principal para juntar"
          onDragStart={(e) => e.dataTransfer.setData("text/tab-id", tabId)}
          onDragEnd={(e) => {
            const { screenX, screenY } = e;
            void overMainWindow(screenX, screenY).then((over) => over && backToMain());
          }}
        >
          ⠿ {title}
        </span>
        <button className="detached-back" onClick={backToMain} title={`Voltar para a janela principal (${shortcutLabel("closeTab")})`}>
          Voltar para a principal
        </button>
      </header>
      <div
        className="detached-term"
        ref={ref}
        onDragOver={(e) => {
          if (carriesFiles(e.dataTransfer)) e.preventDefault();
        }}
        onDrop={(e) => {
          if (!carriesFiles(e.dataTransfer)) return;
          e.preventDefault();
          void pasteDroppedFiles(tabId, e.dataTransfer);
        }}
      />
    </div>
  );
}
