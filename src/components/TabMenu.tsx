import { useEffect, useRef } from "react";
import { duplicateSession, useStore } from "../lib/store";
import { closeDetachedWindow } from "../lib/detach";
import { runPluginTool } from "../lib/pluginEffects";
import { pluginTab } from "../lib/localPlugins";
import { notify } from "../lib/notify";
import { terminals } from "../lib/terminals";
import { copySelection } from "../lib/copyLine";
import { ONE_LINE_COPY_LABEL } from "../lib/shortcuts";

/** Right-click menu for a tab or a terminal pane. */
export function TabMenu() {
  const {
    tabMenu,
    openTabMenu,
    startPaneAssign,
    closeTab,
    closePane,
    sleepTab,
    tabs,
    detached,
    detachTab,
    setTabView,
    panes,
    pinned,
    togglePinned,
    localPlugins,
    enabledPlugins,
    openPluginPanel,
    groups,
  } = useStore();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!tabMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) openTabMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && openTabMenu(null);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [tabMenu, openTabMenu]);

  if (!tabMenu) return null;
  const tab = tabs.find((t) => t.id === tabMenu.tabId);
  if (!tab) return null;
  const isDetached = detached.includes(tab.id);
  const inPane = panes.includes(tab.id);
  const term = isDetached ? undefined : terminals.get(tab.id);

  return (
    <div
      ref={ref}
      className="group-menu"
      style={{ left: Math.min(tabMenu.x, window.innerWidth - 230), top: tabMenu.y + 4 }}
    >
      <div className="menu-heading">{tab.title}</div>
      {term?.hasSelection() && (
        <button
          className="menu-item"
          onClick={() => {
            copySelection(term, true);
            openTabMenu(null);
          }}
        >
          Copiar como uma linha<span className="muted">{ONE_LINE_COPY_LABEL}</span>
        </button>
      )}
      {!isDetached && tab.state !== "dormant" && (
        <button
          className="menu-item"
          onClick={() => {
            setTabView(tab.id, tab.view === "chat" ? undefined : "chat");
            openTabMenu(null);
          }}
        >
          {tab.view === "chat" ? "Ver como terminal" : "Ver como chat"}
        </button>
      )}
      {isDetached ? (
        <button
          className="menu-item"
          onClick={() => {
            closeDetachedWindow(tab.id);
            openTabMenu(null);
          }}
        >
          Voltar para esta janela
        </button>
      ) : (
        <>
          <button className="menu-item" onClick={() => startPaneAssign(tab.id)}>
            Colocar em um painel…
          </button>
          {tab.state !== "dormant" && (
            <button
              className="menu-item"
              onClick={() => {
                detachTab(tab.id);
                openTabMenu(null);
              }}
            >
              Mover para nova janela
            </button>
          )}
        </>
      )}
      {localPlugins
        .filter((p) => p.status === "approved" && enabledPlugins.includes(p.id))
        .flatMap((p) => p.menu.map((item) => ({ p, item })))
        .map(({ p, item }) => (
          <button
            key={`${p.id}:${item.label}`}
            className="menu-item"
            title={p.name}
            onClick={() => {
              openTabMenu(null);
              void runPluginTool(p, item.tool, tab.id, { tab: pluginTab(tab, groups) })
                .then((r) => {
                  if (r.isError) void notify(p.name, r.text, true);
                })
                .catch((err) => notify(p.name, String(err), true));
            }}
          >
            {item.label}
          </button>
        ))}
      {localPlugins
        .filter((p) => p.status === "approved" && p.panel && enabledPlugins.includes(p.id))
        .map((p) => (
          <button
            key={p.id}
            className="menu-item"
            onClick={() => {
              openPluginPanel({ plugin: p.id, tabId: tab.id, data: null });
              openTabMenu(null);
            }}
          >
            Abrir painel: {p.panel!.title}
          </button>
        ))}
      {tab.claudeSessionId && (
        <button
          className="menu-item"
          title="Abre uma cópia desta sessão numa aba nova; a original continua aqui"
          onClick={() => {
            duplicateSession(tab.id);
            openTabMenu(null);
          }}
        >
          Duplicar sessão
        </button>
      )}
      {tab.claudeSessionId && (
        <button
          className="menu-item"
          onClick={() => {
            togglePinned(tab.claudeSessionId!);
            openTabMenu(null);
          }}
        >
          {pinned.includes(tab.claudeSessionId) ? "Desafixar sessão" : "Fixar sessão"}
        </button>
      )}
      <div className="menu-sep" />
      {inPane && !isDetached && (
        <button
          className="menu-item"
          title="Libera o painel; a sessão continua na lista"
          onClick={() => {
            closePane(tab.id);
            openTabMenu(null);
          }}
        >
          Fechar terminal
        </button>
      )}
      {tab.state !== "dormant" && (
        <button
          className="menu-item"
          title="Encerra o terminal; a aba fica na lista e a conversa volta ao clicar nela"
          onClick={() => {
            sleepTab(tab.id);
            openTabMenu(null);
          }}
        >
          Suspender sessão
        </button>
      )}
      <button
        className="menu-item danger"
        title="Encerra a sessão e a manda para o Histórico"
        onClick={() => {
          closeTab(tab.id);
          openTabMenu(null);
        }}
      >
        Arquivar sessão
      </button>
    </div>
  );
}
