import { useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../lib/store";
import { checkConnections, runInNewTab, useConnections } from "../lib/connections";

const MCP_LABEL = { connected: "conectado", auth: "precisa de login", failed: "falhou" } as const;

/** Whether Claude Code, the GitHub CLI and the MCP servers are ready. */
export function ConnectionsTab() {
  const { checks, mcp, mcpError, checking } = useConnections();
  const closeModal = useStore((s) => s.openModal);
  useEffect(() => {
    if (!checks) void checkConnections();
  }, [checks]);

  return (
    <>
      <section className="settings-section">
        <div className="row connections-head">
          <h3>Conexões</h3>
          <button className="ghost" disabled={checking} onClick={() => void checkConnections()}>
            {checking ? "Conferindo…" : "Conferir de novo"}
          </button>
        </div>
        {!checks && <p className="hint">Conferindo…</p>}
        <ul className="connection-list">
          {checks?.map((c) => (
            <li key={c.id} className={c.ok ? "ok" : "bad"}>
              <span className="connection-dot" />
              <span className="connection-label">{c.label}</span>
              <span className="connection-detail">{c.detail}</span>
              {c.fix &&
                (c.fix.startsWith("http") ? (
                  <button className="ghost" onClick={() => void openUrl(c.fix!)}>
                    Instalar
                  </button>
                ) : (
                  <button
                    className="ghost"
                    title={`Roda numa aba nova: ${c.fix}`}
                    onClick={() => {
                      closeModal(null);
                      void runInNewTab(c.fix!, c.label);
                    }}
                  >
                    {c.fix}
                  </button>
                ))}
            </li>
          ))}
        </ul>
      </section>

      <section className="settings-section">
        <h3>Conectores MCP do Claude</h3>
        {mcpError && <p className="error">{mcpError}</p>}
        {!mcp && !mcpError && <p className="hint">Conferindo os conectores, leva alguns segundos…</p>}
        {mcp && mcp.length === 0 && <p className="hint">Nenhum conector configurado.</p>}
        <ul className="connection-list">
          {mcp?.map((m) => (
            <li key={m.name} className={m.status === "connected" ? "ok" : m.status === "auth" ? "warn" : "bad"}>
              <span className="connection-dot" />
              <span className="connection-label">{m.name}</span>
              <span className="connection-detail">{MCP_LABEL[m.status]}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
