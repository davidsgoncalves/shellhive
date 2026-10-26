import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../lib/store";
import { originOf, scanRepos } from "../lib/repos";
import { checkConnections, runInNewTab, useConnections } from "../lib/connections";

const pickFolder = async () => {
  const picked = await open({ directory: true, multiple: false, title: "Escolher pasta do clone" });
  return typeof picked === "string" ? picked : null;
};

/** GitHub repositories and the folder of each clone, for the worker bees. */
export function ReposTab() {
  const { repos, setRepo, removeRepo } = useStore();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void scanRepos(), []);

  // The repository comes from the folder's own origin.
  const add = async (expected?: string) => {
    setError(null);
    const path = await pickFolder();
    if (!path) return;
    const origin = await originOf(path).catch(() => null);
    if (!origin) return setError("Essa pasta não é um clone de um repositório do GitHub.");
    if (expected && origin.slug !== expected)
      return setError(`Essa pasta é um clone de ${origin.slug}, não de ${expected}.`);
    setRepo({ slug: origin.slug, path: origin.root, manual: true });
  };

  return (
    <section className="settings-section">
      <h3>Repositórios</h3>
      <p className="hint">
        Cada repositório do GitHub e a pasta do clone nesta máquina. Os das pastas dos grupos entram sozinhos.
      </p>
      <div className="row">
        <button className="ghost" onClick={() => void add()}>
          + Adicionar pela pasta
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {repos.length === 0 && <p className="hint">Nenhum repositório ainda.</p>}
      <ul className="folder-manage">
        {repos.map((r) => (
          <li key={r.slug}>
            <span className="folder-name">{r.slug}</span>
            <span className="folder-path" title={r.path}>
              {r.path}
            </span>
            <button className="link" onClick={() => void add(r.slug)}>
              Trocar pasta
            </button>
            <button className="icon-btn" title="Remover" onClick={() => removeRepo(r.slug)}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

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
