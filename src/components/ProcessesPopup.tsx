import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../lib/store";

/** How often the list is read again while open. */
const REFRESH_MS = 4000;

interface TabProcess {
  pid: number;
  name: string;
  command: string;
  ports: number[];
}

interface TabProcesses {
  tab_id: string;
  processes: TabProcess[];
}

/** Top bar button: what each tab started, the ports it listens on, and a way to end it. */
export function ProcessesButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="processes" ref={ref}>
      <button className={`icon-btn ${open ? "on" : ""}`} title="Processos e portas das abas" onClick={() => setOpen((o) => !o)}>
        ⌁
      </button>
      {open && <ProcessesList />}
    </div>
  );
}

function ProcessesList() {
  const tabs = useStore((s) => s.tabs);
  const activateTab = useStore((s) => s.activateTab);
  const [list, setList] = useState<TabProcesses[] | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = () =>
    void invoke<TabProcesses[]>("tab_processes")
      .then(setList)
      .catch(() => setList([]));

  useEffect(() => {
    read();
    const id = setInterval(read, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const kill = async (pid: number) => {
    if (confirming !== pid) return setConfirming(pid);
    setConfirming(null);
    try {
      await invoke("process_kill", { pid });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    read();
  };

  const shown = (list ?? [])
    .map((t) => ({ ...t, tab: tabs.find((x) => x.id === t.tab_id) }))
    .filter((t) => t.tab && t.processes.length > 0);

  return (
    <div className="processes-popup">
      <h4>Processos das abas</h4>
      {error && <p className="error">{error}</p>}
      {list === null ? (
        <p className="hint">Lendo…</p>
      ) : shown.length === 0 ? (
        <p className="hint">Nenhum programa rodando nas abas além do shell.</p>
      ) : (
        shown.map((t) => (
          <section key={t.tab_id}>
            <button className="link processes-tab" onClick={() => activateTab(t.tab_id)}>
              {t.tab!.title}
            </button>
            <ul>
              {t.processes.map((p) => (
                <li key={p.pid} title={p.command}>
                  <span className="processes-name">{p.name}</span>
                  {p.ports.map((port) => (
                    <span key={port} className="processes-port">
                      :{port}
                    </span>
                  ))}
                  <span className="processes-cmd">{p.command}</span>
                  <button className={`link ${confirming === p.pid ? "danger" : ""}`} onClick={() => void kill(p.pid)}>
                    {confirming === p.pid ? "Confirmar" : "Encerrar"}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
