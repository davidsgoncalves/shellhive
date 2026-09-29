import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "../lib/store";
import type { PluginHost } from "../lib/plugins";
import { submit, typeText } from "../lib/typing";

/** Theme variables handed to a panel, so it can match the app. */
const THEME_VARS = ["--bg", "--panel", "--panel-2", "--border", "--fg", "--muted", "--accent", "--danger", "--success", "--font-ui", "--font-mono"];

/**
 * What the frame gets before the plugin's own HTML: a content policy with
 * no network and no outside files, the theme, and the `shellhive` object,
 * which only talks to the app through postMessage.
 */
function frameDocument(html: string): string {
  const css = getComputedStyle(document.documentElement);
  const vars = THEME_VARS.map((v) => `${v}: ${css.getPropertyValue(v).trim()};`).join(" ");
  const head = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">
<style>:root { ${vars} color-scheme: dark; }</style>
<script>(() => {
  let seq = 0, onData = null, last;
  const eventFns = [];
  const waiting = new Map();
  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data || {};
    if (m.type === "reply") {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      m.error ? w.reject(new Error(m.error)) : w.resolve(m.value);
    } else if (m.type === "data") {
      last = m.value;
      if (onData) onData(m.value);
    } else if (m.type === "event") {
      for (const fn of eventFns) fn(m.value);
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    parent.postMessage({ type: "call", id, method, params }, "*");
  });
  window.shellhive = {
    onData(fn) { onData = fn; if (last !== undefined) fn(last); },
    close: () => call("close"),
    tab: () => call("tab"),
    tool: (name, args) => call("tool", { name, args }),
    prompt: (text, opts) => call("prompt", { text, submit: !!(opts && opts.submit) }),
    storage: { get: () => call("storage.get"), set: (value) => call("storage.set", { value }) },
    events: () => call("events"),
    onEvent(fn) { eventFns.push(fn); call("events.subscribe").catch((e) => console.error(e)); },
  };
})();</script>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${head}`) : `${head}${html}`;
}

/** A local plugin's panel, in a frame with no access to the app but its bridge. */
export function LocalPluginPanel({ host }: { host: PluginHost }) {
  const panel = useStore((s) => s.pluginPanel);
  const plugin = useStore((s) => s.localPlugins.find((p) => p.id === panel?.plugin));
  const tabs = useStore((s) => s.tabs);
  const openPluginPanel = useStore((s) => s.openPluginPanel);
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pluginId = panel?.plugin;
  // Set once the panel asks for live events and holds the permission.
  const subscribed = useRef(false);

  useEffect(() => {
    subscribed.current = false;
    setHtml(null);
    setError(null);
    if (!pluginId) return;
    invoke<string>("local_plugin_panel", { id: pluginId })
      .then((h) => setHtml(frameDocument(h)))
      .catch((e) => setError(String(e)));
  }, [pluginId]);

  // What the agent does, for a panel that subscribed with the permission.
  useEffect(() => {
    const p = listen("plugin-event", (ev) => {
      if (subscribed.current) frame.current?.contentWindow?.postMessage({ type: "event", value: ev.payload }, "*");
    });
    return () => {
      void p.then((un) => un());
    };
  }, []);

  // New data from a tool reaches a panel that is already open.
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ type: "data", value: panel?.data ?? null }, "*");
  }, [panel]);

  useEffect(() => {
    if (!panel || !plugin) return;
    const allowed = (p: string) => plugin.permissions.includes(p);
    const onMessage = async (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      const m = e.data as { type?: string; id?: number; method?: string; params?: Record<string, unknown> };
      if (m?.type !== "call") return;
      const reply = (value: unknown, error?: string) => win.postMessage({ type: "reply", id: m.id, value, error }, "*");
      const need = (p: string) => {
        if (!allowed(p)) throw new Error(`o plugin não pediu a permissão ${p}`);
      };
      try {
        const tab = tabs.find((t) => t.id === panel.tabId);
        switch (m.method) {
          case "close":
            openPluginPanel(null);
            return reply(null);
          case "tab":
            need("tab");
            return reply(tab ? { id: tab.id, title: tab.title, cwd: tab.cwd } : null);
          case "tool": {
            need("tools");
            const name = String(m.params?.name ?? "");
            if (!plugin.tools.some((t) => t.name === name)) throw new Error(`${name} não é uma ferramenta deste plugin`);
            return reply(
              await invoke("local_plugin_run", { id: plugin.id, tool: name, tabId: panel.tabId, args: m.params?.args ?? {} }),
            );
          }
          case "prompt": {
            need("prompt");
            if (!panel.tabId) throw new Error("o painel não está ligado a uma aba");
            // A line break would send the prompt halfway.
            await typeText(panel.tabId, String(m.params?.text ?? "").replace(/\s*\n\s*/g, " "));
            if (m.params?.submit) await submit(panel.tabId);
            return reply(null);
          }
          case "events":
            need("events");
            return reply(await invoke("plugin_events", { id: plugin.id }));
          case "events.subscribe":
            need("events");
            subscribed.current = true;
            return reply(null);
          case "storage.get":
            need("storage");
            return reply(await invoke("plugin_storage_get", { id: plugin.id }));
          case "storage.set":
            need("storage");
            return reply(await invoke("plugin_storage_set", { id: plugin.id, value: m.params?.value ?? null }));
          default:
            throw new Error(`função desconhecida: ${m.method}`);
        }
      } catch (err) {
        reply(null, err instanceof Error ? err.message : String(err));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [panel, plugin, tabs, openPluginPanel]);

  if (!panel || !plugin?.panel) return null;
  const rect = host.paneRect(panel.tabId);
  return (
    <section
      className="plugin-panel"
      style={{
        left: rect.left,
        width: rect.width,
        bottom: `calc(100% - ${rect.top} - ${rect.height})`,
        height: `calc(${rect.height} * 0.45)`,
      }}
    >
      <header>
        <span className="plugin-panel-title">{plugin.panel.title}</span>
        <span className="plugin-panel-tag">plugin local</span>
        <button className="icon-btn" title="Fechar" onClick={() => openPluginPanel(null)}>
          ×
        </button>
      </header>
      {error && <p className="error plugin-panel-error">{error}</p>}
      {html && (
        <iframe
          ref={frame}
          title={plugin.panel.title}
          // Scripts only: no same-origin, so the frame cannot reach the app.
          sandbox="allow-scripts"
          srcDoc={html}
          onLoad={() => frame.current?.contentWindow?.postMessage({ type: "data", value: panel.data ?? null }, "*")}
        />
      )}
    </section>
  );
}
