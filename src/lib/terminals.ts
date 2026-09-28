import type { Terminal } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { SearchAddon } from "@xterm/addon-search";

/** Live xterm instances keyed by tab id, so one global pty-data listener can route output. */
export const terminals = new Map<string, Terminal>();

/** Serializers for the live terminals, used to hand a screen to a detached window. */
export const serializers = new Map<string, SerializeAddon>();

/** Search over each live terminal's scrollback, for Cmd+F. */
export const searches = new Map<string, SearchAddon>();

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
