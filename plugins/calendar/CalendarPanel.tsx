import { useEffect, useMemo, useState } from "react";
import { openSession, useStore } from "../../src/lib/store";
import {
  byWhen,
  dayOf,
  newEvent,
  pending,
  PRIORITIES,
  PRIORITY_LABEL,
  today,
  useCalendar,
  type CalendarEvent,
  type Priority,
} from "./state";

const WEEKDAYS = ["D", "S", "T", "Q", "Q", "S", "S"];

const monthTitle = (year: number, month: number) => {
  const text = new Date(year, month, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** How a day reads next to an event: "hoje", "ontem" or the date. */
function dayLabel(day: string, now: string): string {
  if (day === now) return "hoje";
  const yesterday = new Date(`${now}T00:00`);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === dayOf(yesterday)) return "ontem";
  return new Date(`${day}T00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

const folderName = (cwd: string | null) => cwd?.split(/[\\/]/).filter(Boolean).pop() ?? null;

/** The days drawn for a month: whole weeks, from the Sunday on or before the 1st. */
function monthDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const weeks = Math.ceil((first.getDay() + new Date(year, month + 1, 0).getDate()) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

function EventRow({ event, now, showDay }: { event: CalendarEvent; now: string; showDay: boolean }) {
  const { update, remove } = useCalendar();
  const tabs = useStore((s) => s.tabs);
  const [editing, setEditing] = useState(false);
  const when = [showDay ? dayLabel(event.date, now) : null, event.time ?? (showDay ? null : "dia todo")].filter(Boolean).join(" ");
  const meta = [
    when,
    event.by === "claude" ? "Claude" : null,
    folderName(event.cwd),
    tabs.find((t) => t.id === event.tabId)?.title ?? (event.tabTitle || null),
  ]
    .filter(Boolean)
    .join(" · ");
  if (editing) return <EventForm event={event} day={event.date} onDone={() => setEditing(false)} />;
  return (
    <li className={`cal-event ${event.done ? "done" : ""}`}>
      <input
        type="checkbox"
        checked={event.done}
        title={event.done ? "Reabrir" : "Marcar como cumprido"}
        onChange={() => void update(event.id, { done: !event.done })}
      />
      <span className={`cal-prio ${event.priority}`} title={`Prioridade ${PRIORITY_LABEL[event.priority].toLowerCase()}`} />
      <div className="cal-body" onDoubleClick={() => setEditing(true)}>
        <span className="cal-title">{event.title}</span>
        {event.notes && <span className="cal-notes">{event.notes}</span>}
        {meta && <span className="cal-meta">{meta}</span>}
      </div>
      {event.sessionId && (
        <button
          className="icon-btn"
          title="Voltar à sessão"
          onClick={() => openSession({ id: event.sessionId!, cwd: event.cwd, title: event.tabTitle || "Sessão" })}
        >
          ↩
        </button>
      )}
      <button className="icon-btn" title="Editar" onClick={() => setEditing(true)}>
        ✎
      </button>
      <button className="icon-btn" title="Apagar" onClick={() => void remove(event.id)}>
        ×
      </button>
    </li>
  );
}

/** Adds an event on `day`, or edits `event`. */
function EventForm({ event, day, onDone }: { event?: CalendarEvent; day: string; onDone?: () => void }) {
  const { add, update } = useCalendar();
  const [title, setTitle] = useState(event?.title ?? "");
  const [time, setTime] = useState(event?.time ?? "");
  const [priority, setPriority] = useState<Priority>(event?.priority ?? "medium");
  const [notes, setNotes] = useState(event?.notes ?? "");

  const submit = () => {
    const text = title.trim();
    if (!text) return;
    const fields = { title: text, time: time || null, priority, notes: notes.trim() };
    if (event) void update(event.id, fields);
    else {
      const s = useStore.getState();
      void add(newEvent({ ...fields, date: day }, "user", s.tabs.find((t) => t.id === s.activeTabId)));
      setTitle("");
      setTime("");
      setNotes("");
    }
    onDone?.();
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && onDone) onDone();
  };

  return (
    <li className="cal-form">
      <input
        className="cal-input"
        placeholder={event ? "Título" : "Novo evento (Enter para marcar)"}
        value={title}
        autoFocus={!!event}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={keys}
      />
      <div className="cal-form-row">
        <input className="cal-input cal-time" type="time" value={time} title="Sem hora, vale o dia todo" onChange={(e) => setTime(e.target.value)} onKeyDown={keys} />
        <select className="cal-input" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
        {event && (
          <>
            <button className="primary" onClick={submit}>
              Salvar
            </button>
            <button className="ghost" onClick={onDone}>
              Cancelar
            </button>
          </>
        )}
      </div>
      {event && <textarea className="cal-input" rows={2} placeholder="Notas" value={notes} onChange={(e) => setNotes(e.target.value)} />}
    </li>
  );
}

/** Notifications on top, then the month and the chosen day's events. */
export function CalendarPanel() {
  const { events, loaded, load } = useCalendar();
  const [now, setNow] = useState(today());
  const [selected, setSelected] = useState(now);
  const [view, setView] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  useEffect(() => void load(), [load]);
  // A panel left open past midnight moves on to the new day.
  useEffect(() => {
    const timer = setInterval(() => setNow(today()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const notifications = useMemo(() => pending(events, now), [events, now]);
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events) map.set(e.date, [...(map.get(e.date) ?? []), e]);
    return map;
  }, [events]);
  const dayEvents = [...(byDay.get(selected) ?? [])].sort(byWhen);

  const shiftMonth = (by: number) =>
    setView(({ year, month }) => {
      const d = new Date(year, month + by, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  const goToday = () => {
    const d = new Date();
    setView({ year: d.getFullYear(), month: d.getMonth() });
    setSelected(today());
  };

  if (!loaded) return <p className="hint pad">Carregando…</p>;

  return (
    <div className="cal">
      <section className="cal-section">
        <h4 className="cal-heading">
          Notificações {notifications.length > 0 && <span className="cal-count">{notifications.length}</span>}
        </h4>
        {notifications.length === 0 ? (
          <p className="hint">Nada para hoje.</p>
        ) : (
          <ul className="cal-list">
            {notifications.map((e) => (
              <EventRow key={e.id} event={e} now={now} showDay />
            ))}
          </ul>
        )}
      </section>

      <section className="cal-section">
        <div className="cal-nav">
          <button className="icon-btn" title="Mês anterior" onClick={() => shiftMonth(-1)}>
            ‹
          </button>
          <span className="cal-month">{monthTitle(view.year, view.month)}</span>
          <button className="icon-btn" title="Próximo mês" onClick={() => shiftMonth(1)}>
            ›
          </button>
          <button className="ghost cal-today" onClick={goToday}>
            Hoje
          </button>
        </div>
        <div className="cal-grid">
          {WEEKDAYS.map((w, i) => (
            <span key={i} className="cal-weekday">
              {w}
            </span>
          ))}
          {monthDays(view.year, view.month).map((d) => {
            const key = dayOf(d);
            const open = (byDay.get(key) ?? []).filter((e) => !e.done);
            const top = PRIORITIES.find((p) => open.some((e) => e.priority === p));
            return (
              <button
                key={key}
                className={[
                  "cal-day",
                  d.getMonth() !== view.month ? "other" : "",
                  key === now ? "today" : "",
                  key === selected ? "selected" : "",
                ].join(" ")}
                title={open.length ? `${open.length} evento(s) em aberto` : undefined}
                onClick={() => setSelected(key)}
              >
                {d.getDate()}
                {top && <span className={`cal-dot ${top}`} />}
              </button>
            );
          })}
        </div>
      </section>

      <section className="cal-section cal-day-section">
        <h4 className="cal-heading">
          {new Date(`${selected}T00:00`).toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })}
        </h4>
        <ul className="cal-list">
          <EventForm key={selected} day={selected} />
          {dayEvents.map((e) => (
            <EventRow key={e.id} event={e} now={now} showDay={false} />
          ))}
        </ul>
      </section>
    </div>
  );
}
