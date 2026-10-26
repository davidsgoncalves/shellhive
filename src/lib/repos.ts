import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";

export interface Origin {
  slug: string;
  root: string;
}

/** The GitHub repository a folder is a clone of, read from its `origin`. */
export const originOf = (path: string) => invoke<Origin | null>("git_origin", { path });

/**
 * Adds the repositories of the groups' base folders, or of the clones right
 * inside one that is not a clone itself. Repositories set by hand or removed by
 * hand are left as they are.
 */
export async function scanRepos(): Promise<void> {
  const s = useStore.getState();
  const used = new Set(s.groups.map((g) => g.folderId).filter(Boolean));
  const folders = s.folders.filter((f) => used.has(f.id));
  const found = await Promise.all(
    folders.map((f) => invoke<Origin[]>("git_origins_in", { path: f.path }).catch(() => [])),
  );
  for (const origin of found.flat()) {
    const now = useStore.getState();
    if (now.dismissedRepos.includes(origin.slug)) continue;
    const known = now.repos.find((r) => r.slug === origin.slug);
    if (known?.manual || known?.path === origin.root) continue;
    now.setRepo({ slug: origin.slug, path: origin.root, manual: false });
  }
}
