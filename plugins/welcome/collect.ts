import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../src/lib/store";
import { useTodos } from "../todo/state";
import type { Place } from "./state";

export type Outcome<T> = { value: T } | { error: string };

export interface Weather {
  now: { temp: number; feels: number; humidity: number; wind: number; code: number; isDay: boolean };
  /** The next twelve hours. */
  hours: { time: string; temp: number; rain: number; code: number }[];
  /** Today first, then the next three days. */
  days: { date: string; code: number; max: number; min: number; rain: number; rainMm: number }[];
}

export interface RepoCommits {
  name: string;
  path: string;
  commits: { sha: string; at: number; subject: string }[];
}

export interface DaySession {
  id: string;
  title: string;
  cwd: string | null;
  prompts: number;
  first: number;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string | null;
  draft: boolean;
  createdAt: string;
  review: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  ci: string | null;
  /** On a reviewed one: what the user's last review that day said. */
  verdict?: string;
}

export interface Github {
  opened: PullRequest[];
  merged: PullRequest[];
  reviewed: PullRequest[];
  mine: PullRequest[];
  asked: PullRequest[];
}

export interface Welcome {
  at: number;
  /** The last working day, YYYY-MM-DD. */
  day: string;
  work: Outcome<{ repos: RepoCommits[]; sessions: DaySession[] }>;
  github: Outcome<Github>;
  /** Null while no city is chosen. */
  weather: Outcome<Weather> | null;
  /** Null while the Todo list plugin is off. */
  todos: string[] | null;
}

export const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Yesterday, or Friday when today is Saturday, Sunday or Monday. */
export function lastWorkday(now = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const settle = <T,>(p: Promise<T>): Promise<Outcome<T>> =>
  p.then(
    (value) => ({ value }),
    (err) => ({ error: errorText(err) }),
  );

async function weather(place: Place): Promise<Weather> {
  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    timezone: "auto",
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
    hourly: "temperature_2m,precipitation_probability,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
    forecast_days: "4",
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`previsão indisponível (${res.status})`);
  const d = await res.json();
  const hour = d.current.time.slice(0, 13);
  const start = Math.max(0, d.hourly.time.findIndex((t: string) => t.slice(0, 13) === hour)) + 1;
  return {
    now: {
      temp: d.current.temperature_2m,
      feels: d.current.apparent_temperature,
      humidity: d.current.relative_humidity_2m,
      wind: d.current.wind_speed_10m,
      code: d.current.weather_code,
      isDay: d.current.is_day === 1,
    },
    hours: d.hourly.time.slice(start, start + 12).map((t: string, i: number) => ({
      time: t.slice(11, 16),
      temp: d.hourly.temperature_2m[start + i],
      rain: d.hourly.precipitation_probability[start + i],
      code: d.hourly.weather_code[start + i],
    })),
    days: d.daily.time.map((date: string, i: number) => ({
      date,
      code: d.daily.weather_code[i],
      max: d.daily.temperature_2m_max[i],
      min: d.daily.temperature_2m_min[i],
      rain: d.daily.precipitation_probability_max[i],
      rainMm: d.daily.precipitation_sum[i],
    })),
  };
}

/** Cities matching a name, for the city picker. */
export async function searchPlaces(name: string): Promise<Place[]> {
  const params = new URLSearchParams({ name, count: "6", language: "pt", format: "json" });
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
  if (!res.ok) throw new Error(`busca indisponível (${res.status})`);
  const d = await res.json();
  return (d.results ?? []).map((r: Record<string, unknown>) => ({
    name: [r.name, r.admin1, r.country_code].filter(Boolean).join(", "),
    latitude: r.latitude as number,
    longitude: r.longitude as number,
  }));
}

/** Folders the user works in: the registered ones and those of the open tabs. */
function workFolders(): string[] {
  const s = useStore.getState();
  return [...new Set([...s.folders.map((f) => f.path), ...s.tabs.map((t) => t.cwd).filter((c): c is string => !!c)])];
}

type Node = Record<string, any>;

function pr(n: Node): PullRequest {
  const rollup = n.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  return {
    number: n.number,
    title: n.title,
    url: n.url,
    repo: n.repository?.name ?? "",
    author: n.author?.login ?? null,
    draft: !!n.isDraft,
    createdAt: n.createdAt,
    review: n.reviewDecision ?? null,
    ci: rollup?.state ?? null,
  };
}

async function github(day: string): Promise<Github> {
  const d = await invoke<Node>("welcome_github", { day });
  const nodes = (key: string): Node[] => (d[key]?.nodes ?? []).filter((n: Node) => n && n.number);
  const login = d.viewer?.login;
  // GitHub has no search by review date: keep those the user reviewed that day.
  const reviewed = nodes("reviewed").flatMap((n) => {
    const mine = (n.reviews?.nodes ?? []).filter(
      (r: Node) => r.author?.login === login && r.submittedAt && ymd(new Date(r.submittedAt)) === day,
    );
    return mine.length ? [{ ...pr(n), verdict: mine[mine.length - 1].state }] : [];
  });
  return {
    opened: nodes("opened").map(pr),
    merged: nodes("merged").map(pr),
    reviewed,
    mine: nodes("mine").map(pr),
    asked: nodes("asked").map(pr),
  };
}

async function todos(): Promise<string[] | null> {
  if (!useStore.getState().enabledPlugins.includes("todo")) return null;
  await useTodos.getState().load();
  return useTodos
    .getState()
    .todos.filter((t) => !t.done)
    .map((t) => t.text);
}

/** Everything the page shows, each source on its own so one failing leaves the rest. */
export async function collect(place: Place | null): Promise<Welcome> {
  const day = lastWorkday();
  const start = day.getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  const [work, gh, w, t] = await Promise.all([
    settle(invoke<{ repos: RepoCommits[]; sessions: DaySession[] }>("welcome_day", { startMs: start, endMs: end, folders: workFolders() })),
    settle(github(ymd(day))),
    place ? settle(weather(place)) : Promise.resolve(null),
    todos().catch(() => null),
  ]);
  return { at: Date.now(), day: ymd(day), work, github: gh, weather: w, todos: t };
}
