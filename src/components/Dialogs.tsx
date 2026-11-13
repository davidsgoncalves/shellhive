import { useEffect, useState, type ReactNode } from "react";
import { sendPerfReport } from "../lib/perfDiag";
import { CopyCommand } from "./UpdateBanner";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { installKind, RELEASES_URL } from "../lib/update";
import { useUpdater } from "../lib/updater";
import type { ReportsState } from "../lib/errors";
import { shortcutLabel, withShortcuts } from "../lib/shortcuts";
import { startSession, useStore, type SettingsTab } from "../lib/store";
import { CLAUDE_MODELS as MODELS, SESSION_KINDS } from "../lib/providers";
import { openPluginCreator } from "../lib/pluginCreator";
import { ConnectionsTab } from "./WorkSettings";
import { DEFAULT_FONT_SIZE, THEMES, type ThemeId } from "../lib/theme";
import { Modal } from "./Modal";
import { browseFolder, FolderList, useRecentFolders } from "./FolderFields";
import { BORDER_OPTIONS } from "../lib/types";
import { QuickSwitcher } from "./QuickSwitcher";
import { SearchAll } from "./SearchAll";
import changelog from "../changelog.json";
import type { Folder, SessionKind } from "../lib/types";

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

/** One setting: its name and an optional line on the left, its control on the right. */
function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </div>
      {children && <div className="set-ctl">{children}</div>}
    </div>
  );
}

/** A titled block of settings. */
function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      <div className="set-rows">{children}</div>
    </section>
  );
}

/** A segmented choice between a few values. */
function Seg<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={String(v)} role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={disabled}
      className={`toggle ${on ? "on" : ""}`}
      onClick={() => onChange(!on)}
    />
  );
}

/** Copies the Claude Terminal data in again, over the current data. */
function LegacyImportBlock() {
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
    <Block title="Dados">
      <Row label="Importar do Claude Terminal" hint={error ?? "Substitui os dados atuais pela cópia antiga e reinicia o app"}>
        <button className={`ghost auto ${confirming ? "danger" : ""}`} onClick={reimport}>
          {confirming ? "Confirmar e reiniciar" : "Importar"}
        </button>
      </Row>
    </Block>
  );
}

const ISSUE_BODY_MAX = 6000;

/** Opt-in error reports, the raw events panel, and a GitHub issue carrying the local error log. */
function SupportBlock({ version, kind }: { version: string; kind: string }) {
  const [state, setState] = useState<ReportsState | null>(null);
  const { showEvents, setShowEvents } = useStore();

  useEffect(() => {
    void invoke<ReportsState>("error_reports_get").then(setState).catch(() => {});
  }, []);

  const [diag, setDiag] = useState<{ busy: boolean; text: string | null; error: boolean }>({ busy: false, text: null, error: false });
  const sendDiagnostic = async () => {
    setDiag({ busy: true, text: null, error: false });
    try {
      const id = await sendPerfReport(version);
      setDiag({ busy: false, text: `Enviado. Código do diagnóstico: ${id}`, error: false });
    } catch (err) {
      setDiag({ busy: false, text: String(err), error: true });
    }
  };

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
    <Block title="Suporte">
      <Row
        label="Enviar relatórios de erro"
        hint={
          state?.available
            ? "Sem nada do que você digita ou vê no terminal. Pastas, usuário e tokens são removidos antes."
            : "Esta versão não tem o envio configurado. Os erros ficam só no registro local."
        }
      >
        {state?.available && <Toggle on={state.enabled} onChange={toggle} />}
      </Row>
      <Row label="Eventos crus do Claude Code" hint="Mostra no painel da direita, para quando o status das abas ou as permissões param">
        <Toggle on={showEvents} onChange={setShowEvents} />
      </Row>
      <Row
        label="Relatar um problema"
        hint={
          diag.text ??
          (state?.available
            ? "O diagnóstico leva o uso de memória e processador dos últimos 30 minutos, sem nomes de abas, pastas nem o terminal"
            : undefined)
        }
      >
        <button className="ghost auto" onClick={() => void reportProblem()}>
          Relatar
        </button>
        {state?.available && (
          <button
            className="ghost auto"
            disabled={diag.busy || !state.enabled}
            title={state.enabled ? undefined : "Ligue o envio de relatórios para mandar o diagnóstico"}
            onClick={() => void sendDiagnostic()}
          >
            {diag.busy ? "Enviando…" : "Enviar diagnóstico"}
          </button>
        )}
      </Row>
    </Block>
  );
}

function AboutPage() {
  const [version, setVersion] = useState("…");
  const [kind, setKind] = useState("…");
  const [status, setStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [news, setNews] = useState(false);
  const { version: available, phase, progress, message, look: lookForUpdate, install, restart } = useUpdater();
  const { updateChannel, setUpdateChannel, setTourOpen, openModal } = useStore();

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

  const kindLabel = INSTALL_LABEL[kind] ?? kind;

  return (
    <>
      <Block title="Versão">
        <Row label={`Shellhive ${version}`} hint={status ?? kindLabel}>
          <button className="ghost auto" onClick={() => void look()} disabled={checking}>
            {checking ? "Verificando…" : "Procurar atualização"}
          </button>
          <button className="ghost auto" onClick={() => setNews(!news)}>
            Novidades
          </button>
        </Row>
        {phase === "found" && available && (
          <Row label={`Versão ${available} disponível`}>
            <button className="primary" onClick={() => void install()}>
              Atualizar agora
            </button>
          </Row>
        )}
        {phase === "working" && <Row label="Baixando a atualização…" hint={`${progress}%`} />}
        {phase === "ready" && (
          <Row label="Atualização instalada">
            <button className="primary" onClick={() => void restart()}>
              Reiniciar agora
            </button>
          </Row>
        )}
        {phase === "restart-failed" && (
          <Row label="Atualização instalada" hint={`Feche e abra o app para concluir.${message ? ` (${message})` : ""}`} />
        )}
        {phase === "error" && (
          <Row label="Falha ao atualizar" hint={message}>
            <CopyCommand message={message} />
          </Row>
        )}
        <Row label="Canal" hint="Beta e alpha recebem versões antes, menos testadas. Ao voltar, o app espera a próxima versão do canal.">
          <Seg
            value={updateChannel}
            options={[
              ["regular", "Normal"],
              ["beta", "Beta"],
              ["alpha", "Alpha"],
            ]}
            onChange={(v) => {
              setUpdateChannel(v);
              void look();
            }}
          />
        </Row>
        {news && (
          <div className="set-news">
            <div className="row">
              <button
                className="ghost auto"
                onClick={() => {
                  openModal(null);
                  setTourOpen(true);
                }}
              >
                Ver o tour
              </button>
              <button className="ghost auto" onClick={() => void openUrl(RELEASES_URL)}>
                Ver releases
              </button>
            </div>
            <ol className="changelog">
              {CHANGELOG.map((entry) => (
                <li key={entry.version}>
                  <div className="changelog-head">
                    <strong>{entry.version}</strong>
                    {entry.version.includes("-beta") && <span className="changelog-tag beta">beta</span>}
                    {entry.version.includes("-alpha") && <span className="changelog-tag beta">alpha</span>}
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
          </div>
        )}
      </Block>

      <SupportBlock version={version} kind={kindLabel} />

      <LegacyImportBlock />
    </>
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

/** Terminal font and border; every font field falls back to the theme's choice. */
function TerminalBlock() {
  const { theme, terminalFont, setTerminalFont, resetTerminalFont, terminalBorder, setTerminalBorder } = useStore();
  const [custom, setCustom] = useState(
    terminalFont.family !== null && !FONT_PRESETS.includes(terminalFont.family),
  );
  const [fine, setFine] = useState(false);
  const themeLine = THEMES[theme].lineHeight;
  const decimal = (n: number) => n.toFixed(2).replace(".", ",");
  const untouched = Object.values(terminalFont).every((v) => v === null);
  const family = custom ? "__other" : (terminalFont.family ?? "");

  return (
    <Block title="Terminal">
      <Row label="Fonte">
        <select
          className="select"
          value={family}
          onChange={(e) => {
            const v = e.target.value;
            setCustom(v === "__other");
            if (v !== "__other") setTerminalFont({ family: v || null });
          }}
        >
          <option value="">Do tema</option>
          {FONT_PRESETS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
          <option value="__other">Outra…</option>
        </select>
      </Row>
      {custom && (
        <Row label="Nome da fonte" hint="Uma fonte instalada, ex. JetBrains Mono">
          <input
            defaultValue={terminalFont.family ?? ""}
            onChange={(e) => setTerminalFont({ family: e.target.value.trim() || null })}
          />
        </Row>
      )}
      <Row label="Tamanho">
        <Stepper
          value={terminalFont.size ?? DEFAULT_FONT_SIZE}
          min={10}
          max={18}
          step={1}
          format={(n) => `${n} px`}
          onChange={(size) => setTerminalFont({ size })}
        />
      </Row>
      <Row label="Borda">
        <Seg value={terminalBorder} options={BORDER_OPTIONS.map((o) => [o.value, o.label] as const)} onChange={setTerminalBorder} />
      </Row>
      <button className="link set-more" onClick={() => setFine(!fine)} aria-expanded={fine}>
        Ajuste fino: altura da linha e espaço entre letras {fine ? "▾" : "▸"}
      </button>
      {fine && (
        <>
          <Row label="Altura da linha">
            <Stepper
              value={terminalFont.lineHeight ?? round2(themeLine)}
              min={1}
              max={1.6}
              step={0.05}
              format={decimal}
              onChange={(lineHeight) => setTerminalFont({ lineHeight })}
            />
          </Row>
          <Row label="Espaço entre letras">
            <Stepper
              value={terminalFont.letterSpacing ?? 0}
              min={-1}
              max={2}
              step={0.5}
              format={(n) => `${decimal(n)} px`}
              onChange={(letterSpacing) => setTerminalFont({ letterSpacing })}
            />
          </Row>
          <Row label="Padrão do tema">
            <button
              className="ghost auto"
              disabled={untouched}
              onClick={() => {
                setCustom(false);
                resetTerminalFont();
              }}
            >
              Restaurar
            </button>
          </Row>
        </>
      )}
    </Block>
  );
}

const SETTINGS_PAGES: Array<[SettingsTab, string]> = [
  ["aparencia", "Aparência"],
  ["sessoes", "Sessões"],
  ["avisos", "Avisos"],
  ["conexoes", "Conexões"],
  ["sobre", "Sobre"],
];

function SettingsDialog({ initialTab, onClose }: { initialTab?: SettingsTab; onClose: () => void }) {
  const {
    layout,
    setLayout,
    barPosition,
    setBarPosition,
    tabTitleWrap,
    setTabTitleWrap,
    closeAction,
    setCloseAction,
    miniPanel,
    setMiniPanel,
    theme,
    setTheme,
    cacheStyle,
    setCacheStyle,
  } = useStore();
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "aparencia");
  const title = SETTINGS_PAGES.find(([id]) => id === tab)?.[1] ?? "Configurações";

  return (
    <Modal
      title={title}
      onClose={onClose}
      className="settings"
      aside={
        <>
          <h2>Configurações</h2>
          {SETTINGS_PAGES.map(([id, label]) => (
            <button key={id} className={`settings-nav ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </>
      }
    >
      {tab === "aparencia" && (
        <>
          <Block title="Tema">
            <Row
              label="Tema do app"
              hint={
                (theme === "glow-light" || theme === "sobrio-light")
                  ? "O Claude Code desenha as próprias cores: rode /theme dentro dele e escolha um tema claro"
                  : "Cores do app e do terminal"
              }
            >
              {(Object.keys(THEMES) as ThemeId[]).map((id) => (
                <button key={id} className={`theme-tile ${id} ${theme === id ? "on" : ""}`} onClick={() => setTheme(id)}>
                  <span className="theme-swatch" />
                  {THEMES[id].label}
                </button>
              ))}
            </Row>
          </Block>
          <TerminalBlock />
        </>
      )}

      {tab === "sessoes" && (
        <Block title="Lista de sessões">
          <Row label="Posição">
            <Seg
              value={layout}
              options={[
                ["sidebar", "Lateral"],
                ["topbar", "Superior"],
              ]}
              onChange={setLayout}
            />
          </Row>
          <Row label="Nomes longos">
            <Seg
              value={tabTitleWrap}
              options={[
                ["wrap", "Quebrar em linhas"],
                ["truncate", "Cortar com …"],
              ]}
              onChange={setTabTitleWrap}
            />
          </Row>
          <Row
            label="Botão × das abas"
            hint={
              closeAction === "archive"
                ? "Encerra a sessão e a manda para o Histórico"
                : closeAction === "pane"
                  ? "Só libera o painel; a sessão continua rodando na lista"
                  : "Encerra o terminal e deixa a aba fechada na lista; a conversa volta ao clicar nela"
            }
          >
            <select className="select" value={closeAction} onChange={(e) => setCloseAction(e.target.value as typeof closeAction)}>
              <option value="archive">Arquivar sessão</option>
              <option value="pane">Fechar terminal</option>
              <option value="sleep">Suspender sessão</option>
            </select>
          </Row>
        </Block>
      )}

      {tab === "avisos" && (
        <>
          <Block title="Na tela">
            <Row label="Cache do Claude" hint="Em cima de uma sessão esperando você, com contexto grande">
              <Seg
                value={cacheStyle}
                options={[
                  ["expressive", "Expressivo"],
                  ["minimal", "Minimalista"],
                ]}
                onChange={setCacheStyle}
              />
            </Row>
            <Row label="Barra de limites">
              <Seg
                value={barPosition}
                options={[
                  ["top", "No topo"],
                  ["bottom", "Embaixo"],
                ]}
                onChange={setBarPosition}
              />
            </Row>
          </Block>
          <Block title="Fora do app">
            <Row
              label="Mini painel flutuante"
              hint={`Janela pequena, sempre por cima, com o estado de cada sessão. ${shortcutLabel("miniPanel")} liga e desliga`}
            >
              <Toggle on={miniPanel} onChange={setMiniPanel} />
            </Row>
          </Block>
        </>
      )}

      {tab === "conexoes" && <ConnectionsTab />}

      {tab === "sobre" && <AboutPage />}
    </Modal>
  );
}

function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const addGroup = useStore((s) => s.addGroup);
  const recent = useRecentFolders();
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
          placeholder="Trabalho, API, estudos…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
        />
      </label>
      <section className="settings-section">
        <h3>Pasta</h3>
        <div className="set-rows">
          <p className="hint">As sessões do grupo abrem nela. Sem escolher agora, a primeira sessão pergunta.</p>
          {recent.length > 0 && <FolderList folders={recent} value={folderId} onPick={(f) => setFolderId(f.id === folderId ? null : f.id)} />}
          <div className="row">
            <button
              className="ghost auto"
              onClick={() => void browseFolder("Pasta do grupo").then((f) => f && setFolderId(f.id))}
            >
              Procurar…
            </button>
          </div>
        </div>
      </section>
    </Modal>
  );

}


export const PERMISSION_MODES: Array<[string, string]> = [
  ["manual", "Perguntar tudo"],
  ["acceptEdits", "Aceitar edições"],
  ["auto", "Automático"],
  ["plan", "Só planejar"],
  ["dontAsk", "Não perguntar"],
  ["bypassPermissions", "Ignorar permissões"],
];

/** How `claude` starts in a group's tabs: model, permission mode and first prompt. */
function GroupLaunchDialog({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const { groups, setGroupLaunch } = useStore();
  const group = groups.find((g) => g.id === groupId);
  const [openAs, setOpenAs] = useState<SessionKind>(group?.launch?.open ?? "terminal");
  const [model, setModel] = useState(group?.launch?.model ?? "");
  const [mode, setMode] = useState(group?.launch?.permissionMode ?? "");
  const [prompt, setPrompt] = useState(group?.launch?.prompt ?? "");
  if (!group) return null;

  const save = () => {
    setGroupLaunch(groupId, {
      open: openAs === "terminal" ? null : openAs,
      model: model.trim() || null,
      permissionMode: mode || null,
      prompt: prompt.trim() || null,
    });
    onClose();
  };

  return (
    <Modal
      title={`Abas novas em ${group.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="ghost auto" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary" onClick={save}>
            Salvar
          </button>
        </>
      }
    >
      <p className="hint">
        Vale para as abas abertas depois de salvar. Modelo, modo de permissão e prompt valem para o Claude; campo vazio deixa o padrão dele.
      </p>
      <label className="field">
        <span>Abrir como</span>
        <select className="bee-select" value={openAs} onChange={(e) => setOpenAs(e.target.value as SessionKind)}>
          {SESSION_KINDS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Modelo</span>
        <input list="group-models" placeholder="Padrão do Claude" value={model} onChange={(e) => setModel(e.target.value)} />
        <datalist id="group-models">
          {MODELS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </datalist>
      </label>
      <label className="field">
        <span>Modo de permissão</span>
        <select className="bee-select" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="">Padrão do Claude</option>
          {PERMISSION_MODES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Prompt inicial</span>
        <textarea
          rows={4}
          placeholder="Enviado ao Claude quando uma aba nova abre no grupo"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
    </Modal>
  );
}

/**
 * Where a session opens. A group without a folder keeps the one picked; `once`
 * opens this session elsewhere, and `change` only sets the group's folder.
 */
function PickFolderDialog({
  groupId,
  kind,
  once,
  change,
  onClose,
}: {
  groupId: string;
  kind?: SessionKind;
  once?: boolean;
  change?: boolean;
  onClose: () => void;
}) {
  const { setGroupFolder, groups } = useStore();
  const recent = useRecentFolders();
  const group = groups.find((g) => g.id === groupId);
  const keeps = !!group && !group.fixed && !once;

  const choose = (f: Folder) => {
    if (keeps) setGroupFolder(groupId, f.id);
    if (!change) startSession(groupId, f.path, f.name, kind);
    onClose();
  };

  const openHome = async () => {
    const home = await invoke<string>("home_dir");
    const id = useStore.getState().addFolder("~", home);
    choose({ id, name: "~", path: home });
  };

  const title = change
    ? `Pasta de ${group?.name ?? "grupo"}`
    : group
      ? `Nova sessão em ${group.name}`
      : "Nova sessão";

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="ghost auto" onClick={() => void browseFolder(change ? "Pasta do grupo" : "Abrir sessão em").then((f) => f && choose(f))}>
            Procurar…
          </button>
          {!change && (
            <button className="ghost auto" onClick={() => void openHome()}>
              Pasta pessoal
            </button>
          )}
        </>
      }
    >
      {keeps && <p className="hint">As próximas sessões de {group?.name} abrem direto na pasta escolhida.</p>}
      {recent.length > 0 ? (
        <FolderList folders={recent} value={change ? group?.folderId : undefined} onPick={choose} />
      ) : (
        <p className="hint">Nenhuma pasta usada ainda. Use Procurar para escolher.</p>
      )}
    </Modal>
  );
}

function PluginCreatorDialog({ onClose }: { onClose: () => void }) {
  const [idea, setIdea] = useState("");
  const start = () => {
    onClose();
    void openPluginCreator(idea);
  };

  return (
    <Modal
      title="Criar plugin com o Claude"
      onClose={onClose}
      footer={
        <>
          <button className="ghost auto" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary" onClick={start}>
            Abrir sessão
          </button>
        </>
      }
    >
      <p className="hint">Abre uma aba no grupo Plugins, na pasta de plugins, com o Claude pronto para montar o plugin.</p>
      <label className="field">
        <span>O que o plugin deve fazer</span>
        <textarea
          rows={4}
          autoFocus
          placeholder="Vazio, o Claude pergunta na sessão"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
        />
      </label>
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
  if (modal.kind === "searchAll") return <SearchAll onClose={close} />;
  if (modal.kind === "groupLaunch") return <GroupLaunchDialog groupId={modal.groupId} onClose={close} />;
  if (modal.kind === "pluginCreator") return <PluginCreatorDialog onClose={close} />;
  return <PickFolderDialog groupId={modal.groupId} kind={modal.open} once={modal.once} change={modal.change} onClose={close} />;
}
