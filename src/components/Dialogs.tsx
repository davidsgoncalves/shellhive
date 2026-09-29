import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { installKind, RELEASES_URL } from "../lib/update";
import { useUpdater } from "../lib/updater";
import type { ReportsState } from "../lib/errors";
import { shortcutLabel, withShortcuts } from "../lib/shortcuts";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore, type SettingsTab } from "../lib/store";
import { DEFAULT_FONT_SIZE, THEMES, type ThemeId } from "../lib/theme";
import { Modal } from "./Modal";
import { AddFolder, FolderChoice } from "./FolderFields";
import { BORDER_OPTIONS } from "../lib/types";
import { QuickSwitcher } from "./QuickSwitcher";
import changelog from "../changelog.json";
import { PLUGINS } from "../lib/plugins";
import type { PathCheck } from "../lib/types";

const INSTALL_LABEL: Record<string, string> = {
  native: "instalação nativa",
  appimage: "AppImage",
  package: "pacote do sistema",
};

/** Version, how it was installed, and a manual check for a newer release. */
interface ChangelogEntry {
  version: string;
  date: string;
  items: string[];
}

/** Written by hand for each release; `pnpm bump` adds the empty entry. */
const CHANGELOG = changelog as ChangelogEntry[];

/** Copies the Claude Terminal data in again, over the current data. */
function LegacyImportSection() {
  const [available, setAvailable] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void invoke<boolean>("legacy_data_available").then(setAvailable).catch(() => {});
  }, []);

  if (!available) return null;

  const reimport = () => {
    if (!confirming) return setConfirming(true);
    void invoke("legacy_data_reimport").catch((e) => setError(String(e)));
  };

  return (
    <section className="settings-section">
      <h3>Dados do Claude Terminal</h3>
      <p className="hint">
        Na primeira abertura do Shellhive, suas abas, grupos e configurações foram copiados do Claude Terminal, e a pasta
        antiga ficou como backup. Importar de novo substitui os dados atuais por essa cópia e reinicia o app.
      </p>
      <div className="row">
        <button className={`ghost auto ${confirming ? "danger" : ""}`} onClick={reimport}>
          {confirming ? "Confirmar: substituir e reiniciar" : "Importar de novo do Claude Terminal"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

const ISSUE_BODY_MAX = 6000;

/** Opt-in error reports, and a GitHub issue carrying the local error log. */
function ErrorReportsSection({ version, kind }: { version: string; kind: string }) {
  const [state, setState] = useState<ReportsState | null>(null);

  useEffect(() => {
    void invoke<ReportsState>("error_reports_get").then(setState).catch(() => {});
  }, []);

  const toggle = (enabled: boolean) => {
    void invoke("error_reports_set", { enabled })
      .then(() => setState((s) => (s ? { ...s, enabled } : s)))
      .catch(() => {});
  };

  const reportProblem = async () => {
    const log = await invoke<string>("error_log_tail", { lines: 40 }).catch(() => "");
    const body = [
      "**O que aconteceu:**",
      "",
      "",
      "**Como reproduzir:**",
      "",
      "",
      "---",
      `Versão: ${version} · ${kind}`,
      `Sistema: ${navigator.userAgent}`,
      "",
      "Últimos erros registrados:",
      "```",
      log || "(nenhum)",
      "```",
    ]
      .join("\n")
      .slice(0, ISSUE_BODY_MAX);
    const url = `${RELEASES_URL.replace(/\/releases$/, "")}/issues/new?title=${encodeURIComponent("Problema: ")}&body=${encodeURIComponent(body)}`;
    void openUrl(url);
  };

  return (
    <section className="settings-section">
      <h3>Relatórios de erro</h3>
      <p className="hint">
        Envia os erros do app para análise, sem nada do que você digita ou vê no terminal. Pastas pessoais, nome de
        usuário e qualquer coisa parecida com token são removidos antes.
      </p>
      {state?.available ? (
        <div className="chip-row">
          <button className={`chip ${state.enabled ? "on" : ""}`} onClick={() => toggle(true)}>
            Enviar
          </button>
          <button className={`chip ${!state.enabled ? "on" : ""}`} onClick={() => toggle(false)}>
            Não enviar
          </button>
        </div>
      ) : (
        <p className="hint">Esta versão não tem o envio configurado. Os erros ficam só no registro local.</p>
      )}
      <div className="row">
        <button className="ghost auto" onClick={() => void reportProblem()}>
          Relatar problema
        </button>
      </div>
    </section>
  );
}

function AboutTab() {
  const [version, setVersion] = useState("…");
  const [kind, setKind] = useState("…");
  const [status, setStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const { version: available, phase, progress, message, look: lookForUpdate, install, restart } = useUpdater();
  const { showEvents, setShowEvents, betaChannel, setBetaChannel } = useStore();

  useEffect(() => {
    void getVersion().then(setVersion);
    void installKind().then(setKind);
  }, []);

  const look = async () => {
    setChecking(true);
    setStatus(null);
    try {
      const found = await lookForUpdate();
      setStatus(found ? null : "Você está na versão mais recente.");
    } catch (err) {
      setStatus(`Não consegui verificar: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
    <section className="settings-section">
      <h3>Versão</h3>
      <ul className="about-list">
        <li>
          <span>Instalada</span>
          <strong>{version}</strong>
        </li>
        <li>
          <span>Formato</span>
          <strong>{INSTALL_LABEL[kind] ?? kind}</strong>
        </li>
      </ul>
      <div className="row">
        <button className="ghost auto" onClick={() => void look()} disabled={checking}>
          {checking ? "Verificando…" : "Procurar atualizações"}
        </button>
        <button className="ghost auto" onClick={() => void openUrl(RELEASES_URL)}>
          Ver releases
        </button>
      </div>
      {status && <p className="hint">{status}</p>}
      {phase === "found" && available && (
        <div className="about-update">
          <span>
            Versão <strong>{available}</strong> disponível.
          </span>
          <button className="primary" onClick={() => void install()}>
            Atualizar agora
          </button>
        </div>
      )}
      {phase === "working" && <p className="hint">Baixando atualização… {progress}%</p>}
      {phase === "ready" && (
        <div className="about-update">
          <span>Atualização instalada.</span>
          <button className="primary" onClick={() => void restart()}>
            Reiniciar agora
          </button>
        </div>
      )}
      {phase === "handed-off" && <p className="hint">O instalador do sistema foi aberto com o pacote novo.</p>}
      {phase === "restart-failed" && (
        <p className="hint">Atualização instalada. Feche e abra o app para concluir.{message ? ` (${message})` : ""}</p>
      )}
      {phase === "error" && <p className="error">Falha ao atualizar: {message}</p>}
    </section>

    <section className="settings-section">
      <h3>Programa beta</h3>
      <p className="hint">
        Recebe as versões beta antes de todo mundo, além das versões normais. Uma beta pode ter problemas que a versão
        normal não tem. Ao sair, o app fica na versão instalada até sair uma versão normal mais nova.
      </p>
      <div className="chip-row">
        <button
          className={`chip ${betaChannel ? "on" : ""}`}
          onClick={() => {
            setBetaChannel(true);
            void look();
          }}
        >
          Participar do beta
        </button>
        <button
          className={`chip ${!betaChannel ? "on" : ""}`}
          onClick={() => {
            setBetaChannel(false);
            void look();
          }}
        >
          Só versões normais
        </button>
      </div>
    </section>

    <ErrorReportsSection version={version} kind={INSTALL_LABEL[kind] ?? kind} />

    <LegacyImportSection />

    <section className="settings-section">
      <h3>Diagnóstico</h3>
      <p className="hint">Mostra no painel da direita os eventos crus que o Claude Code envia ao app. Útil quando o status das abas ou as permissões param.</p>
      <div className="chip-row">
        <button className={`chip ${showEvents ? "on" : ""}`} onClick={() => setShowEvents(true)}>
          Mostrar eventos
        </button>
        <button className={`chip ${!showEvents ? "on" : ""}`} onClick={() => setShowEvents(false)}>
          Esconder
        </button>
      </div>
    </section>

    <section className="settings-section">
      <h3>Novidades</h3>
      <ol className="changelog">
        {CHANGELOG.map((entry) => (
          <li key={entry.version}>
            <div className="changelog-head">
              <strong>{entry.version}</strong>
              {entry.version.includes("-beta") && <span className="changelog-tag beta">beta</span>}
              {entry.version === version && <span className="changelog-tag">instalada</span>}
              <time>{new Date(`${entry.date}T12:00:00`).toLocaleDateString()}</time>
            </div>
            <ul>
              {entry.items.map((item) => (
                <li key={item}>{withShortcuts(item)}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
    </>
  );
}

/** Official plugins bundled with the app, each turned on or off here. */
function PluginsTab() {
  const { enabledPlugins, setPluginEnabled } = useStore();
  return (
    <section className="settings-section">
      <h3>Plugins oficiais</h3>
      <p className="hint">
        Recursos que vêm com o Shellhive e podem ser ligados ou desligados. Uma mudança vale para as sessões abertas
        depois dela; nas que já estão abertas, reabra a aba.
      </p>
      <ul className="plugin-list">
        {PLUGINS.map(({ manifest }) => {
          const on = enabledPlugins.includes(manifest.id);
          return (
            <li key={manifest.id}>
              <div className="plugin-info">
                <strong>{manifest.name}</strong>
                <p>{manifest.description}</p>
              </div>
              <div className="chip-row">
                <button className={`chip ${on ? "on" : ""}`} onClick={() => setPluginEnabled(manifest.id, true)}>
                  Ligado
                </button>
                <button className={`chip ${!on ? "on" : ""}`} onClick={() => setPluginEnabled(manifest.id, false)}>
                  Desligado
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const FONT_PRESETS = ["Geist Mono", "Menlo", "SF Mono"];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A number with − and + buttons, kept within [min, max]. */
function Stepper({
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  format: (n: number) => string;
  onChange: (n: number) => void;
}) {
  const move = (dir: number) => onChange(round2(Math.min(max, Math.max(min, value + dir * step))));
  return (
    <div className="stepper">
      <button className="chip" disabled={value <= min} onClick={() => move(-1)}>
        −
      </button>
      <span className="stepper-value">{format(value)}</span>
      <button className="chip" disabled={value >= max} onClick={() => move(1)}>
        +
      </button>
    </div>
  );
}

/** Terminal font overrides; every field falls back to the theme's choice. */
function TerminalFontSection() {
  const { theme, terminalFont, setTerminalFont, resetTerminalFont } = useStore();
  const [custom, setCustom] = useState(
    terminalFont.family !== null && !FONT_PRESETS.includes(terminalFont.family),
  );
  const themeLine = THEMES[theme].lineHeight;
  const decimal = (n: number) => n.toFixed(2).replace(".", ",");
  const untouched = Object.values(terminalFont).every((v) => v === null);

  return (
    <section className="settings-section">
      <h3>Fonte do terminal</h3>
      <div className="field">
        <span>Fonte</span>
        <div className="chip-row">
          <button
            className={`chip ${terminalFont.family === null && !custom ? "on" : ""}`}
            onClick={() => {
              setCustom(false);
              setTerminalFont({ family: null });
            }}
          >
            Do tema
          </button>
          {FONT_PRESETS.map((f) => (
            <button
              key={f}
              className={`chip ${terminalFont.family === f && !custom ? "on" : ""}`}
              onClick={() => {
                setCustom(false);
                setTerminalFont({ family: f });
              }}
            >
              {f}
            </button>
          ))}
          <button className={`chip ${custom ? "on" : ""}`} onClick={() => setCustom(true)}>
            Outra…
          </button>
        </div>
        {custom && (
          <input
            placeholder="Nome de uma fonte instalada, ex. JetBrains Mono"
            defaultValue={terminalFont.family ?? ""}
            onChange={(e) => setTerminalFont({ family: e.target.value.trim() || null })}
          />
        )}
      </div>
      <div className="font-steppers">
        <div className="field">
          <span>Tamanho</span>
          <Stepper
            value={terminalFont.size ?? DEFAULT_FONT_SIZE}
            min={10}
            max={18}
            step={1}
            format={(n) => `${n} px`}
            onChange={(size) => setTerminalFont({ size })}
          />
        </div>
        <div className="field">
          <span>Altura da linha</span>
          <Stepper
            value={terminalFont.lineHeight ?? round2(themeLine)}
            min={1}
            max={1.6}
            step={0.05}
            format={decimal}
            onChange={(lineHeight) => setTerminalFont({ lineHeight })}
          />
        </div>
        <div className="field">
          <span>Espaço entre letras</span>
          <Stepper
            value={terminalFont.letterSpacing ?? 0}
            min={-1}
            max={2}
            step={0.5}
            format={(n) => `${decimal(n)} px`}
            onChange={(letterSpacing) => setTerminalFont({ letterSpacing })}
          />
        </div>
      </div>
      <div className="row">
        <button
          className="ghost auto"
          disabled={untouched}
          onClick={() => {
            setCustom(false);
            resetTerminalFont();
          }}
        >
          Restaurar padrão do tema
        </button>
      </div>
    </section>
  );
}

function SettingsDialog({ initialTab, onClose }: { initialTab?: SettingsTab; onClose: () => void }) {
  const {
    folders,
    removeFolder,
    renameFolder,
    defaultFolderId,
    setDefaultFolder,
    layout,
    setLayout,
    barPosition,
    setBarPosition,
    terminalBorder,
    setTerminalBorder,
    tabTitleWrap,
    setTabTitleWrap,
    groupTint,
    setGroupTint,
    miniPanel,
    setMiniPanel,
    theme,
    setTheme,
  } = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "aparencia");

  return (
    <Modal title="Configurações" onClose={onClose}>
      <nav className="modal-tabs">
        <button className={tab === "aparencia" ? "on" : ""} onClick={() => setTab("aparencia")}>
          Aparência
        </button>
        <button className={tab === "pastas" ? "on" : ""} onClick={() => setTab("pastas")}>
          Pastas
        </button>
        <button className={tab === "plugins" ? "on" : ""} onClick={() => setTab("plugins")}>
          Plugins
        </button>
        <button className={tab === "sobre" ? "on" : ""} onClick={() => setTab("sobre")}>
          Sobre
        </button>
      </nav>

      {tab === "sobre" && <AboutTab />}

      {tab === "plugins" && <PluginsTab />}

      {tab === "aparencia" && (
      <>
      <section className="settings-section">
        <h3>Tema</h3>
        <p className="hint">No macOS, o Glass deixa o fundo da janela translúcido; nos outros sistemas ele usa um fundo sólido.</p>
        <div className="chip-row">
          {(Object.keys(THEMES) as ThemeId[]).map((id) => (
            <button key={id} className={`chip ${theme === id ? "on" : ""}`} onClick={() => setTheme(id)}>
              {THEMES[id].label}
            </button>
          ))}
        </div>
      </section>

      <TerminalFontSection />

      <section className="settings-section">
        <h3>Lista de sessões</h3>
        <div className="chip-row">
          <button className={`chip ${layout === "sidebar" ? "on" : ""}`} onClick={() => setLayout("sidebar")}>
            Lateral
          </button>
          <button className={`chip ${layout === "topbar" ? "on" : ""}`} onClick={() => setLayout("topbar")}>
            Superior
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3>Mini painel flutuante</h3>
        <p className="hint">
          Janela pequena, sempre por cima, com o estado de cada sessão. {shortcutLabel("miniPanel")} liga e desliga.
        </p>
        <div className="chip-row">
          <button className={`chip ${miniPanel ? "on" : ""}`} onClick={() => setMiniPanel(true)}>
            Ligado
          </button>
          <button className={`chip ${!miniPanel ? "on" : ""}`} onClick={() => setMiniPanel(false)}>
            Desligado
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3>Fundo dos grupos</h3>
        <div className="chip-row">
          {(
            [
              ["subtle", "Sutil"],
              ["strong", "Marcado"],
              ["none", "Sem fundo"],
            ] as const
          ).map(([value, label]) => (
            <button key={value} className={`chip ${groupTint === value ? "on" : ""}`} onClick={() => setGroupTint(value)}>
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h3>Nomes longos na lista lateral</h3>
        <div className="chip-row">
          <button
            className={`chip ${tabTitleWrap === "wrap" ? "on" : ""}`}
            onClick={() => setTabTitleWrap("wrap")}
          >
            Quebrar em linhas
          </button>
          <button
            className={`chip ${tabTitleWrap === "truncate" ? "on" : ""}`}
            onClick={() => setTabTitleWrap("truncate")}
          >
            Cortar com …
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3>Barra de limites</h3>
        <div className="chip-row">
          <button
            className={`chip ${barPosition === "top" ? "on" : ""}`}
            onClick={() => setBarPosition("top")}
          >
            No topo
          </button>
          <button
            className={`chip ${barPosition === "bottom" ? "on" : ""}`}
            onClick={() => setBarPosition("bottom")}
          >
            Embaixo
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3>Borda do terminal</h3>
        <div className="chip-row">
          {BORDER_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`chip ${terminalBorder === o.value ? "on" : ""}`}
              onClick={() => setTerminalBorder(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </section>
      </>
      )}

      {tab === "pastas" && (
      <>
      <section className="settings-section">
        <h3>Pasta base de abertura</h3>
        <p className="hint">Usada pelo grupo Sem grupo e como sugestão inicial dos demais.</p>
        <FolderChoice
          value={defaultFolderId}
          onChange={setDefaultFolder}
          allowNone
          noneLabel="Perguntar toda vez"
        />
      </section>

      <section className="settings-section">
        <h3>Pastas de trabalho</h3>
        <p className="hint">Toda sessão nova abre em uma destas pastas.</p>
        <AddFolder />
        <ul className="folder-manage">
          {folders.map((f) => (
            <li key={f.id}>
              {editing === f.id ? (
                <input
                  className="inline-edit"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => {
                    if (draft.trim()) renameFolder(f.id, draft.trim());
                    setEditing(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
              ) : (
                <span
                  className="folder-name"
                  title="Duplo clique para renomear"
                  onDoubleClick={() => {
                    setDraft(f.name);
                    setEditing(f.id);
                  }}
                >
                  {f.name}
                </span>
              )}
              <span className="folder-path" title={f.path}>
                {f.path}
              </span>
              <button className="icon-btn" title="Remover" onClick={() => removeFolder(f.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      </section>
      </>
      )}
    </Modal>
  );
}

function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const { addGroup, folders } = useStore();
  const [name, setName] = useState("");
  const [folderId, setFolderId] = useState<string | null>(null);

  const create = () => {
    addGroup(name.trim() || undefined, folderId);
    onClose();
  };

  return (
    <Modal
      title="Novo grupo"
      onClose={onClose}
      footer={
        <>
          <button className="ghost auto" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary" onClick={create}>
            Criar grupo
          </button>
        </>
      }
    >
      <label className="field">
        <span>Nome</span>
        <input
          autoFocus
          placeholder="Vakinha, API, estudos…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
        />
      </label>
      <section className="settings-section">
        <h3>Pasta base (opcional)</h3>
        <p className="hint">Com pasta base, sessões novas do grupo abrem direto nela.</p>
        <FolderChoice value={folderId} onChange={setFolderId} allowNone noneLabel="Perguntar toda vez" />
        {folders.length === 0 && <AddFolder onAdded={setFolderId} />}
      </section>
    </Modal>
  );
}

function PickFolderDialog({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const { folders, addTab, setGroupFolder, groups } = useStore();
  const group = groups.find((g) => g.id === groupId);
  const [remember, setRemember] = useState(false);

  const openIn = (path: string, name: string, folderId?: string) => {
    if (remember && folderId) setGroupFolder(groupId, folderId);
    addTab(groupId, { cwd: path, title: name });
    onClose();
  };

  const browseOnce = async () => {
    const picked = await open({ directory: true, multiple: false, title: "Abrir sessão em" });
    if (typeof picked !== "string") return;
    const check = await invoke<PathCheck>("path_check", { path: picked });
    openIn(check.expanded, check.name ?? check.expanded);
  };

  const openHome = async () => {
    const home = await invoke<string>("home_dir");
    openIn(home, "~");
  };

  return (
    <Modal
      title={group ? `Nova sessão em ${group.name}` : "Nova sessão"}
      onClose={onClose}
      footer={
        <>
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            usar como pasta base do grupo
          </label>
          <button className="ghost auto" onClick={() => void browseOnce()}>
            Outra pasta…
          </button>
          <button className="ghost auto" onClick={() => void openHome()}>
            Pasta pessoal
          </button>
        </>
      }
    >
      {folders.length === 0 ? (
        <>
          <p className="hint">Nenhuma pasta configurada. Adicione a primeira:</p>
          <AddFolder />
        </>
      ) : (
        <ul className="folder-choice pick">
          {folders.map((f) => (
            <li key={f.id} onClick={() => openIn(f.path, f.name, f.id)}>
              <span className="folder-name">{f.name}</span>
              <span className="folder-path" title={f.path}>
                {f.path}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function Dialogs() {
  const { modal, openModal } = useStore();
  const close = () => openModal(null);
  if (!modal) return null;
  if (modal.kind === "settings") return <SettingsDialog initialTab={modal.tab} onClose={close} />;
  if (modal.kind === "newGroup") return <NewGroupDialog onClose={close} />;
  if (modal.kind === "switcher") return <QuickSwitcher onClose={close} />;
  return <PickFolderDialog groupId={modal.groupId} onClose={close} />;
}
