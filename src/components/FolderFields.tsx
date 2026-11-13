import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore } from "../lib/store";
import type { Folder, PathCheck } from "../lib/types";

/** Opens the system's folder picker and records the folder; resolves to it, or null when cancelled. */
export async function browseFolder(title = "Escolher pasta"): Promise<Folder | null> {
  const picked = await open({ directory: true, multiple: false, title });
  if (typeof picked !== "string") return null;
  const check = await invoke<PathCheck>("path_check", { path: picked });
  const name = check.name ?? check.expanded;
  const id = useStore.getState().addFolder(name, check.expanded);
  return { id, name, path: check.expanded };
}

/** The known folders, most recently used first. */
export function useRecentFolders(): Folder[] {
  const folders = useStore((s) => s.folders);
  return [...folders].sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0));
}

/** Folder rows to pick from; the chosen one is marked. */
export function FolderList({ folders, value, onPick }: { folders: Folder[]; value?: string | null; onPick: (f: Folder) => void }) {
  return (
    <ul className="folder-choice pick">
      {folders.map((f) => (
        <li key={f.id} className={value === f.id ? "on" : ""} onClick={() => onPick(f)}>
          <span className="folder-name">{f.name}</span>
          <span className="folder-path" title={f.path}>
            {f.path}
          </span>
        </li>
      ))}
    </ul>
  );
}
