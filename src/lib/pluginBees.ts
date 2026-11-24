import { useEffect } from "react";
import { useStore } from "./store";
import { runBee } from "./bees";
import { reportError } from "./errors";
import { pluginBeeId, type LocalPlugin } from "./localPlugins";
import type { Bee } from "./types";

/** The list before the app first read the plugins folder; nothing is synced against it. */
const UNREAD = useStore.getState().localPlugins;

const isOn = (plugin: LocalPlugin, enabled: string[]) => plugin.status === "approved" && enabled.includes(plugin.id);

/**
 * Keeps the bees local plugins bring in step with them: created or updated
 * when the plugin is approved and on, turned off while it is not, and removed
 * with the plugin. What a bee kept between runs survives updates.
 */
function syncPluginBees(): void {
  const s = useStore.getState();
  const plugins = s.localPlugins;
  if (plugins === UNREAD) return;
  const wanted = new Set<string>();
  for (const plugin of plugins) {
    // A plugin.json with a mistake lists no bees; its bees wait, off, with what they kept.
    if (plugin.status === "invalid") {
      for (const bee of s.bees) {
        if (bee.plugin?.id !== plugin.id) continue;
        wanted.add(bee.id);
        if (bee.enabled) s.updateBee(bee.id, { enabled: false });
      }
      continue;
    }
    const on = isOn(plugin, s.enabledPlugins);
    for (const pb of plugin.bees ?? []) {
      const id = pluginBeeId(plugin.id, pb.id);
      wanted.add(id);
      const fields: Partial<Bee> = {
        name: pb.name,
        instructions: pb.instructions,
        allowedTools: pb.allowedTools,
        permissionMode: pb.permissionMode,
        plugin: { id: plugin.id, bee: pb.id, every: pb.every },
        enabled: on,
      };
      const existing = s.bees.find((b) => b.id === id);
      if (!existing) {
        // A plugin waiting for approval does not create anything yet.
        if (on) s.addBee({ id, createdAt: Date.now(), lastRunAt: null, ...fields } as Bee);
      } else if (JSON.stringify({ ...existing, ...fields }) !== JSON.stringify(existing)) {
        s.updateBee(id, fields);
      }
    }
  }
  // A plugin's bee whose plugin, or whose entry in it, is gone.
  for (const bee of s.bees) if (bee.plugin && !wanted.has(bee.id)) s.removeBee(bee.id);
}

/** Runs a plugin's bee now, with `input` for its prompt. Fails while the plugin is off. */
export function runPluginBee(plugin: LocalPlugin, beeId: string, input: unknown): void {
  const s = useStore.getState();
  if (!isOn(plugin, s.enabledPlugins)) throw new Error("o plugin está desligado");
  const bee = s.bees.find((b) => b.id === pluginBeeId(plugin.id, beeId) && b.enabled);
  if (!bee) throw new Error(`o plugin não tem a bee ${beeId}`);
  const text = input == null ? "" : typeof input === "string" ? input : JSON.stringify(input, null, 2);
  void runBee(bee, null, text);
}

/** Creates the plugins' bees and runs the ones with an interval while their plugin is on. */
export function usePluginBees(): void {
  const localPlugins = useStore((s) => s.localPlugins);
  const enabled = useStore((s) => s.enabledPlugins);
  useEffect(() => syncPluginBees(), [localPlugins, enabled]);
  const key = JSON.stringify(
    localPlugins.filter((p) => isOn(p, enabled)).map((p) => [p.id, p.hash, (p.bees ?? []).map((b) => [b.id, b.every])]),
  );
  useEffect(() => {
    const timers: ReturnType<typeof setInterval>[] = [];
    const s = useStore.getState();
    for (const plugin of s.localPlugins) {
      if (!isOn(plugin, s.enabledPlugins)) continue;
      for (const pb of plugin.bees ?? []) {
        if (!pb.every) continue;
        const run = () => {
          try {
            runPluginBee(plugin, pb.id, "");
          } catch (err) {
            reportError("plugin", `${plugin.id}/${pb.id}: ${err}`);
          }
        };
        timers.push(setInterval(run, pb.every * 1000));
      }
    }
    return () => timers.forEach(clearInterval);
  }, [key]);
}
