import { invoke } from "@tauri-apps/api/core";

export const RELEASES_URL = "https://github.com/davidsgoncalves/shellhive/releases";

/** How this build was installed, which decides how it can update itself. */
export async function installKind(): Promise<string> {
  return invoke<string>("install_kind").catch(() => "native");
}
