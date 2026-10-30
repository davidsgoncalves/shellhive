import type { Welcome } from "./collect";
import type { Place } from "./state";
import { dayLabel, weatherText } from "./WelcomePage";

/** The page as text, for the agent. */
export function summary(data: Welcome, place: Place | null): string {
  const lines: string[] = [];
  const pr = (p: { repo: string; number: number; title: string; url: string }) => `${p.repo}#${p.number} ${p.title} (${p.url})`;

  if (data.weather && "value" in data.weather && place) {
    const { now, days } = data.weather.value;
    lines.push(
      `## Tempo em ${place.name}`,
      `Agora ${Math.round(now.temp)}°C (sensação ${Math.round(now.feels)}°C), ${weatherText(now.code)}. ` +
        `Hoje: mín ${Math.round(days[0].min)}°C, máx ${Math.round(days[0].max)}°C, ${days[0].rain}% de chance de chuva.`,
      "",
    );
  }

  lines.push(`## O que o usuário fez em ${dayLabel(data.day)}`);
  if ("value" in data.work) {
    const { repos, sessions } = data.work.value;
    if (!repos.length) lines.push("- Nenhum commit nas pastas em que ele trabalha.");
    for (const r of repos) for (const c of r.commits) lines.push(`- Commit em ${r.name}: ${c.subject}`);
    for (const s of sessions) lines.push(`- Sessão do Claude: ${s.title}${s.cwd ? ` (${s.cwd})` : ""}`);
  } else {
    lines.push(`- Commits e sessões indisponíveis: ${data.work.error}`);
  }
  if ("value" in data.github) {
    const gh = data.github.value;
    for (const p of gh.opened) lines.push(`- PR aberto: ${pr(p)}`);
    for (const p of gh.merged) lines.push(`- PR mergeado: ${pr(p)}`);
    for (const p of gh.reviewed) lines.push(`- Review (${p.verdict}) no PR de ${p.author}: ${pr(p)}`);
  } else {
    lines.push(`- GitHub indisponível: ${data.github.error}`);
  }

  lines.push("", "## Pendências de hoje");
  if ("value" in data.github) {
    const gh = data.github.value;
    lines.push(`Seus PRs abertos (${gh.mine.length}):`);
    for (const p of gh.mine) lines.push(`- ${pr(p)}; review: ${p.review ?? "—"}; CI: ${p.ci ?? "—"}${p.draft ? "; rascunho" : ""}`);
    lines.push(`Reviews pedidos a ele (${gh.asked.length}):`);
    for (const p of gh.asked) lines.push(`- ${pr(p)}, de ${p.author}`);
  }
  if (data.todos?.length) {
    lines.push("Todo list:");
    for (const t of data.todos) lines.push(`- ${t}`);
  }
  return lines.join("\n");
}
