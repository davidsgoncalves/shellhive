import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "../lib/store";
import type { PluginHost } from "../lib/plugins";
import { submit, typeText } from "../lib/typing";
import { notify } from "../lib/notify";
import { allTabs, applyEffects, runPluginTool } from "../lib/pluginEffects";
import { pluginTab, type LocalPlugin } from "../lib/localPlugins";

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
  let seq = 0, onData = null, last, onTab = null, lastTab;
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
    } else if (m.type === "tab") {
      lastTab = m.value;
      if (onTab) onTab(m.value);
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
    tabs: () => call("tabs"),
    onTab(fn) { onTab = fn; if (lastTab !== undefined) fn(lastTab); },
    setBadge: (text, tabId) => call("badge", { text, tabId }),
    notify: (title, body) => call("notify", { title, body }),
    tool: (name, args) => call("tool", { name, args }),
    prompt: (text, opts) => call("prompt", { text, submit: !!(opts && opts.submit) }),
    storage: { get: () => call("storage.get"), set: (value) => call("storage.set", { value }) },
    events: () => call("events"),
    onEvent(fn) { eventFns.push(fn); call("events.subscribe").catch((e) => console.error(e)); },
  };
})();</script>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${head}`) : `${head}${html}`;
}

/**
 * A plugin's HTML in a frame with no access to the app but its bridge. Used
 * for the panel under a tab and for the plugin's tab in the right column;
 * `tabId` is the tab the frame works on: the asking tab, or the active one.
 */
export function PluginFrame({
  plugin,
  side,
  tabId,
  data,
  onClose,
}: {
  plugin: LocalPlugin;
  side: boolean;
  tabId: string | null;
  data: unknown;
  onClose: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set once the frame asks for live events and holds the permission.
  const subscribed = useRef(false);
  const tabs = useStore((s) => s.tabs);
  const groups = useStore((s) => s.groups);
  const tab = tabs.find((t) => t.id === tabId);
  const tabInfo = tab ? pluginTab(tab, groups) : null;
  const post = (msg: unknown) => frame.current?.contentWindow?.postMessage(msg, "*");

  useEffect(() => {
    subscribed.current = false;
    setHtml(null);
    setError(null);
    invoke<string>("local_plugin_panel", { id: plugin.id, side })
      .then((h) => setHtml(frameDocument(h)))
      .catch((e) => setError(String(e)));
  }, [plugin.id, plugin.hash, side]);

  // What the agent does, for a frame that subscribed with the permission.
  useEffect(() => {
    const p = listen("plugin-event", (ev) => {
      if (subscribed.current) post({ type: "event", value: ev.payload });
    });
    return () => {
      void p.then((un) => un());
    };
  }, []);

  // New data from a tool reaches a frame that is already open.
  useEffect(() => post({ type: "data", value: data ?? null }), [data]);
  // The side panel follows the active tab.
  const tabKey = JSON.stringify(tabInfo);
  useEffect(() => post({ type: "tab", value: tabInfo }), [tabKey]);

  useEffect(() => {
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
        switch (m.method) {
          case "close":
            onClose();
            return reply(null);
          case "tab":
            need("tab");
            return reply(tabInfo);
          case "tabs":
            need("tab");
            return reply(allTabs());
          case "tool": {
            need("tools");
            const name = String(m.params?.name ?? "");
            if (!plugin.tools.some((t) => t.name === name)) throw new Error(`${name} não é uma ferramenta deste plugin`);
            const out = await runPluginTool(plugin, name, tabId, (m.params?.args as Record<string, unknown>) ?? {});
            return reply({ text: out.text, isError: out.isError });
          }
          case "prompt": {
            need("prompt");
            if (!tabId) throw new Error("não há aba para escrever");
            // A line break would send the prompt halfway.
            await typeText(tabId, String(m.params?.text ?? "").replace(/\s*\n\s*/g, " "));
            if (m.params?.submit) await submit(tabId);
            return reply(null);
          }
          case "badge": {
            need("badge");
            const target = typeof m.params?.tabId === "string" ? m.params.tabId : tabId;
            if (!target) throw new Error("não há aba para a etiqueta");
            applyEffects(plugin, target, { badge: (m.params?.text as string | null) ?? null });
            return reply(null);
          }
          case "notify":
            need("notify");
            await notify(String(m.params?.title ?? plugin.name), String(m.params?.body ?? ""), true);
            return reply(null);
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
  }, [plugin, tabId, tabInfo, onClose]);

  return (
    <>
      {error && <p className="error plugin-panel-error">{error}</p>}
      {html && (
        <iframe
          ref={frame}
          title={(side ? plugin.sidePanel?.title : plugin.panel?.title) ?? plugin.name}
          // Scripts only: no same-origin, so the frame cannot reach the app.
          sandbox="allow-scripts"
          srcDoc={html}
          onLoad={() => {
            post({ type: "data", value: data ?? null });
            post({ type: "tab", value: tabInfo });
          }}
        />
      )}
    </>
  );
}

/** A local plugin's panel under the terminal of the tab it belongs to. */
export function LocalPluginPanel({ host }: { host: PluginHost }) {
  const panel = useStore((s) => s.pluginPanel);
  const plugin = useStore((s) => s.localPlugins.find((p) => p.id === panel?.plugin));
  const openPluginPanel = useStore((s) => s.openPluginPanel);
  if (!panel || !plugin?.panel) return null;
  const rect = host.paneRect(panel.tabId);
  return (
    <section
      className="plugin-panel"
      // Hidden, not dropped, while its tab is off screen, so the frame keeps its state.
      style={
        rect
          ? {
              left: rect.left,
              width: rect.width,
              bottom: `calc(100% - ${rect.top} - ${rect.height})`,
              height: `calc(${rect.height} * 0.45)`,
            }
          : { display: "none" }
      }
    >
      <header>
        <span className="plugin-panel-title">{plugin.panel.title}</span>
        <span className="plugin-panel-tag">plugin local</span>
        <button className="icon-btn" title="Fechar" onClick={() => openPluginPanel(null)}>
          ×
        </button>
      </header>
      <PluginFrame plugin={plugin} side={false} tabId={panel.tabId} data={panel.data} onClose={() => openPluginPanel(null)} />
    </section>
  );
}

/** A local plugin's tab in the right column, working on the active tab. */
export function PluginSidePanel({ plugin, onClose }: { plugin: LocalPlugin; onClose: () => void }) {
  const activeTabId = useStore((s) => s.activeTabId);
  return (
    <div className="plugin-side">
      <PluginFrame plugin={plugin} side tabId={activeTabId} data={null} onClose={onClose} />
    </div>
  );
}
