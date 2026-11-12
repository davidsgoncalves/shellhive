import { invoke } from "@tauri-apps/api/core";

const CHUNK = 64;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Types text into a tab a little at a time, the way a person would. Written
 * in one go, a long text reaches Claude Code as several reads and only the
 * last one survives. Split by code point, so an emoji is never cut in half.
 */
export async function typeText(tabId: string, text: string): Promise<void> {
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += CHUNK) {
    await invoke("pty_write", { id: tabId, data: chars.slice(i, i + CHUNK).join("") });
    await pause(15);
  }
}

/**
 * Sends a message to the Claude running in a tab, as if pasted and sent.
 * Bracketed paste keeps line breaks in the message instead of sending early.
 */
export async function sendMessage(tabId: string, text: string): Promise<void> {
  await invoke("pty_write", { id: tabId, data: "\x1b[200~" });
  await typeText(tabId, text);
  await invoke("pty_write", { id: tabId, data: "\x1b[201~" });
  await submit(tabId);
}

/** Presses Enter in a tab after a short pause, so the text above lands first. */
export async function submit(tabId: string): Promise<void> {
  await pause(80);
  await invoke("pty_write", { id: tabId, data: "\r" });
}
