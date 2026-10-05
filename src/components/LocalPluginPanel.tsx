import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PLUGIN_WINDOW_DATA, PLUGIN_WINDOW_READY } from "../lib/pluginWindow";
import { BAND_GAP, BAND_HEIGHT, useStore } from "../lib/store";
import type { PluginHost } from "../lib/plugins";
import { submit, typeText } from "../lib/typing";
import { notify } from "../lib/notify";
import { allTabs, dispatchEffects, openSurface, runPluginTool } from "../lib/pluginEffects";
import { pluginTab, type LocalPlugin, type Surface } from "../lib/localPlugins";

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
    setStatus: (text, title) => call("status", { text, title }),
    open: (surface, data) => call("open", { surface, data }),
    setBand: (data, tabId) => call("band", { data, tabId }),
    setHeight: (px) => call("height", { px }),
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
  kind,
  tabId,
  data,
  onClose,
}: {
  plugin: LocalPlugin;
  kind: Surface | "band";
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
    invoke<string>("local_plugin_panel", { id: plugin.id, kind })
      .then((h) => setHtml(frameDocument(h)))
      .catch((e) => setError(String(e)));
  }, [plugin.id, plugin.hash, kind]);

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
            await dispatchEffects(plugin, target, { badge: (m.params?.text as string | null) ?? null });
            return reply(null);
          }
          case "status":
            need("status");
            await dispatchEffects(plugin, tabId, {
              status: m.params?.text ? { text: String(m.params.text), title: m.params?.title as string | undefined } : null,
            });
            return reply(null);
          case "open": {
            const surface = String(m.params?.surface ?? "");
            if (!["panel", "side", "view", "window"].includes(surface)) throw new Error(`lugar desconhecido: ${surface}`);
            await dispatchEffects(plugin, tabId, surface === "side"
              ? {}
              : { [surface === "panel" ? "panel" : surface]: m.params?.data ?? null });
            if (surface === "side") openSurface(plugin, "side", tabId, null);
            return reply(null);
          }
          case "band": {
            if (!plugin.band) throw new Error("o plugin não declarou band");
            const target = typeof m.params?.tabId === "string" ? m.params.tabId : tabId;
            if (!target) throw new Error("não há aba para a faixa");
            await dispatchEffects(plugin, target, { bands: { [target]: m.params?.data ?? null } });
            return reply(null);
          }
          case "height": {
            if (kind !== "band" || !tabId || !plugin.band) throw new Error("só a faixa muda de altura");
            const px = Math.round(Number(m.params?.px) || 0) + BAND_GAP;
            useStore.getState().setPluginBandHeight(tabId, plugin.id, Math.min(plugin.band.maxHeight + BAND_GAP, Math.max(BAND_HEIGHT, px)));
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
  }, [plugin, kind, tabId, tabInfo, onClose]);

  return (
    <>
      {error && <p className="error plugin-panel-error">{error}</p>}
      {html && (
        <iframe
          ref={frame}
          title={plugin.name}
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
      <PluginFrame plugin={plugin} kind="panel" tabId={panel.tabId} data={panel.data} onClose={() => openPluginPanel(null)} />
    </section>
  );
}

/** A local plugin's tab in the right column, working on the active tab. */
export function PluginSidePanel({ plugin, onClose }: { plugin: LocalPlugin; onClose: () => void }) {
  const activeTabId = useStore((s) => s.activeTabId);
  return (
    <div className="plugin-side">
      <PluginFrame plugin={plugin} kind="side" tabId={activeTabId} data={null} onClose={onClose} />
    </div>
  );
}

/** A plugin's view, filling one pane of the split like a terminal. */
export function PluginViewPane({
  plugin,
  rect,
  focused,
  onFocus,
}: {
  plugin: LocalPlugin;
  rect: { left: string; top: string; width: string; height: string };
  focused: boolean;
  onFocus: () => void;
}) {
  const data = useStore((s) => s.viewData[plugin.id]);
  const activeTabId = useStore((s) => s.activeTabId);
  const closePluginView = useStore((s) => s.closePluginView);
  return (
    <section className={`plugin-view ${focused ? "focused" : ""}`} style={rect} onMouseDown={onFocus}>
      <header>
        <span className="plugin-panel-title">{plugin.view?.title ?? plugin.name}</span>
        <span className="plugin-panel-tag">plugin</span>
        <button className="icon-btn" title="Fechar" onClick={() => closePluginView(plugin.id)}>
          ×
        </button>
      </header>
      <PluginFrame plugin={plugin} kind="view" tabId={activeTabId} data={data ?? null} onClose={() => closePluginView(plugin.id)} />
    </section>
  );
}

/** Content of a plugin's own window, which only knows the plugin itself. */
export function PluginWindow({ pluginId }: { pluginId: string }) {
  const [plugin, setPlugin] = useState<LocalPlugin | null>(null);
  const [data, setData] = useState<unknown>(null);
  useEffect(() => {
    void invoke<LocalPlugin[]>("local_plugins").then((list) => setPlugin(list.find((p) => p.id === pluginId) ?? null));
    const un = listen<unknown>(PLUGIN_WINDOW_DATA, (ev) => setData(ev.payload));
    void emit(PLUGIN_WINDOW_READY, pluginId);
    return () => {
      void un.then((u) => u());
    };
  }, [pluginId]);
  if (!plugin) return <p className="hint pad">Carregando…</p>;
  return (
    <div className="plugin-window">
      <PluginFrame
        plugin={plugin}
        kind="window"
        tabId={null}
        data={data}
        onClose={() => void getCurrentWebviewWindow().close()}
      />
    </div>
  );
}

/** A plugin's band on one tab's terminal; the terminal makes room for it. */
export function PluginBandFrame({
  plugin,
  tabId,
  style,
}: {
  plugin: LocalPlugin;
  tabId: string;
  style: React.CSSProperties;
}) {
  const data = useStore((s) => s.pluginBands[tabId]?.[plugin.id]?.data);
  const setPluginBand = useStore((s) => s.setPluginBand);
  return (
    <section className={`plugin-band ${plugin.band?.position ?? "bottom"}`} style={style}>
      <PluginFrame plugin={plugin} kind="band" tabId={tabId} data={data ?? null} onClose={() => setPluginBand(tabId, plugin.id, null)} />
    </section>
  );
}
