import { useCallback, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { searchPlaces, type Github, type Jira, type JiraIssue, type Outcome, type PullRequest, type Weather, type Welcome } from "./collect";
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

/** At night, the codes whose icon has a sun in it. */
const NIGHT: Record<number, string> = { 0: "🌙", 1: "🌙", 2: "☁️", 51: "🌧️", 53: "🌧️", 61: "🌧️", 80: "🌧️" };

export const weatherIcon = (code: number, day = true) => (!day && NIGHT[code]) || WEATHER[code]?.[0] || "🌡️";
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
    <div className="welcome-section">
      <h3>
        {title} {count !== undefined && <span className="welcome-count">{count}</span>}
      </h3>
      {count === 0 ? <p className="welcome-empty">{empty}</p> : children}
    </div>
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

/** The mouse wheel scrolls a strip sideways while it has room to move. */
function useWheelSideways() {
  return useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    el.addEventListener(
      "wheel",
      (e) => {
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || el.scrollWidth <= el.clientWidth) return;
        const max = el.scrollWidth - el.clientWidth;
        const next = Math.min(max, Math.max(0, el.scrollLeft + e.deltaY));
        if (next === el.scrollLeft) return;
        e.preventDefault();
        el.scrollLeft = next;
      },
      { passive: false },
    );
  }, []);
}

function WeatherCard({ weather, place }: { weather: Outcome<Weather> | null; place: Place | null }) {
  const [picking, setPicking] = useState(false);
  const wheelSideways = useWheelSideways();
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
        <div className="welcome-hours welcome-strip" ref={wheelSideways}>
          {hours.map((h) => (
            <div key={h.time} className="welcome-hour">
              <div className="welcome-muted">{h.time.slice(0, 2)}h</div>
              <div className="welcome-icon">{weatherIcon(h.code, h.isDay)}</div>
              <div>{deg(h.temp)}</div>
              <div className="welcome-rain">{h.rain >= 20 ? `${h.rain}%` : ""}</div>
            </div>
          ))}
        </div>
        <div className="welcome-days welcome-strip" ref={wheelSideways}>
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
    <section className="welcome-card welcome-columns">
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
        <div className="welcome-section">
          <h3>GitHub</h3>
          <Failed outcome={github} />
        </div>
      ) : (
        <PullsDone gh={github.value} />
      )}
      {data.jira && "value" in data.jira && (
        <Section title="Tarefas movidas no Jira" count={data.jira.value.moved.length} empty="Nenhuma tarefa movida.">
          <IssueList issues={data.jira.value.moved} />
        </Section>
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

function IssueList({ issues }: { issues: JiraIssue[] }) {
  return (
    <ul>
      {issues.map((i) => (
        <li key={i.key}>
          <span className="welcome-ref">{i.key}</span>
          <button className="welcome-link" title={i.url} onClick={() => openLink(i.url)}>
            {i.summary}
          </button>
          <span className={`welcome-tag ${i.category === "indeterminate" ? "warn" : ""}`}>{i.status}</span>
        </li>
      ))}
    </ul>
  );
}

const TOKENS_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

/** E-mail and API token, checked against the site before they are kept. */
function JiraConnect({ onCancel }: { onCancel?: () => void }) {
  const refresh = useWelcome((s) => s.refresh);
  const [form, setForm] = useState({ site: "", email: "", token: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
    onKeyDown: (e: KeyboardEvent) => e.key === "Enter" && void connect(),
  });
  const connect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("welcome_jira_connect", form);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="welcome-picker">
      <p className="welcome-empty">
        Conecte o Jira Cloud para ver suas tarefas. O token fica só nesta máquina; crie um em{" "}
        <button className="welcome-link inline" onClick={() => openLink(TOKENS_URL)}>
          id.atlassian.com
        </button>
        .
      </p>
      <input placeholder="Site (empresa.atlassian.net)" {...field("site")} />
      <input placeholder="E-mail da conta Atlassian" type="email" {...field("email")} />
      <input placeholder="Token de API" type="password" autoComplete="off" {...field("token")} />
      {error && <p className="error">{error}</p>}
      <div className="welcome-actions">
        <button className="ghost auto" disabled={busy} onClick={() => void connect()}>
          {busy ? "Conectando…" : "Conectar"}
        </button>
        {onCancel && (
          <button className="ghost auto" onClick={onCancel}>
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}

function JiraSection({ jira }: { jira: Outcome<Jira> | null }) {
  const refresh = useWelcome((s) => s.refresh);
  const [editing, setEditing] = useState(false);
  const disconnect = async () => {
    await invoke("welcome_jira_disconnect").catch(() => {});
    await refresh();
  };
  if (!jira)
    return (
      <>
        <h3>Jira</h3>
        <JiraConnect />
      </>
    );
  if ("error" in jira)
    return (
      <>
        <h3>Jira</h3>
        <Failed outcome={jira} />
        {editing ? (
          <JiraConnect onCancel={() => setEditing(false)} />
        ) : (
          <div className="welcome-actions">
            <button className="ghost auto" onClick={() => setEditing(true)}>
              Conectar de novo
            </button>
            <button className="ghost auto" onClick={() => void disconnect()}>
              Desconectar
            </button>
          </div>
        )}
      </>
    );
  const { account, open } = jira.value;
  return (
    <>
      <h3>
        Suas tarefas no Jira <span className="welcome-count">{open.length}</span>
        <button className="ghost auto welcome-h3-action" title={`${account.email} em ${account.site}`} onClick={() => void disconnect()}>
          Desconectar
        </button>
      </h3>
      {open.length === 0 ? <p className="welcome-empty">Nenhuma tarefa aberta.</p> : <IssueList issues={open} />}
    </>
  );
}

function TodayCard({ data }: { data: Welcome }) {
  const { github, todos } = data;
  return (
    <section className="welcome-card welcome-columns">
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
      <div className="welcome-section">
        <JiraSection jira={data.jira} />
      </div>
      {"error" in github ? (
        <div className="welcome-section">
          <h3>GitHub</h3>
          <Failed outcome={github} />
        </div>
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
    </section>
  );
}

const ok = <T,>(o: Outcome<T> | null | undefined): T | null => (o && "value" in o ? o.value : null);

function pendingCount(d: Welcome) {
  const gh = ok(d.github);
  return (d.todos?.length ?? 0) + (ok(d.jira)?.open.length ?? 0) + (gh ? gh.mine.length + gh.asked.length : 0);
}

function doneCount(d: Welcome) {
  const gh = ok(d.github);
  const work = ok(d.work);
  return (
    (work ? work.repos.reduce((n, r) => n + r.commits.length, 0) + work.sessions.length : 0) +
    (gh ? gh.opened.length + gh.merged.length + gh.reviewed.length : 0) +
    (ok(d.jira)?.moved.length ?? 0)
  );
}

/** The whole page; in the side panel it stacks into one column. */
export function WelcomePage({ compact, onClose }: { compact?: boolean; onClose?: () => void }) {
  const { data, loading, place, refresh } = useWelcome();
  const [tab, setTab] = useState<"today" | "done">("today");
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
          <div className="welcome-tabs" role="tablist">
            <button role="tab" aria-selected={tab === "today"} className={tab === "today" ? "on" : ""} onClick={() => setTab("today")}>
              Pendências <span className="welcome-count">{pendingCount(data)}</span>
            </button>
            <button role="tab" aria-selected={tab === "done"} className={tab === "done" ? "on" : ""} onClick={() => setTab("done")}>
              O que você fez · {dayLabel(data.day)} <span className="welcome-count">{doneCount(data)}</span>
            </button>
          </div>
          {tab === "today" ? <TodayCard data={data} /> : <DoneCard data={data} />}
        </>
      )}
    </div>
  );
}
