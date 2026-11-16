import { useEffect, useState } from "react";
import { Modal } from "../../src/components/Modal";
import { useStore } from "../../src/lib/store";
import { api, baseName, errorText, type WorktreeCheck } from "./api";
import { useGit, type CreatedWorktree } from "./state";

/** Opens a new tab in a folder, in the same group as another tab. */
export function openTabIn(cwd: string, nearTabId: string | null) {
  const s = useStore.getState();
  const near = s.tabs.find((t) => t.id === nearTabId) ?? s.tabs.find((t) => t.id === s.activeTabId);
  const groupId = near?.groupId ?? s.groups[0]?.id;
  if (!groupId) return;
  s.addTab(groupId, { cwd, title: baseName(cwd), customTitle: false });
}

/** Creates a worktree with the same name in one or more repositories. */
export function NewWorktreeDialog({
  tabId,
  repos,
  onClose,
  onCreated,
}: {
  tabId: string;
  /** Repositories the tab knows, main worktree folders. */
  repos: string[];
  onClose: () => void;
  onCreated: (roots: string[]) => void;
}) {
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [picked, setPicked] = useState<string[]>(repos.slice(0, 1));
  const [extra, setExtra] = useState("");
  const [openTab, setOpenTab] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = [...new Set([...repos, ...picked])];

  const addExtra = () => {
    const p = extra.trim();
    if (!p) return;
    setPicked((s) => [...new Set([...s, p])]);
    setExtra("");
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    const made: string[] = [];
    const tab = useStore.getState().tabs.find((t) => t.id === tabId);
    try {
      for (const repo of picked) {
        const root = await api.worktreeAdd(repo, name, base.trim() || null);
        made.push(root);
        await useGit.getState().addCreated({
          root,
          repo,
          branch: name.trim(),
          base: base.trim() || null,
          tabId,
          tabTitle: tab?.title ?? "",
          at: Date.now(),
        });
      }
      if (openTab && made[0]) openTabIn(made[0], tabId);
      onCreated(made);
      onClose();
    } catch (err) {
      setError(`${made.length ? `Criadas: ${made.map(baseName).join(", ")}. ` : ""}${errorText(err)}`);
      if (made.length) onCreated(made);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Nova worktree"
      onClose={onClose}
      footer={
        <>
          <label className="check">
            <input type="checkbox" checked={openTab} onChange={(e) => setOpenTab(e.target.checked)} /> Abrir uma aba nela
          </label>
          <button className="ghost auto" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={busy || !name.trim() || picked.length === 0} onClick={() => void create()}>
            {busy ? "Criando…" : "Criar"}
          </button>
        </>
      }
    >
      <div className="git-form">
        <label className="field">
          <span>Nome (vira a branch e a pasta em .worktrees/)</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="feat/login" />
        </label>
        <label className="field">
          <span>Sair de (vazio = HEAD de cada repositório)</span>
          <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="origin/main" />
        </label>
        <div className="field">
          <span>Repositórios</span>
          <ul className="git-repo-pick">
            {list.map((r) => (
              <li key={r}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={picked.includes(r)}
                    onChange={(e) => setPicked((s) => (e.target.checked ? [...s, r] : s.filter((x) => x !== r)))}
                  />
                  <span>{baseName(r)}</span>
                  <span className="hint">{r}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="git-row">
            <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Outro repositório: /caminho/da/pasta" onKeyDown={(e) => e.key === "Enter" && addExtra()} />
            <button className="ghost auto" onClick={addExtra}>
              Adicionar
            </button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    </Modal>
  );
}

/** One worktree's removal: archive keeps the branch, delete takes it too. */
export function RemoveRow({ w, onGone }: { w: CreatedWorktree; onGone?: () => void }) {
  const [check, setCheck] = useState<WorktreeCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"archive" | "delete" | null>(null);

  useEffect(() => {
    void api.worktreeCheck(w.root).then(setCheck);
  }, [w.root]);

  const remove = async (deleteBranch: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.worktreeRemove(w.repo, w.root, check?.branch ?? w.branch, deleteBranch);
      await useGit.getState().dropCreated(w.root);
      onGone?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const risky = (check?.dirty ?? 0) > 0 || (confirm === "delete" && (check?.unpushed ?? 0) > 0);
  return (
    <li className="git-wt-row">
      <div className="git-wt-main">
        <span className="git-wt-name">
          {baseName(w.repo)} · {check?.branch ?? w.branch}
        </span>
        <span className="hint">
          {check && !check.exists
            ? "pasta não existe mais"
            : [
                check?.dirty ? `${check.dirty} alteração(ões) não commitada(s)` : null,
                check?.unpushed ? `${check.unpushed} commit(s) sem push` : null,
                w.tabTitle ? `aba ${w.tabTitle}` : null,
              ]
                .filter(Boolean)
                .join(" · ") || "limpa"}
        </span>
        {error && <span className="error">{error}</span>}
        {confirm && (
          <span className={risky ? "error" : "hint"}>
            {confirm === "delete" ? "Apaga a pasta e a branch." : "Apaga a pasta e mantém a branch."}
            {check?.dirty ? " As alterações não commitadas se perdem." : ""}
            {confirm === "delete" && check?.unpushed ? " Os commits sem push se perdem." : ""}
          </span>
        )}
      </div>
      <div className="git-wt-actions">
        {confirm ? (
          <>
            <button className="ghost" onClick={() => setConfirm(null)}>
              Voltar
            </button>
            <button className="ghost danger" disabled={busy} onClick={() => void remove(confirm === "delete")}>
              Confirmar
            </button>
          </>
        ) : (
          <>
            {check?.exists !== false && (
              <button className="ghost" onClick={() => openTabIn(w.root, w.tabId)} title="Abrir uma aba nesta worktree">
                Abrir aba
              </button>
            )}
            <button className="ghost" disabled={busy} onClick={() => setConfirm("archive")} title="Remove a pasta e mantém a branch">
              Arquivar
            </button>
            <button className="ghost danger" disabled={busy} onClick={() => setConfirm("delete")} title="Remove a pasta e a branch">
              Apagar
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/** Asks what to do with the worktrees a closed tab created. */
export function CloseOfferDialog() {
  const offer = useGit((s) => s.offers[0]);
  const created = useGit((s) => s.created);
  const dismiss = useGit((s) => s.dismissOffer);
  if (!offer) return null;
  const left = offer.worktrees.filter((w) => created.some((c) => c.root === w.root));
  if (left.length === 0) {
    queueMicrotask(dismiss);
    return null;
  }
  return (
    <Modal
      title={`Worktrees da aba ${offer.tabTitle || "fechada"}`}
      onClose={dismiss}
      footer={
        <button className="primary" onClick={dismiss}>
          Manter as que restaram
        </button>
      }
    >
      <p className="hint">A aba fechou. Estas worktrees foram criadas por ela:</p>
      <ul className="git-wt-list">
        {left.map((w) => (
          <RemoveRow key={w.root} w={w} />
        ))}
      </ul>
    </Modal>
  );
}

/** Every worktree created from the plugin, in the side panel. */
export function WorktreeList() {
  const { created, loaded, load, show } = useGit();
  const activeTabId = useStore((s) => s.activeTabId);
  useEffect(() => void load(), [load]);
  return (
    <div className="git-side">
      <button className="ghost" disabled={!activeTabId} onClick={() => activeTabId && show(activeTabId)}>
        Abrir o painel Git na aba ativa
      </button>
      {!loaded ? (
        <p className="hint pad">Carregando…</p>
      ) : created.length === 0 ? (
        <p className="hint pad">Nenhuma worktree criada pelo Shellhive. Crie pelo painel Git de uma aba.</p>
      ) : (
        <ul className="git-wt-list">
          {created.map((w) => (
            <RemoveRow key={w.root} w={w} />
          ))}
        </ul>
      )}
    </div>
  );
}
