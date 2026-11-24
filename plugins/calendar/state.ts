import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "../../src/lib/types";

export type Priority = "low" | "medium" | "high";

export const PRIORITIES: Priority[] = ["high", "medium", "low"];
export const PRIORITY_LABEL: Record<Priority, string> = { high: "Alta", medium: "Média", low: "Baixa" };

export interface CalendarEvent {
  id: string;
  title: string;
  notes: string;
  /** Local day, YYYY-MM-DD. */
  date: string;
  /** Local time, HH:MM, or null for the whole day. */
  time: string | null;
  priority: Priority;
  done: boolean;
  /** Who wrote it: the user in the panel, or the agent through add_event. */
  by: "user" | "claude";
  createdAt: number;
  cwd: string | null;
  tabId: string | null;
  /** The tab's title when it was added, for when the tab is gone. */
  tabTitle: string;
  sessionId: string | null;
}

const PLUGIN_ID = "calendar";

const pad = (n: number) => String(n).padStart(2, "0");
export const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const today = () => dayOf(new Date());

export const isDay = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00`).getTime());
export const isTime = (v: unknown): v is string => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
export const isPriority = (v: unknown): v is Priority => v === "low" || v === "medium" || v === "high";

/** Earlier first; a whole-day event comes before the timed ones of its day. */
export const byWhen = (a: CalendarEvent, b: CalendarEvent) =>
  a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? "");

/**
 * What the notifications show: events of today or before that are not done,
 * high priority first, then by when.
 */
export function pending(events: CalendarEvent[], day = today()): CalendarEvent[] {
  return events
    .filter((e) => !e.done && e.date <= day)
    .sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || byWhen(a, b));
}

interface CalendarStore {
  events: CalendarEvent[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (e: CalendarEvent) => Promise<void>;
  update: (id: string, patch: Partial<CalendarEvent>) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const save = (events: CalendarEvent[]) =>
  invoke("plugin_storage_set", { id: PLUGIN_ID, value: { events } }).catch((err) =>
    console.error("calendar save failed", err),
  );

/** Every event, kept across restarts. */
export const useCalendar = create<CalendarStore>()((set, get) => {
  const change = async (next: (list: CalendarEvent[]) => CalendarEvent[]) => {
    await get().load();
    const events = next(get().events);
    set({ events });
    await save(events);
  };
  let loading: Promise<void> | null = null;
  return {
    events: [],
    loaded: false,
    load: () =>
      (loading ??= invoke<{ events?: CalendarEvent[] } | null>("plugin_storage_get", { id: PLUGIN_ID })
        .then((stored) => set({ events: Array.isArray(stored?.events) ? stored.events : [], loaded: true }))
        .catch(() => set({ loaded: true }))),
    add: (e) => change((list) => [...list, e]),
    update: (id, patch) => change((list) => list.map((e) => (e.id === id ? { ...e, ...patch, id } : e))),
    remove: (id) => change((list) => list.filter((e) => e.id !== id)),
  };
});

/** A new event, tied to the tab it came from and the session running there. */
export function newEvent(
  fields: Pick<CalendarEvent, "title" | "date" | "time" | "priority"> & { notes?: string },
  by: CalendarEvent["by"],
  tab: Tab | undefined,
): CalendarEvent {
  return {
    id: crypto.randomUUID(),
    notes: "",
    ...fields,
    done: false,
    by,
    createdAt: Date.now(),
    cwd: tab?.cwd ?? null,
    tabId: tab?.id ?? null,
    tabTitle: tab?.title ?? "",
    sessionId: tab?.claudeSessionId ?? null,
  };
}
