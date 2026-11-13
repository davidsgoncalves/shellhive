import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "./store";
import { quotaResetAt } from "./bees";
import { startFlow } from "./flows";
import type { Flow, FlowTrigger } from "./types";

/** How often each service trigger looks for something new. */
const POLL_MS = 2 * 60_000;
const TICK_MS = 30_000;
/** Items remembered per flow, newest first, so old ones never start it again. */
const KEEP_SEEN = 300;
/** Items one run hands on; the rest only get marked seen. */
const MAX_ITEMS = 10;

type ServiceTrigger = Extract<FlowTrigger, { kind: "github" | "jira" | "slack" }>;
interface Item {
  key: string;
  text: string;
}

/** The last error of each flow's lookup, shown on its trigger. */
export const useTriggerErrors = create<{ byFlow: Record<string, string>; set: (id: string, err: string | null) => void }>()((set) => ({
  byFlow: {},
  set: (id, err) =>
    set((s) => {
      const byFlow = { ...s.byFlow };
      if (err) byFlow[id] = err;
      else delete byFlow[id];
      return { byFlow };
    }),
}));

const get = <T,>(service: "github" | "jira" | "slack", path: string): Promise<T> => {
  const { jiraSite, jiraEmail } = useStore.getState().integrations;
  return invoke<T>("integration_get", { service, path, jiraSite, jiraEmail });
};

const q = encodeURIComponent;
const cut = (text: string | null | undefined, n = 1500) => {
  const t = (text ?? "").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

interface GhIssue {
  id: number;
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  repository_url?: string;
  user?: { login: string };
}

async function github(t: Extract<FlowTrigger, { kind: "github" }>): Promise<Item[]> {
  const repo = t.repo?.trim() || null;
  const search = async (query: string, label: string) => {
    const res = await get<{ items: GhIssue[] }>("github", `/search/issues?q=${q(query)}&sort=created&order=desc&per_page=30`);
    return res.items.map((i) => {
      const where = i.repository_url?.split("/repos/")[1] ?? repo ?? "";
      return { key: String(i.id), text: `${label}: ${i.title} (${where}#${i.number})\n${i.html_url}${i.body ? `\n\n${cut(i.body)}` : ""}` };
    });
  };
  const scope = repo ? ` repo:${repo}` : "";
  switch (t.event) {
    case "review_requested":
      return search(`is:pr is:open review-requested:@me${scope}`, "Revisão pedida");
    case "issue_assigned":
      return search(`is:issue is:open assignee:@me${scope}`, "Issue atribuída");
    case "pr_opened":
      // Yours anywhere, or anyone's in one repository.
      if (t.author !== "anyone") return search(`is:pr author:@me${scope}`, "PR aberto por você");
      if (!repo) throw new Error("Escolha o repositório.");
      return search(`is:pr is:open${scope}`, "PR aberto");
    case "comment": {
      if (!repo) throw new Error("Informe o repositório (dono/nome).");
      const list = await get<Array<{ id: number; body: string; html_url: string; user?: { login: string } }>>(
        "github",
        `/repos/${repo}/issues/comments?sort=created&direction=desc&per_page=30`,
      );
      return list.map((c) => ({ key: String(c.id), text: `Comentário de ${c.user?.login ?? "alguém"}:\n${cut(c.body)}\n${c.html_url}` }));
    }
    case "ci_failed":
    case "ci_passed": {
      if (!repo) throw new Error("Informe o repositório (dono/nome).");
      const want = t.event === "ci_failed" ? "failure" : "success";
      const res = await get<{
        workflow_runs: Array<{ id: number; name: string; conclusion: string | null; head_branch: string; html_url: string; display_title?: string }>;
      }>("github", `/repos/${repo}/actions/runs?status=completed&per_page=20`);
      return res.workflow_runs
        .filter((r) => r.conclusion === want)
        .map((r) => ({
          key: String(r.id),
          text: `CI ${r.name} ${want === "failure" ? "falhou" : "passou"} em ${r.head_branch}${r.display_title ? `: ${r.display_title}` : ""}\n${r.html_url}`,
        }));
    }
  }
}

/** Ready searches; each issue that starts matching one starts the flow. */
export const JIRA_PRESETS: Array<{ id: string; label: string; jql: string }> = [
  { id: "assigned", label: "Atribuídas a mim, em aberto", jql: "assignee = currentUser() AND statusCategory != Done" },
  { id: "reported", label: "Criadas por mim", jql: "reporter = currentUser()" },
  { id: "urgent", label: "Prioridade alta atribuídas a mim", jql: "assignee = currentUser() AND priority in (Highest, High) AND statusCategory != Done" },
  { id: "done", label: "Minhas que foram concluídas", jql: "assignee = currentUser() AND statusCategory = Done AND resolved >= -7d" },
  { id: "watching", label: "Que eu acompanho, mexidas hoje", jql: "watcher = currentUser() AND updated >= startOfDay()" },
  { id: "unassigned", label: "Novas sem responsável", jql: "assignee is EMPTY AND statusCategory != Done AND created >= -7d" },
];

/** The JQL a Jira trigger runs. */
export function jiraQuery(t: Extract<FlowTrigger, { kind: "jira" }>): string {
  const preset = JIRA_PRESETS.find((p) => p.id === t.preset);
  if (!preset) return t.jql.trim();
  const project = t.project?.trim();
  return project ? `project = "${project.replace(/"/g, "")}" AND ${preset.jql}` : preset.jql;
}

async function jira(t: Extract<FlowTrigger, { kind: "jira" }>): Promise<Item[]> {
  const jql = jiraQuery(t);
  if (!jql) throw new Error("Escreva a busca JQL.");
  const site = useStore.getState().integrations.jiraSite.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const res = await get<{ issues: Array<{ key: string; fields: { summary?: string; status?: { name?: string } } }> }>(
    "jira",
    `/rest/api/3/search/jql?jql=${q(jql)}&fields=summary,status&maxResults=50`,
  );
  return res.issues.map((i) => ({
    key: i.key,
    text: `${i.key}: ${i.fields.summary ?? ""}${i.fields.status?.name ? ` [${i.fields.status.name}]` : ""}\nhttps://${site}/browse/${i.key}`,
  }));
}

let slackUser: string | null = null;
/** When DMs were last looked at, per flow, in Slack's seconds. */
const dmSince: Record<string, string> = {};

interface SlackMatch {
  ts: string;
  text: string;
  username?: string;
  permalink?: string;
  channel?: { id: string; name?: string };
}

async function slack(t: Extract<FlowTrigger, { kind: "slack" }>, flowId: string): Promise<Item[]> {
  if (!slackUser) slackUser = (await get<{ user_id: string }>("slack", "/auth.test")).user_id;
  const search = async (query: string, label: string) => {
    const res = await get<{ messages: { matches: SlackMatch[] } }>("slack", `/search.messages?query=${q(query)}&sort=timestamp&sort_dir=desc&count=20`);
    return res.messages.matches.map((m) => ({
      key: `${m.channel?.id ?? ""}:${m.ts}`,
      text: `${label}${m.channel?.name ? ` em #${m.channel.name}` : ""}, de ${m.username ?? "alguém"}:\n${cut(m.text)}${m.permalink ? `\n${m.permalink}` : ""}`,
    }));
  };
  if (t.event === "mention") return search(`<@${slackUser}>`, "Menção");
  if (t.event === "channel") {
    const name = t.channel?.trim().replace(/^#/, "");
    if (!name) throw new Error("Informe o canal.");
    return search(`in:#${name}`, "Mensagem");
  }
  // DMs: each open conversation, since the last look.
  const since = dmSince[flowId] ?? String(Date.now() / 1000 - POLL_MS / 1000);
  dmSince[flowId] = String(Date.now() / 1000);
  const ims = await get<{ channels: Array<{ id: string; user?: string }> }>("slack", "/conversations.list?types=im&exclude_archived=true&limit=50");
  const out: Item[] = [];
  const mine = t.person ? ims.channels.filter((c) => c.user === t.person) : ims.channels;
  for (const im of mine.slice(0, 25)) {
    const h = await get<{ messages: Array<{ ts: string; text: string; user?: string }> }>("slack", `/conversations.history?channel=${im.id}&oldest=${since}&limit=20`);
    for (const m of h.messages) {
      if (m.user === slackUser) continue;
      out.push({ key: `${im.id}:${m.ts}`, text: `Mensagem direta${m.user ? ` de <@${m.user}>` : ""}:\n${cut(m.text)}` });
    }
  }
  return out;
}

/** The trigger's settings, kept with what it saw, so changing them starts over. */
const signature = (t: ServiceTrigger) => `sig:${JSON.stringify(t)}`;

const lastPoll: Record<string, number> = {};
const polling = new Set<string>();

async function poll(flow: Flow, t: ServiceTrigger): Promise<void> {
  if (polling.has(flow.id)) return;
  polling.add(flow.id);
  lastPoll[flow.id] = Date.now();
  try {
    const items = t.kind === "github" ? await github(t) : t.kind === "jira" ? await jira(t) : await slack(t, flow.id);
    useTriggerErrors.getState().set(flow.id, null);
    const s = useStore.getState();
    const sig = signature(t);
    const seen = s.triggerSeen[flow.id];
    const known = seen && seen[0] === sig ? new Set(seen.slice(1)) : null;
    const fresh = known ? items.filter((i) => !known.has(i.key)) : [];
    // The first look only learns what is already there.
    const keys = [...items.map((i) => i.key), ...(known ? [...known] : [])];
    s.setTriggerSeen(flow.id, [sig, ...[...new Set(keys)].slice(0, KEEP_SEEN)]);
    if (!fresh.length) return;
    // Over a usage ceiling, the new items are let go like any held run.
    if (quotaResetAt(Date.now()) !== null) return;
    const shown = fresh.slice(0, MAX_ITEMS);
    const more = fresh.length > shown.length ? `\n\n(e mais ${fresh.length - shown.length})` : "";
    startFlow(flow, { text: shown.map((i) => i.text).join("\n\n---\n\n") + more, cwd: null });
  } catch (err) {
    useTriggerErrors.getState().set(flow.id, String(err).replace(/^Error: /, ""));
  } finally {
    polling.delete(flow.id);
  }
}

const isService = (t: FlowTrigger): t is ServiceTrigger => t.kind === "github" || t.kind === "jira" || t.kind === "slack";

const triggerOf = (flow: Flow) => {
  const node = flow.nodes.find((n) => n.kind === "trigger");
  return node && node.kind === "trigger" ? node.trigger : null;
};

/** Looks up the service triggers, answers webhooks and keeps the machine awake when asked. */
export function startIntegrations(): () => void {
  const tick = () => {
    const now = Date.now();
    for (const flow of useStore.getState().flows) {
      const t = triggerOf(flow);
      if (!flow.enabled || !t || !isService(t)) continue;
      if (now - (lastPoll[flow.id] ?? 0) < POLL_MS) continue;
      void poll(flow, t);
    }
  };
  const timer = setInterval(tick, TICK_MS);
  const first = setTimeout(tick, 5_000);

  const hook = listen<{ flowId: string; key: string; body: string }>("flow-webhook", ({ payload }) => {
    const flow = useStore.getState().flows.find((f) => f.id === payload.flowId);
    const t = flow && triggerOf(flow);
    if (!flow || !t || t.kind !== "webhook" || !flow.enabled || !t.key || payload.key !== t.key) return;
    startFlow(flow, { text: payload.body.trim() || "O webhook foi chamado.", cwd: null });
  });

  // Awake while some enabled flow waits on a clock or a service.
  let awake = false;
  const syncAwake = () => {
    const s = useStore.getState();
    const want =
      s.keepAwake &&
      s.flows.some((f) => {
        const t = triggerOf(f);
        return f.enabled && t && t.kind !== "manual" && t.kind !== "event";
      });
    if (want === awake) return;
    awake = want;
    void invoke("keep_awake", { on: want }).catch((err) => console.error("keep awake failed", err));
  };
  syncAwake();
  const unsub = useStore.subscribe((s, prev) => {
    if (s.flows !== prev.flows || s.keepAwake !== prev.keepAwake) syncAwake();
  });

  return () => {
    clearInterval(timer);
    clearTimeout(first);
    unsub();
    void hook.then((u) => u());
    if (awake) void invoke("keep_awake", { on: false });
  };
}

let repoCache: { at: number; list: string[] } | null = null;

/** The repositories the user can see, most recently pushed first, for the trigger's picker. */
export async function githubRepos(): Promise<string[]> {
  if (repoCache && Date.now() - repoCache.at < 10 * 60_000) return repoCache.list;
  const pages = await Promise.all(
    [1, 2].map((page) => get<Array<{ full_name: string }>>("github", `/user/repos?sort=pushed&per_page=100&page=${page}`).catch(() => [])),
  );
  const list = pages.flat().map((r) => r.full_name);
  repoCache = { at: Date.now(), list };
  return list;
}

const cached = new Map<string, { at: number; value: unknown }>();
async function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cached.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value as T;
  const value = await load();
  cached.set(key, { at: Date.now(), value });
  return value;
}

/** The Slack channels the user is in, by name, for the trigger's picker. */
export function slackChannels(): Promise<string[]> {
  return once("slack-channels", async () => {
    const res = await get<{ channels: Array<{ name: string; is_member?: boolean }> }>(
      "slack",
      "/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=500",
    );
    return res.channels.filter((c) => c.is_member !== false).map((c) => c.name).sort((a, b) => a.localeCompare(b));
  });
}

/** The people of the workspace, for the DM picker. */
export function slackPeople(): Promise<Array<{ id: string; name: string }>> {
  return once("slack-people", async () => {
    const res = await get<{ members: Array<{ id: string; deleted?: boolean; is_bot?: boolean; real_name?: string; name: string; profile?: { display_name?: string } }> }>(
      "slack",
      "/users.list?limit=500",
    );
    return res.members
      .filter((m) => !m.deleted && !m.is_bot && m.id !== "USLACKBOT")
      .map((m) => ({ id: m.id, name: m.real_name || m.profile?.display_name || m.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

/** Looks up a flow's trigger now, for the trigger card's button. */
export function pollNow(flow: Flow): void {
  const t = triggerOf(flow);
  if (t && isService(t)) void poll(flow, t);
}
