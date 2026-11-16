import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { isHiddenTab, type Tab, type Topic } from "./types";

/** A name compared without case or accents, so "Tópico" finds "topico". */
const plain = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();

/** Tabs that can keep a topic: not a colony's drones nor a worker bee's runs, which run hidden. */
export const canHaveTopics = (tab: Tab) => !isHiddenTab(tab);

export const activeTopics = (topics: Topic[]) => topics.filter((t) => !t.archived);

export function topicByName(name: string): Topic | undefined {
  const key = plain(name);
  return activeTopics(useStore.getState().topics).find((t) => plain(t.name) === key);
}

/** Creates a topic's folder and keeps the topic, attached to `tabId` when given. */
export async function createTopic(name: string, description: string, tabId?: string): Promise<Topic> {
  const id = await invoke<string>("topic_create", { name: name.trim(), description: description.trim() });
  const topic: Topic = { id, name: name.trim(), description: description.trim(), createdAt: Date.now() };
  const s = useStore.getState();
  s.addTopic(topic);
  if (tabId) s.setTabTopic(tabId, id, true);
  return topic;
}

/** `:topico Nome` typed in a tab: attaches the topic by that name, creating it when there is none. */
export async function attachByName(tabId: string, name: string): Promise<void> {
  const tab = useStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab || !canHaveTopics(tab) || !name.trim()) return;
  const found = topicByName(name);
  if (found) useStore.getState().setTabTopic(tabId, found.id, true);
  else await createTopic(name, "", tabId);
}

/** The topics attached to a tab, archived ones left out. */
export function topicsOf(tab: Tab, topics: Topic[]): Topic[] {
  return (tab.topicIds ?? []).map((id) => topics.find((t) => t.id === id && !t.archived)).filter((t): t is Topic => !!t);
}

/**
 * Keeps the backend told which topics each tab has, with the other tabs that
 * keep each one: it hands them to the tab's Claude through its hooks.
 */
export function startTopicSync(): () => void {
  let last = "";
  const sync = () => {
    const { tabs, topics } = useStore.getState();
    const map: Record<string, { id: string; name: string; description: string; others: string[] }[]> = {};
    for (const tab of tabs) {
      if (!canHaveTopics(tab)) continue;
      const mine = topicsOf(tab, topics);
      if (!mine.length) continue;
      map[tab.id] = mine.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        others: tabs.filter((o) => o.id !== tab.id && o.topicIds?.includes(t.id)).map((o) => o.title),
      }));
    }
    const text = JSON.stringify(map);
    if (text === last) return;
    last = text;
    void invoke("topic_tabs", { tabs: map }).catch(console.error);
  };
  sync();
  return useStore.subscribe(sync);
}
