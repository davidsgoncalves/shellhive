import { useEffect } from "react";
import { setPluginBadge, type ShellhivePlugin, type ToolReply } from "../../src/lib/plugins";
import { useStore } from "../../src/lib/store";
import { RailIcon } from "../../src/components/RailIcon";
import { CalendarPanel } from "./CalendarPanel";
import {
  dayOf,
  isDay,
  isPriority,
  isTime,
  newEvent,
  pending,
  timeOf,
  today,
  useCalendar,
  type CalendarEvent,
} from "./state";
import manifest from "./plugin.json";
import "./calendar.css";

/** How often the count on the icon is redone, so a new day brings its events in. */
const BADGE_TICK_MS = 60_000;

/** Keeps the rail icon's count of notifications while the plugin is on. */
function BadgeKeeper() {
  const events = useCalendar((s) => s.events);
  useEffect(() => {
    void useCalendar.getState().load();
  }, []);
  useEffect(() => {
    const count = () => setPluginBadge(manifest.id, pending(useCalendar.getState().events).length);
    count();
    const timer = setInterval(count, BADGE_TICK_MS);
    return () => clearInterval(timer);
  }, [events]);
  useEffect(() => () => setPluginBadge(manifest.id, 0), []);
  return null;
}

const shown = (e: CalendarEvent) => ({
  id: e.id,
  title: e.title,
  date: e.date,
  time: e.time,
  priority: e.priority,
  done: e.done,
  notes: e.notes || undefined,
  from: e.tabTitle || undefined,
});

const fail = (text: string): ToolReply => ({ text, isError: true });

async function find(id: unknown): Promise<CalendarEvent | undefined> {
  await useCalendar.getState().load();
  return useCalendar.getState().events.find((e) => e.id === id);
}

const plugin: ShellhivePlugin = {
  manifest,
  Overlay: BadgeKeeper,
  SideTab: {
    title: "Calendário",
    Component: CalendarPanel,
    icon: (
      <RailIcon>
        <rect x="4" y="5" width="16" height="15" rx="2" />
        <path d="M4 10h16M9 3v4M15 3v4" />
      </RailIcon>
    ),
  },
  tools: {
    add_event: async (args, { tabId }) => {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!title) return fail("Informe o evento em `title`.");
      if (args.date !== undefined && !isDay(args.date)) return fail("`date` vai no formato AAAA-MM-DD.");
      if (args.time !== undefined && !isTime(args.time)) return fail("`time` vai no formato HH:MM.");
      if (args.priority !== undefined && !isPriority(args.priority)) return fail("`priority` é low, medium ou high.");
      const now = new Date();
      // No day and no time is a heads-up for right now.
      const date = (args.date as string | undefined) ?? dayOf(now);
      const time = (args.time as string | undefined) ?? (args.date === undefined ? timeOf(now) : null);
      const tab = useStore.getState().tabs.find((t) => t.id === tabId);
      const event = newEvent(
        { title, date, time, priority: (args.priority as CalendarEvent["priority"]) ?? "medium", notes: typeof args.notes === "string" ? args.notes.trim() : "" },
        "claude",
        tab,
      );
      await useCalendar.getState().add(event);
      return { text: `Evento marcado: ${JSON.stringify(shown(event))}. Hoje é ${today()}.` };
    },
    list_events: async (args) => {
      if (args.from !== undefined && !isDay(args.from)) return fail("`from` vai no formato AAAA-MM-DD.");
      if (args.to !== undefined && !isDay(args.to)) return fail("`to` vai no formato AAAA-MM-DD.");
      await useCalendar.getState().load();
      const from = (args.from as string | undefined) ?? today();
      const end = new Date(`${from}T00:00`);
      end.setDate(end.getDate() + 30);
      const to = (args.to as string | undefined) ?? dayOf(end);
      const events = useCalendar.getState().events;
      const range = events.filter((e) => e.date >= from && e.date <= to).sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
      return {
        text: JSON.stringify({ today: today(), from, to, events: range.map(shown), notifications: pending(events).map(shown) }, null, 2),
      };
    },
    update_event: async (args) => {
      const event = await find(args.id);
      if (!event) return fail("Evento não encontrado; veja os ids em list_events.");
      const patch: Partial<CalendarEvent> = {};
      if (args.title !== undefined) {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        if (!title) return fail("`title` não pode ficar vazio.");
        patch.title = title;
      }
      if (args.date !== undefined) {
        if (!isDay(args.date)) return fail("`date` vai no formato AAAA-MM-DD.");
        patch.date = args.date;
      }
      if (args.time !== undefined) {
        if (args.time !== null && !isTime(args.time)) return fail("`time` vai no formato HH:MM, ou null para o dia inteiro.");
        patch.time = args.time as string | null;
      }
      if (args.priority !== undefined) {
        if (!isPriority(args.priority)) return fail("`priority` é low, medium ou high.");
        patch.priority = args.priority;
      }
      if (typeof args.notes === "string") patch.notes = args.notes.trim();
      await useCalendar.getState().update(event.id, patch);
      return { text: `Evento atualizado: ${JSON.stringify(shown({ ...event, ...patch }))}` };
    },
    complete_event: async (args) => {
      const event = await find(args.id);
      if (!event) return fail("Evento não encontrado; veja os ids em list_events.");
      await useCalendar.getState().update(event.id, { done: true });
      return { text: `Evento cumprido: ${event.title}` };
    },
    remove_event: async (args) => {
      const event = await find(args.id);
      if (!event) return fail("Evento não encontrado; veja os ids em list_events.");
      await useCalendar.getState().remove(event.id);
      return { text: `Evento apagado: ${event.title}` };
    },
  },
};

export default plugin;
