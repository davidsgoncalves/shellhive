import type { BeeRun, Repo, ReviewPr } from "./types";

/** A pull request waiting on the user's review, as the backend reads it from GitHub. */
export interface Candidate {
  repo: string;
  number: number;
  url: string;
  title: string;
  branch: string;
  head: string;
  reviewed_head: string | null;
  requested_at: string | null;
}

/** Time given after a review request for the related pull requests to arrive. */
export const REVIEW_DELAY_MS = 15 * 60_000;

const TASK_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;

/** A task key such as VK25-123, from the title or else the branch. */
function taskKey(c: Candidate): string | null {
  return TASK_KEY.exec(c.title)?.[1] ?? TASK_KEY.exec(c.branch.toUpperCase())?.[1] ?? null;
}

const prKey = (p: { repo: string; number: number; head: string }) => `${p.repo}#${p.number}@${p.head}`;

/**
 * Pull requests reviewed together: the same branch name or the same task key
 * joins them, across repositories.
 */
export function groupCandidates(list: Candidate[]): Candidate[][] {
  const groups: Candidate[][] = [];
  for (const c of list) {
    const key = taskKey(c);
    const joined = groups.filter((g) => g.some((o) => o.branch === c.branch || (key && taskKey(o) === key)));
    const merged = [...joined.flat(), c];
    for (const g of joined) groups.splice(groups.indexOf(g), 1);
    groups.push(merged);
  }
  return groups;
}

/**
 * The next group to review: pull requests whose current commit neither the
 * user nor an earlier run reviewed, out of the wait after the request.
 */
export function nextGroup(candidates: Candidate[], runs: BeeRun[], now: number): Candidate[] | null {
  const done = new Set(runs.flatMap((r) => r.review?.prs ?? []).map(prKey));
  const pending = candidates.filter((c) => c.head !== c.reviewed_head && !done.has(prKey(c)));
  const waiting = (c: Candidate) =>
    !c.reviewed_head && !!c.requested_at && Date.parse(c.requested_at) + REVIEW_DELAY_MS > now;
  return groupCandidates(pending).find((g) => !g.some(waiting)) ?? null;
}

/** Clean pull requests still waiting on the user that moved on or left the list. */
export function staleCleanPrs(runs: BeeRun[], candidates: Candidate[]): Array<{ run: BeeRun; pr: ReviewPr }> {
  return runs.flatMap((run) =>
    (run.review?.prs ?? [])
      .filter((pr) => pr.verdict === "clean" && !pr.decision)
      .filter((pr) => {
        const now = candidates.find((c) => c.repo === pr.repo && c.number === pr.number);
        return !now || now.head !== pr.head;
      })
      .map((pr) => ({ run, pr })),
  );
}

export const toReviewPr = (c: Candidate): ReviewPr => ({
  repo: c.repo,
  number: c.number,
  url: c.url,
  title: c.title,
  branch: c.branch,
  head: c.head,
  reviewedHead: c.reviewed_head,
});

/** The pull requests of a run, one per line, for {{prs}}. */
export function prLines(prs: ReviewPr[], repos: Repo[]): string {
  const clone = (slug: string) => repos.find((r) => r.slug === slug)?.path ?? "(clone não encontrado)";
  return prs
    .map((p) => {
      const round = p.reviewedHead
        ? `\n  Rodada nova: você já revisou até ${p.reviewedHead}. Revise só os commits novos (\`gh api repos/${p.repo}/compare/${p.reviewedHead}...${p.head}\`) e confira, lendo o código atual, se cada ponto da revisão anterior foi resolvido; o que foi resolvido não volta.`
        : "";
      return `- ${p.repo}#${p.number} "${p.title}": branch ${p.branch}, commit ${p.head}, clone em ${clone(p.repo)}${round}`;
    })
    .join("\n");
}
