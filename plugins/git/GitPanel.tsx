import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { parse } from "diff2html";
import type { DiffFile } from "diff2html/lib/types";
import type { PaneRect } from "../../src/lib/plugins";
import { useStore } from "../../src/lib/store";
import { sendMessage, typeText } from "../../src/lib/typing";
import { agentCommand } from "../../src/lib/providers";
import { api, baseName, errorText, type FileStatus, type Turn, type WorktreeInfo } from "./api";
import { ConflictView } from "./ConflictView";
import { DiffView, type Layout } from "./DiffView";
import { buildPatch, changedKeys, partialOk, quoteLines } from "./patch";
import { useGit, type Mode, type OpenPanel } from "./state";
import { NewWorktreeDialog } from "./worktrees";

type Area = "staged" | "unstaged" | "conflict";

/** What the diff side shows. */
type Pick =
  | { mode: "changes"; area: Area; path: string }
  | { mode: "base"; path: string }
  | { mode: "turns"; turn: string; root: string; path: string };

interface Comment {
  root: string;
  path: string;
  range: string;
  quote: string;
  text: string;
}

const LAYOUT_KEY = "shellhive.git.layout";
const readLayout = (): Layout => {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "side-by-side" ? "side-by-side" : "line-by-line";
  } catch {
    return "line-by-line";
  }
};

const fileName = (f: DiffFile) => (f.newName === "/dev/null" ? f.oldName : f.newName);
const when = (at: number) =>
  new Date(at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function statusLetter(f: FileStatus, area: Area): string {
  if (area === "conflict") return "!";
  if (f.untracked) return "U";
  const c = area === "staged" ? f.staged : f.unstaged;
  return c === "?" ? "U" : c.trim() || "M";
}

/** The Git panel over a tab's terminal. */
export function GitPanel({ tabId, panel, rect }: { tabId: string; panel: OpenPanel; rect: PaneRect | null }) {
  const tab = useStore((s) => s.tabs.find((t) => t.id === tabId));
  const created = useGit((s) => s.created);
  const bases = useGit((s) => s.bases);
  const { show, hide, setBase } = useGit.getState();

  const [roots, setRoots] = useState<string[]>([]);
  const [info, setInfo] = useState<WorktreeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<Pick | null>(null);
  const [diff, setDiff] = useState<DiffFile[]>([]);
  const [baseFiles, setBaseFiles] = useState<DiffFile[]>([]);
  const [refs, setRefs] = useState<string[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [turnFiles, setTurnFiles] = useState<DiffFile[]>([]);
  const [agentLines, setAgentLines] = useState<Record<string, string[]>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>(readLayout);
  const [message, setMessage] = useState("");
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [newWorktree, setNewWorktree] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  const box = useRef<HTMLDivElement>(null);

  const root = panel.root && roots.includes(panel.root) ? panel.root : (roots[0] ?? null);
  const mode = panel.mode;
  const base = (root && bases[root]) || info?.defaultBase || "";

  // Worktrees of this tab: what the agent touched, the tab's folder and the ones it created.
  useEffect(() => {
    const extra = [tab?.cwd, ...created.filter((c) => c.tabId === tabId).map((c) => c.root)].filter(
      (p): p is string => !!p,
    );
    void api.tabWorktrees(tabId, extra).then((list) => {
      const next = list.map((t) => t.root);
      setRoots((prev) => (prev.join("\n") === next.join("\n") ? prev : next));
    });
  }, [tabId, tab?.cwd, created, refresh]);

  // The chosen worktree's state, kept fresh while the agent works.
  useEffect(() => {
    if (!root) return setInfo(null);
    let live = true;
    const load = () => {
      api
        .worktree(root)
        .then((i) => live && (setInfo(i), setError(null)))
        .catch((err) => live && setError(errorText(err)));
      api
        .agentLines(root)
        .then((l) => live && setAgentLines(l))
        .catch(() => {});
    };
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = listen<{ tabId: string | null; type: string }>("plugin-event", (ev) => {
      if (ev.payload.tabId !== tabId) return;
      clearTimeout(timer);
      timer = setTimeout(load, 800);
    });
    const id = setInterval(load, 8000);
    return () => {
      live = false;
      clearTimeout(timer);
      clearInterval(id);
      void sub.then((u) => u());
    };
  }, [root, tabId, refresh]);

  useEffect(() => {
    if (root) void api.refs(root).then(setRefs).catch(() => setRefs([]));
  }, [root]);

  // Turns of this tab.
  useEffect(() => {
    const load = () => void api.turns(tabId).then(setTurns).catch(() => {});
    load();
    const sub = listen<{ tabId: string }>("git-turns-changed", (ev) => ev.payload.tabId === tabId && load());
    return () => void sub.then((u) => u());
  }, [tabId, refresh]);

  // Changes when any file does, so diffs reload without the poll resetting them.
  const filesKey = useMemo(() => JSON.stringify(info?.files ?? []), [info]);

  useEffect(() => {
    setSelected(new Set());
    setAnchor(null);
    setDraft(null);
  }, [pick]);

  // The diff of what is picked.
  useEffect(() => {
    if (!pick || !root) return setDiff([]);
    if (pick.mode === "changes" && pick.area === "conflict") return setDiff([]);
    let live = true;
    const load =
      pick.mode === "changes"
        ? api.diff(root, pick.area as "staged" | "unstaged", { path: pick.path })
        : pick.mode === "base"
          ? api.diff(root, "base", { base, path: pick.path })
          : (() => {
              const t = turns.find((x) => x.id === pick.turn)?.trees.find((w) => w.root === pick.root);
              return t?.to ? api.diff(pick.root, "range", { base: t.from, to: t.to, path: pick.path }) : Promise.resolve("");
            })();
    load
      .then((raw) => live && setDiff(parse(raw)))
      .catch((err) => live && (setDiff([]), setError(errorText(err))));
    return () => {
      live = false;
    };
  }, [pick, root, base, filesKey, turns, refresh]);

  // Files of the comparison with the base.
  useEffect(() => {
    if (mode !== "base" || !root || !base) return setBaseFiles([]);
    let live = true;
    api
      .diff(root, "base", { base })
      .then((raw) => live && setBaseFiles(parse(raw)))
      .catch((err) => live && (setBaseFiles([]), setError(errorText(err))));
    return () => {
      live = false;
    };
  }, [mode, root, base, filesKey, refresh]);

  // Files of the picked turn.
  const turnPick = pick?.mode === "turns" ? pick : null;
  const [openTurn, setOpenTurn] = useState<{ turn: string; root: string } | null>(null);
  useEffect(() => {
    if (!openTurn) return setTurnFiles([]);
    const t = turns.find((x) => x.id === openTurn.turn)?.trees.find((w) => w.root === openTurn.root);
    if (!t?.to) return setTurnFiles([]);
    let live = true;
    api
      .diff(openTurn.root, "range", { base: t.from, to: t.to })
      .then((raw) => live && setTurnFiles(parse(raw)))
      .catch(() => live && setTurnFiles([]));
    return () => {
      live = false;
    };
  }, [openTurn, turns]);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      /* per-viewer convenience only */
    }
  }, [layout]);

  useEffect(() => box.current?.focus(), []);

  const groups = useMemo(() => {
    const files = info?.files ?? [];
    return {
      conflict: files.filter((f) => f.conflict),
      staged: files.filter((f) => !f.conflict && !f.untracked && f.staged.trim() && f.staged !== "?"),
      unstaged: files.filter((f) => !f.conflict && (f.untracked || f.unstaged.trim())),
    };
  }, [info]);

  const file = diff[0] ?? null;
  const agentSet = useMemo(() => {
    const path = file ? fileName(file) : null;
    const lines = path && (pick?.mode !== "turns" || pick.root === root) ? agentLines[path] : undefined;
    return new Set(lines ?? []);
  }, [file, agentLines, pick, root]);

  const orderedKeys = useMemo(() => (file ? file.blocks.flatMap((b, bi) => b.lines.map((_, li) => `${bi}:${li}`)) : []), [file]);

  const onLine = (key: string, extend: boolean) => {
    setSelected((prev) => {
      if (extend && anchor) {
        const a = orderedKeys.indexOf(anchor);
        const b = orderedKeys.indexOf(key);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        return new Set([...prev, ...orderedKeys.slice(lo, hi + 1)]);
      }
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setAnchor(key);
  };

  const onBlock = (block: number) => {
    if (!file) return;
    const keys = changedKeys(file, block);
    setSelected((prev) => (keys.every((k) => prev.has(k)) ? new Set([...prev].filter((k) => !keys.includes(k))) : new Set([...prev, ...keys])));
  };

  const act = async (what: () => Promise<unknown>, done?: string) => {
    if (!root) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await what();
      setSelected(new Set());
      if (done) setNote(done);
      reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const applySelection = (kind: "stage" | "unstage" | "discard") => {
    if (!file || !root) return;
    const patch = buildPatch(file, selected, kind !== "stage");
    if (!patch) return;
    if (kind === "discard" && !window.confirm("Descartar as linhas escolhidas? Não dá para desfazer.")) return;
    void act(() => api.apply(root, patch, kind !== "discard", kind !== "stage"));
  };

  const fileAction = (action: "stage" | "unstage" | "discard", paths: string[]) => {
    if (!root || paths.length === 0) return;
    if (action === "discard" && !window.confirm(`Descartar ${paths.length === 1 ? paths[0] : `${paths.length} arquivos`}? Não dá para desfazer.`))
      return;
    void act(() => api.files(root, action, paths));
  };

  const commit = (push: boolean) =>
    root &&
    void act(async () => {
      const sha = await api.commit(root, message);
      setMessage("");
      if (push) await api.push(root);
      setNote(push ? `Commit ${sha} enviado.` : `Commit ${sha} criado.`);
    });

  const undo = (turn: Turn) => {
    if (!window.confirm("Desfazer este turno? Os arquivos que o agente mudou voltam a como estavam antes dele. Arquivos que mudaram depois ficam como estão.")) return;
    void act(async () => {
      const r = await api.undoTurn(turn.id);
      setNote(
        [
          r.restored.length ? `${r.restored.length} arquivo(s) restaurado(s).` : "Nada para restaurar.",
          r.skipped.length ? `Mudaram depois do turno e ficaram como estão: ${r.skipped.join(", ")}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    });
  };

  const addComment = () => {
    if (!file || !root || !draft?.trim()) return;
    const { range, quote } = quoteLines(file, selected);
    setComments((c) => [...c, { root, path: fileName(file), range, quote, text: draft.trim() }]);
    setDraft(null);
    setSelected(new Set());
  };

  const commentText = () =>
    [
      "Comentários sobre o diff:",
      ...comments.map(
        (c) => `\n${roots.length > 1 ? `${baseName(c.root)}/` : ""}${c.path}${c.range ? ` (${c.range})` : ""}:\n\`\`\`\n${c.quote}\n\`\`\`\n${c.text}`,
      ),
    ].join("\n");

  const sendComments = async (submit: boolean) => {
    if (!tab || comments.length === 0) return;
    const text = commentText();
    try {
      if (tab.provider) {
        await invoke(agentCommand(tab.provider, "send"), { tabId, text, model: tab.agentModel ?? null, images: [] });
      } else if (submit) {
        await sendMessage(tabId, text);
      } else {
        await invoke("pty_write", { id: tabId, data: "\x1b[200~" });
        await typeText(tabId, text);
        await invoke("pty_write", { id: tabId, data: "\x1b[201~" });
      }
      setComments([]);
      if (!submit && !tab.provider) hide(tabId);
      else setNote("Comentários enviados ao agente.");
    } catch (err) {
      setError(errorText(err));
    }
  };

  const repos = useMemo(() => [...new Set([...(info ? [info.repo] : []), ...created.map((c) => c.repo)])], [info, created]);
  const canSend = !!tab && tab.state !== "dormant";
  const working = tab?.state === "working" || tab?.state === "permission";

  const fileRow = (f: FileStatus, area: Area) => {
    const on = pick?.mode === "changes" && pick.area === area && pick.path === f.path;
    return (
      <li key={`${area}:${f.path}`} className={on ? "on" : ""}>
        <button className="git-file" onClick={() => setPick({ mode: "changes", area, path: f.path })} title={f.from ? `${f.from} → ${f.path}` : f.path}>
          <span className={`git-letter l-${statusLetter(f, area)}`}>{statusLetter(f, area)}</span>
          <span className="git-file-name">{baseName(f.path)}</span>
          <span className="git-file-dir">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
        </button>
        <span className="git-file-actions">
          {area === "unstaged" && (
            <>
              <button className="icon-btn" title="Descartar" onClick={() => fileAction("discard", [f.path])}>
                ↺
              </button>
              <button className="icon-btn" title="Colocar no stage" onClick={() => fileAction("stage", [f.path])}>
                +
              </button>
            </>
          )}
          {area === "staged" && (
            <button className="icon-btn" title="Tirar do stage" onClick={() => fileAction("unstage", [f.path])}>
              −
            </button>
          )}
        </span>
      </li>
    );
  };

  const diffFileRow = (f: DiffFile, onPick: () => void, on: boolean) => (
    <li key={fileName(f)} className={on ? "on" : ""}>
      <button className="git-file" onClick={onPick} title={fileName(f)}>
        <span className={`git-letter l-${f.isNew ? "A" : f.isDeleted ? "D" : "M"}`}>{f.isNew ? "A" : f.isDeleted ? "D" : f.isRename ? "R" : "M"}</span>
        <span className="git-file-name">{baseName(fileName(f))}</span>
        <span className="git-stat">
          <span className="git-add">+{f.addedLines}</span> <span className="git-del">−{f.deletedLines}</span>
        </span>
      </button>
    </li>
  );

  const selCount = selected.size;
  const pickedArea = pick?.mode === "changes" ? pick.area : null;
  const lineOps = !!file && partialOk(file);

  return (
    <div
      ref={box}
      tabIndex={-1}
      className="git-panel"
      style={rect ? { ...rect } : { display: "none" }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !draft && !newWorktree) hide(tabId);
      }}
    >
      <header className="git-head">
        <select className="git-select" value={root ?? ""} onChange={(e) => show(tabId, { root: e.target.value })} title={root ?? ""}>
          {roots.length === 0 && <option value="">Nenhum repositório nesta aba</option>}
          {roots.map((r) => (
            <option key={r} value={r}>
              {baseName(r)}
              {r.includes("/.worktrees/") ? ` (worktree de ${baseName(r.slice(0, r.indexOf("/.worktrees/")))})` : ""}
            </option>
          ))}
        </select>
        {info && (
          <span className="git-branch-info">
            ⎇ {info.branch ?? `detached ${info.head ?? ""}`}
            {info.ahead != null && ` ↑${info.ahead} ↓${info.behind ?? 0}`}
            {!info.upstream && info.branch && " · sem upstream"}
          </span>
        )}
        <nav className="git-modes">
          {(
            [
              ["changes", "Alterações"],
              ["base", "Comparar"],
              ["turns", "Turnos"],
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <button key={m} className={`ghost ${mode === m ? "on" : ""}`} onClick={() => (show(tabId, { mode: m }), setPick(null))}>
              {label}
              {m === "changes" && info ? ` (${info.files.length})` : ""}
            </button>
          ))}
        </nav>
        <span className="git-spacer" />
        <button className="ghost" onClick={() => setLayout((l) => (l === "line-by-line" ? "side-by-side" : "line-by-line"))} title="Trocar o layout do diff">
          {layout === "line-by-line" ? "Unificado" : "Lado a lado"}
        </button>
        <button className="ghost" disabled={!root || busy} onClick={() => root && void act(() => api.push(root), "Push feito.")} title="git push">
          Push{info?.ahead ? ` ↑${info.ahead}` : ""}
        </button>
        <button className="ghost" onClick={() => setNewWorktree(true)}>
          Nova worktree
        </button>
        <button className="icon-btn" title="Fechar (Esc)" onClick={() => hide(tabId)}>
          ×
        </button>
      </header>

      {info?.operation && (
        <p className="git-banner">
          {info.operation === "rebase" ? "Rebase" : info.operation === "merge" ? "Merge" : info.operation} em andamento
          {groups.conflict.length ? ` · ${groups.conflict.length} arquivo(s) em conflito` : " · sem conflitos pendentes"}. Para continuar ou abortar, use o
          terminal.
        </p>
      )}
      {(error || note) && <p className={error ? "git-banner error" : "git-banner"}>{error ?? note}</p>}

      <div className="git-body">
        <aside className="git-files">
          {mode === "changes" && (
            <>
              {groups.conflict.length > 0 && (
                <section>
                  <h4>Conflitos</h4>
                  <ul>{groups.conflict.map((f) => fileRow(f, "conflict"))}</ul>
                </section>
              )}
              <section>
                <h4>
                  No stage
                  {groups.staged.length > 0 && (
                    <button className="link" onClick={() => fileAction("unstage", groups.staged.map((f) => f.path))}>
                      tirar todos
                    </button>
                  )}
                </h4>
                {groups.staged.length ? <ul>{groups.staged.map((f) => fileRow(f, "staged"))}</ul> : <p className="hint">Nada no stage.</p>}
              </section>
              <section>
                <h4>
                  Alterados
                  {groups.unstaged.length > 0 && (
                    <button className="link" onClick={() => fileAction("stage", groups.unstaged.map((f) => f.path))}>
                      stage de todos
                    </button>
                  )}
                </h4>
                {groups.unstaged.length ? <ul>{groups.unstaged.map((f) => fileRow(f, "unstaged"))}</ul> : <p className="hint">Nada alterado.</p>}
              </section>
              <div className="git-commit">
                <textarea
                  placeholder="Mensagem do commit"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && groups.staged.length && message.trim()) commit(false);
                  }}
                />
                <div className="git-row">
                  <button className="primary" disabled={busy || !groups.staged.length || !message.trim()} onClick={() => commit(false)} title="⌘Enter">
                    Commit
                  </button>
                  <button className="ghost" disabled={busy || !groups.staged.length || !message.trim()} onClick={() => commit(true)}>
                    Commit e push
                  </button>
                </div>
              </div>
            </>
          )}

          {mode === "base" && (
            <>
              <label className="field">
                <span>Comparar com</span>
                <input
                  list={`git-refs-${tabId}`}
                  defaultValue={base}
                  key={`${root}:${base}`}
                  onKeyDown={(e) => e.key === "Enter" && root && setBase(root, (e.target as HTMLInputElement).value.trim())}
                  onBlur={(e) => root && e.target.value.trim() && e.target.value.trim() !== base && setBase(root, e.target.value.trim())}
                  placeholder="origin/main, um commit…"
                />
                <datalist id={`git-refs-${tabId}`}>
                  {refs.map((r) => (
                    <option key={r} value={r} />
                  ))}
                </datalist>
              </label>
              <p className="hint">Desde o ponto em que a branch saiu de {base || "…"}, com o que ainda não foi commitado.</p>
              <ul>{baseFiles.map((f) => diffFileRow(f, () => setPick({ mode: "base", path: fileName(f) }), pick?.mode === "base" && pick.path === fileName(f)))}</ul>
              {base && baseFiles.length === 0 && <p className="hint">Sem diferenças.</p>}
            </>
          )}

          {mode === "turns" && (
            <>
              {turns.length === 0 && <p className="hint">Nenhum turno com mudanças registrado nesta aba ainda. Cada resposta do agente que mexer em arquivos aparece aqui.</p>}
              <ul className="git-turns">
                {turns.map((t) => (
                  <li key={t.id} className={t.undone ? "undone" : ""}>
                    <div className="git-turn-head">
                      <span className="git-turn-when">{when(t.startedAt)}</span>
                      {!t.endedAt ? (
                        <span className="hint">em andamento</span>
                      ) : t.undone ? (
                        <span className="hint">desfeito</span>
                      ) : (
                        <button className="link" disabled={busy || working} onClick={() => undo(t)} title={working ? "Espere o agente terminar" : "Desfazer este turno"}>
                          desfazer
                        </button>
                      )}
                    </div>
                    <span className="git-turn-prompt">{t.prompt || "(sem texto)"}</span>
                    {t.trees.map((w) => (
                      <button
                        key={w.root}
                        className={`git-turn-tree ${openTurn?.turn === t.id && openTurn.root === w.root ? "on" : ""}`}
                        disabled={!w.to}
                        onClick={() => setOpenTurn({ turn: t.id, root: w.root })}
                      >
                        {baseName(w.root)}
                      </button>
                    ))}
                    {openTurn?.turn === t.id && (
                      <ul>
                        {turnFiles.map((f) =>
                          diffFileRow(
                            f,
                            () => setPick({ mode: "turns", turn: t.id, root: openTurn.root, path: fileName(f) }),
                            turnPick?.turn === t.id && turnPick.path === fileName(f),
                          ),
                        )}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>

        <section className="git-main">
          {!pick ? (
            <p className="hint pad">
              {roots.length === 0 ? "Esta aba ainda não mexeu em nenhum repositório git." : "Escolha um arquivo à esquerda."}
            </p>
          ) : pick.mode === "changes" && pick.area === "conflict" && root ? (
            <ConflictView root={root} path={pick.path} onDone={() => (setPick(null), reload())} />
          ) : file ? (
            <>
              <div className="git-toolbar">
                <span className="hint">
                  {selCount
                    ? `${selCount} linha(s) escolhida(s)`
                    : lineOps && pickedArea && pickedArea !== "conflict"
                      ? "Clique no número da linha para escolher (Shift para um intervalo) ou no cabeçalho de um trecho para ele inteiro."
                      : "Clique no número da linha para escolher e comentar."}
                </span>
                {agentSet.size > 0 && <span className="git-agent-key">linhas do agente</span>}
                {selCount > 0 && (
                  <>
                    {lineOps && pickedArea === "unstaged" && (
                      <>
                        <button className="ghost" disabled={busy} onClick={() => applySelection("stage")}>
                          Stage
                        </button>
                        <button className="ghost danger" disabled={busy} onClick={() => applySelection("discard")}>
                          Descartar
                        </button>
                      </>
                    )}
                    {lineOps && pickedArea === "staged" && (
                      <button className="ghost" disabled={busy} onClick={() => applySelection("unstage")}>
                        Tirar do stage
                      </button>
                    )}
                    <button className="ghost" onClick={() => setDraft("")}>
                      Comentar
                    </button>
                    <button className="link" onClick={() => setSelected(new Set())}>
                      limpar
                    </button>
                  </>
                )}
              </div>
              {draft != null && (
                <div className="git-draft">
                  <textarea
                    autoFocus
                    placeholder="O que o agente deve saber ou mudar nestas linhas"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setDraft(null);
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addComment();
                    }}
                  />
                  <div className="git-row">
                    <button className="ghost" onClick={() => setDraft(null)}>
                      Cancelar
                    </button>
                    <button className="primary" disabled={!draft.trim()} onClick={addComment} title="⌘Enter">
                      Adicionar comentário
                    </button>
                  </div>
                </div>
              )}
              <DiffView file={file} layout={layout} selected={selected} agent={agentSet} onLine={onLine} onBlock={onBlock} />
            </>
          ) : (
            <p className="hint pad">Sem diferenças neste arquivo.</p>
          )}
        </section>
      </div>

      {comments.length > 0 && (
        <footer className="git-comments">
          <span>
            {comments.length} comentário(s) para o agente:{" "}
            <span className="hint">{comments.map((c) => `${baseName(c.path)}${c.range ? ` ${c.range}` : ""}`).join(", ")}</span>
          </span>
          <span className="git-spacer" />
          <button className="link" onClick={() => setComments([])}>
            descartar
          </button>
          {!tab?.provider && (
            <button className="ghost" disabled={!canSend} onClick={() => void sendComments(false)} title="Cola no prompt da aba sem enviar, para você revisar">
              Colar no prompt
            </button>
          )}
          <button className="primary" disabled={!canSend || working} onClick={() => void sendComments(true)} title={working ? "Espere o agente terminar a resposta" : ""}>
            Enviar ao agente
          </button>
        </footer>
      )}

      {newWorktree && (
        <NewWorktreeDialog
          tabId={tabId}
          repos={repos}
          onClose={() => setNewWorktree(false)}
          onCreated={(made) => {
            reload();
            if (made[0]) show(tabId, { root: made[0] });
          }}
        />
      )}
    </div>
  );
}
