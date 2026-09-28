import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../lib/store";
import { THEMES } from "../lib/theme";
import { describeRule } from "../lib/permRules";

/** Right-click menu for a group: colour, rename, collapse and removal. */
export function GroupMenu() {
  const { groupMenu, openGroupMenu, groups, tabs, setGroupColor, renameGroup, toggleGroupCollapsed, setGroupHidden, ungroupTabs, closeGroup, removeGroupRule, theme } =
    useStore();
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const group = groups.find((g) => g.id === groupMenu?.groupId);

  useEffect(() => {
    setConfirming(false);
    setRenaming(false);
    setDraft(group?.name ?? "");
  }, [groupMenu?.groupId, group?.name]);

  useEffect(() => {
    if (!groupMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) openGroupMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && openGroupMenu(null);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [groupMenu, openGroupMenu]);

  if (!groupMenu || !group) return null;

  const count = tabs.filter((t) => t.groupId === group.id).length;
  const close = () => openGroupMenu(null);

  const commitRename = () => {
    const v = draft.trim();
    if (v && v !== group.name) renameGroup(group.id, v);
    close();
  };

  const removeWithTabs = async () => {
    for (const tab of tabs.filter((t) => t.groupId === group.id)) {
      await invoke("pty_kill", { id: tab.id }).catch(() => {});
    }
    closeGroup(group.id);
    close();
  };

  return (
    <div
      ref={ref}
      className="group-menu"
      style={{ left: Math.min(groupMenu.x, window.innerWidth - 230), top: groupMenu.y + 4 }}
    >
      <div className="menu-colors">
        {THEMES[theme].groupColors.map((c) => (
          <button
            key={c}
            className={`menu-swatch ${group.color === c ? "on" : ""}`}
            style={{ background: c }}
            title="Usar esta cor"
            onClick={() => setGroupColor(group.id, c)}
          />
        ))}
      </div>

      {renaming ? (
        <input
          className="menu-rename"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          onBlur={commitRename}
        />
      ) : (
        <button className="menu-item" onClick={() => setRenaming(true)}>
          Renomear grupo
        </button>
      )}

      <button
        className="menu-item"
        onClick={() => {
          toggleGroupCollapsed(group.id);
          close();
        }}
      >
        {group.collapsed ? "Expandir" : "Recolher"}
      </button>

      <button
        className="menu-item"
        onClick={() => {
          setGroupHidden(group.id, true);
          close();
        }}
      >
        Ocultar grupo
      </button>

      {(group.allowRules?.length ?? 0) > 0 && (
        <>
          <div className="menu-sep" />
          <div className="menu-heading">Permitido sem perguntar</div>
          {group.allowRules!.map((r) => (
            <div key={describeRule(r)} className="menu-rule">
              <code title={describeRule(r)}>{describeRule(r)}</code>
              <button className="icon-btn" title="Remover regra" onClick={() => removeGroupRule(group.id, r)}>
                ×
              </button>
            </div>
          ))}
        </>
      )}

      <div className="menu-sep" />

      <button
        className="menu-item"
        onClick={() => {
          ungroupTabs(group.id);
          close();
        }}
      >
        Desagrupar abas{count > 0 ? ` (${count})` : ""}
      </button>

      <button
        className={`menu-item danger ${confirming ? "confirming" : ""}`}
        onClick={() => (confirming ? void removeWithTabs() : setConfirming(true))}
      >
        {confirming ? "Confirmar: fechar tudo" : "Fechar abas e excluir"}
      </button>
    </div>
  );
}
