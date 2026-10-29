import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { searchPlaces, type Github, type Outcome, type PullRequest, type Weather, type Welcome } from "./collect";
import { useWelcome, type Place } from "./state";

const WEATHER: Record<number, [string, string]> = {
  0: ["☀️", "céu limpo"], 1: ["🌤️", "predomínio de sol"], 2: ["⛅", "parcialmente nublado"], 3: ["☁️", "nublado"],
  45: ["🌫️", "neblina"], 48: ["🌫️", "neblina com geada"],
  51: ["🌦️", "garoa fraca"], 53: ["🌦️", "garoa"], 55: ["🌧️", "garoa forte"], 56: ["🌧️", "garoa congelante"], 57: ["🌧️", "garoa congelante"],
  61: ["🌦️", "chuva fraca"], 63: ["🌧️", "chuva"], 65: ["🌧️", "chuva forte"], 66: ["🌧️", "chuva congelante"], 67: ["🌧️", "chuva congelante"],
  71: ["🌨️", "neve fraca"], 73: ["🌨️", "neve"], 75: ["❄️", "neve forte"], 77: ["🌨️", "granizo fino"],
  80: ["🌦️", "pancadas de chuva"], 81: ["🌧️", "pancadas de chuva"], 82: ["⛈️", "pancadas fortes"], 85: ["🌨️", "pancadas de neve"], 86: ["🌨️", "pancadas de neve"],
  95: ["⛈️", "trovoadas"], 96: ["⛈️", "trovoadas com granizo"], 99: ["⛈️", "trovoadas com granizo"],
};

export const weatherIcon = (code: number, day = true) => (!day && code <= 1 ? "🌙" : WEATHER[code]?.[0] ?? "🌡️");
export const weatherText = (code: number) => WEATHER[code]?.[1] ?? "";
const deg = (n: number) => `${Math.round(n)}°`;
const time = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const weekday = (date: string) => new Date(`${date}T12:00`).toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
const home = (p: string | null) => (p ?? "").replace(/^(\/home\/[^/]+|\/Users\/[^/]+|[A-Z]:\\Users\\[^\\]+)/, "~");
const openLink = (url: string) => void invoke("link_open", { target: url }).catch(() => {});

export function dayLabel(day: string) {
  return new Date(`${day}T12:00`).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit" });
}

export function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

function age(iso: string) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days === 0 ? "hoje" : days === 1 ? "1 dia" : `${days} dias`;
}

function Section({ title, count, empty, children }: { title: string; count?: number; empty?: string; children?: ReactNode }) {
  return (
    <>
      <h3>
        {title} {count !== undefined && <span className="welcome-count">{count}</span>}
      </h3>
      {count === 0 ? <p className="welcome-empty">{empty}</p> : children}
    </>
  );
}

function Failed({ outcome }: { outcome: { error: string } }) {
  return <p className="error">{outcome.error}</p>;
}

function PrRow({ p, children }: { p: PullRequest; children?: ReactNode }) {
  return (
    <li>
      <span className="welcome-ref">
        {p.repo}#{p.number}
      </span>
      <button className="welcome-link" title={p.url} onClick={() => openLink(p.url)}>
        {p.title}
      </button>
      {children}
    </li>
  );
}

function ReviewTag({ p }: { p: PullRequest }) {
  if (p.draft) return <span className="welcome-tag">rascunho</span>;
  if (p.review === "APPROVED") return <span className="welcome-tag ok">aprovado</span>;
  if (p.review === "CHANGES_REQUESTED") return <span className="welcome-tag bad">mudanças pedidas</span>;
  return <span className="welcome-tag warn">aguardando review</span>;
}

function CiTag({ state }: { state: string | null }) {
  if (!state) return null;
  if (state === "SUCCESS") return <span className="welcome-tag ok">CI ok</span>;
  if (state === "FAILURE" || state === "ERROR") return <span className="welcome-tag bad">CI falhou</span>;
  return <span className="welcome-tag">CI pendente</span>;
}

const VERDICT: Record<string, [string, string]> = {
  APPROVED: ["ok", "aprovou"],
  CHANGES_REQUESTED: ["bad", "pediu mudanças"],
  COMMENTED: ["", "comentou"],
  DISMISSED: ["", "descartado"],
};

/** Failing CI and changes asked for first: those need the user. */
const urgency = (p: PullRequest) =>
  (p.ci === "FAILURE" || p.ci === "ERROR" ? 4 : 0) + (p.review === "CHANGES_REQUESTED" ? 2 : 0) - (p.draft ? 1 : 0);

function PlacePicker({ onDone }: { onDone?: () => void }) {
  const setPlace = useWelcome((s) => s.setPlace);
  const [name, setName] = useState("");
  const [found, setFound] = useState<Place[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = async () => {
    if (name.trim().length < 2) return;
    setError(null);
    try {
      setFound(await searchPlaces(name.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div className="welcome-picker">
      <input
        autoFocus
        placeholder="Nome da cidade (Enter para buscar)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void search()}
      />
      {error && <p className="error">{error}</p>}
      {found?.length === 0 && <p className="welcome-empty">Nenhuma cidade com esse nome.</p>}
      {found && found.length > 0 && (
        <ul>
          {found.map((p) => (
            <li key={`${p.latitude},${p.longitude}`}>
              <button className="welcome-link" onClick={() => void setPlace(p).then(onDone)}>
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WeatherCard({ weather, place }: { weather: Outcome<Weather> | null; place: Place | null }) {
  const [picking, setPicking] = useState(false);
  const title = (
    <h2>
      <span>Tempo{place ? ` em ${place.name}` : ""}</span>
      {place && (
        <button className="ghost auto" onClick={() => setPicking((p) => !p)}>
          {picking ? "Cancelar" : "Trocar cidade"}
        </button>
      )}
    </h2>
  );
  if (!place || picking)
    return (
      <section className="welcome-card">
        {title}
        {!place && <p className="welcome-empty">Escolha a cidade da previsão do tempo.</p>}
        <PlacePicker onDone={() => setPicking(false)} />
      </section>
    );
  if (!weather) return null;
  if ("error" in weather)
    return (
      <section className="welcome-card">
        {title}
        <Failed outcome={weather} />
      </section>
    );
  const { now, hours, days } = weather.value;
  const today = days[0];
  return (
    <section className="welcome-card">
      {title}
      <div className="welcome-weather">
        <div className="welcome-now">
          <span className="welcome-now-icon">{weatherIcon(now.code, now.isDay)}</span>
          <div>
            <div className="welcome-now-temp">{deg(now.temp)}</div>
            <div className="welcome-muted">{weatherText(now.code)}</div>
          </div>
          <div className="welcome-muted welcome-now-detail">
            sensação {deg(now.feels)}
            <br />
            mín {deg(today.min)} · máx {deg(today.max)}
            <br />
            chuva {today.rain}%{today.rainMm ? ` (${today.rainMm} mm)` : ""}
            <br />
            umidade {now.humidity}% · vento {Math.round(now.wind)} km/h
          </div>
        </div>
        <div className="welcome-hours">
          {hours.map((h) => {
            const hour = Number(h.time.slice(0, 2));
            return (
              <div key={h.time} className="welcome-hour">
                <div className="welcome-muted">{h.time.slice(0, 2)}h</div>
                <div className="welcome-icon">{weatherIcon(h.code, hour >= 6 && hour < 19)}</div>
                <div>{deg(h.temp)}</div>
                <div className="welcome-rain">{h.rain >= 20 ? `${h.rain}%` : ""}</div>
              </div>
            );
          })}
        </div>
        <div className="welcome-days">
          {days.slice(1).map((d) => (
            <div key={d.date} className="welcome-day" title={`${weatherText(d.code)}, chuva ${d.rain}%`}>
              <div className="welcome-muted">{weekday(d.date)}</div>
              <div className="welcome-icon">{weatherIcon(d.code)}</div>
              <div>
                {deg(d.max)} <span className="welcome-muted">{deg(d.min)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function DoneCard({ data }: { data: Welcome }) {
  const { work, github } = data;
  const commits = "value" in work ? work.value.repos.reduce((n, r) => n + r.commits.length, 0) : undefined;
  return (
    <section className="welcome-card">
      <h2>
        <span>O que você fez · {dayLabel(data.day)}</span>
      </h2>
      {"error" in work ? (
        <Failed outcome={work} />
      ) : (
        <>
          <Section title="Commits" count={commits} empty="Nenhum commit nas pastas em que você trabalha.">
            {work.value.repos.map((r) => (
              <div key={r.path}>
                <div className="welcome-repo" title={r.path}>
                  {r.name}
                </div>
                <ul>
                  {r.commits.map((c) => (
                    <li key={c.sha}>
                      <span className="welcome-ref">{time(c.at)}</span>
                      <span className="welcome-grow">{c.subject}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Section>
        </>
      )}
      {"error" in github ? (
        <>
          <h3>GitHub</h3>
          <Failed outcome={github} />
        </>
      ) : (
        <PullsDone gh={github.value} />
      )}
      {"value" in work && (
        <Section title="Sessões do Claude" count={work.value.sessions.length} empty="Nenhuma sessão.">
          <ul>
            {work.value.sessions.map((s) => (
              <li key={s.id}>
                <span className="welcome-ref">{time(s.first)}</span>
                <span className="welcome-grow">
                  {s.title} <span className="welcome-muted welcome-path">{home(s.cwd)}</span>
                </span>
                {s.prompts > 0 && <span className="welcome-muted">{s.prompts} msg</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </section>
  );
}

function PullsDone({ gh }: { gh: Github }) {
  return (
    <>
      <Section title="PRs abertos" count={gh.opened.length} empty="Nenhum PR aberto.">
        <ul>
          {gh.opened.map((p) => (
            <PrRow key={p.url} p={p} />
          ))}
        </ul>
      </Section>
      <Section title="PRs mergeados" count={gh.merged.length} empty="Nenhum PR mergeado.">
        <ul>
          {gh.merged.map((p) => (
            <PrRow key={p.url} p={p}>
              <span className="welcome-tag ok">merge</span>
            </PrRow>
          ))}
        </ul>
      </Section>
      <Section title="Reviews feitos" count={gh.reviewed.length} empty="Nenhum review.">
        <ul>
          {gh.reviewed.map((p) => {
            const [cls, label] = VERDICT[p.verdict ?? ""] ?? ["", p.verdict ?? ""];
            return (
              <PrRow key={p.url} p={p}>
                <span className="welcome-muted">{p.author}</span>
                <span className={`welcome-tag ${cls}`}>{label}</span>
              </PrRow>
            );
          })}
        </ul>
      </Section>
    </>
  );
}

function TodayCard({ data }: { data: Welcome }) {
  const { github, todos } = data;
  return (
    <section className="welcome-card">
      <h2>
        <span>Pendências de hoje</span>
      </h2>
      {"error" in github ? (
        <>
          <h3>GitHub</h3>
          <Failed outcome={github} />
        </>
      ) : (
        <>
          <Section title="Seus PRs abertos" count={github.value.mine.length} empty="Nenhum PR aberto.">
            <ul>
              {[...github.value.mine]
                .sort((a, b) => urgency(b) - urgency(a))
                .map((p) => (
                  <PrRow key={p.url} p={p}>
                    <ReviewTag p={p} />
                    <CiTag state={p.ci} />
                  </PrRow>
                ))}
            </ul>
          </Section>
          <Section title="Reviews pedidos a você" count={github.value.asked.length} empty="Nada para revisar.">
            <ul>
              {github.value.asked.map((p) => (
                <PrRow key={p.url} p={p}>
                  <span className="welcome-muted">{p.author}</span>
                  <span className="welcome-muted" title={`aberto em ${new Date(p.createdAt).toLocaleDateString("pt-BR")}`}>
                    {age(p.createdAt)}
                  </span>
                </PrRow>
              ))}
            </ul>
          </Section>
        </>
      )}
      {todos && (
        <Section title="Todo list" count={todos.length} empty="Lista vazia.">
          <ul>
            {todos.map((t, i) => (
              <li key={i}>
                <span className="welcome-grow">{t}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </section>
  );
}

/** The whole page; in the side panel it stacks into one column. */
export function WelcomePage({ compact, onClose }: { compact?: boolean; onClose?: () => void }) {
  const { data, loading, place, refresh } = useWelcome();
  const today = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  return (
    <div className={`welcome-page ${compact ? "compact" : ""}`}>
      <header>
        <div>
          <h1>{greeting()}!</h1>
          <p className="welcome-muted">Hoje é {today}.</p>
        </div>
        <div className="welcome-actions">
          {data && <span className="welcome-muted">atualizado às {time(data.at)}</span>}
          <button className="ghost auto" disabled={loading} onClick={() => void refresh()}>
            {loading ? "Atualizando…" : "Atualizar"}
          </button>
          {onClose && (
            <button className="icon-btn" title="Fechar e voltar ao terminal (Esc)" onClick={onClose}>
              ×
            </button>
          )}
        </div>
      </header>
      {!data ? (
        <p className="hint pad">Juntando o seu dia…</p>
      ) : (
        <>
          <WeatherCard weather={data.weather} place={place} />
          <div className="welcome-grid">
            <DoneCard data={data} />
            <TodayCard data={data} />
          </div>
        </>
      )}
    </div>
  );
}
