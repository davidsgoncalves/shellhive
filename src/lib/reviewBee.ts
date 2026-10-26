import type { Bee, BeeRun, Repo, ReviewPr } from "./types";

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

const METHOD = `Método de revisão:
- Reconstrua a tarefa inteira: o que foi pedido (objetivo, escopo, critérios) e os PRs irmãos desta lista. Compare entre repositórios contra as branches dos irmãos, nunca contra a base.
- Avalie o nível pelo estrago se quebrar, não pelo tamanho. Na dúvida, o nível mais alto. Baixo: pedido e regras exatas. Médio: também consumidores, fonte única e jornada. Alto: tudo, lendo código fora do diff.
- Pedido: liste as mudanças de comportamento e compare com o objetivo. Mudança relacionada não gera comentário; arriscada bloqueia; sem relação vira pergunta; contradição sem decisão registrada bloqueia.
- Quem consome: ache todo leitor e todo outro escritor do que mudou, e outros caminhos que produzem o mesmo efeito (callbacks, webhooks, atualizações em massa). Consumidor quebrado ou caminho esquecido bloqueia.
- Fonte única: cada fato tem um dono. Constante ou data duplicada, valor diferente entre repositórios, valor fixo no código em vez de lido da fonte, dois mecanismos para o mesmo cálculo, ou validação de entrada diferente da execução bloqueiam.
- Estado final na falha: para cada efeito, e se falhar, atrasar, rodar duas vezes, fora de ordem ou sem o outro? Não pode perder dinheiro ou dado, esconder a falha nem derrubar um processo inteiro por uma entrada.
- Jornada no tempo: o usuário repete, renova, edita, volta. Mensagem duplicada? Dado alterado relido? Caso não previsto vira pergunta.
- Nomes dizem a verdade: nome que não bate com o comportamento ou com o vocabulário do produto bloqueia.
- Implementação paralela de algo que já existe, ou bloco copiado dentro do PR, bloqueia. Duplicação anterior ao PR não é culpa do autor.
- Testes cobrem as bordas que o PR cria. Mockar o caminho com bug não conta. Falta de teste de borda é sugestão.
- Todo bug afirmado precisa de evidência verificada (código lido, comando rodado, busca feita). O que não foi verificado vira pergunta, nunca bloqueio.
- Verifique em degraus: ler código, trecho isolado, testes do projeto. Suba só por suspeita plausível e de impacto, e pare quando confirmar ou descartar. Não suba servidores: o que só se confirmaria com o ambiente no ar vira dúvida.
- Antes de chamar algo de padrão ruim, confira se já é convenção do projeto. Fora do escopo: ordem de deploy, trabalho fora do código, dívida anterior ao PR, formatação de linter, especulação de custo.
- Cada achado vai para o PR cujo código ele trata.`;

/** The prompt a review run starts with. */
export function reviewPrompt(bee: Bee, prs: ReviewPr[], repos: Repo[], findingsPath: string, worktrees: string): string {
  const clone = (slug: string) => repos.find((r) => r.slug === slug)?.path ?? "(clone não encontrado)";
  const list = prs
    .map((p) => {
      const round = p.reviewedHead
        ? `\n  Rodada nova: você já revisou até ${p.reviewedHead}. Revise só os commits novos (\`gh api repos/${p.repo}/compare/${p.reviewedHead}...${p.head}\`) e confira, lendo o código atual, se cada ponto da revisão anterior foi resolvido; o que foi resolvido não volta.`
        : "";
      return `- ${p.repo}#${p.number} "${p.title}": branch ${p.branch}, commit ${p.head}, clone em ${clone(p.repo)}${round}`;
    })
    .join("\n");
  const own = bee.instructions.trim() ? `\n\nInstruções de quem revisa (valem acima do método):\n${bee.instructions.trim()}` : "";
  return `Você está rodando como a abelha de review "${bee.name}" do Worker bee do Shellhive, sem ninguém acompanhando o terminal. Não faça perguntas.

PRs desta revisão, revisados juntos por serem da mesma tarefa:
${list}

Preparação:
- Para cada PR: \`gh pr view <n> -R <repo> --json title,body,author,baseRefName,headRefName,files,commits\`, \`gh pr diff <n> -R <repo>\`, e as revisões e comentários anteriores em \`gh api repos/<repo>/pulls/<n>/reviews\` e \`gh api repos/<repo>/pulls/<n>/comments\`.
- Leia o código numa worktree própria; nunca mude a branch da pasta do clone. Para cada PR: \`git -C <clone> fetch -q origin <branch>\` e \`git -C <clone> worktree add --detach ${worktrees}/<nome-do-repo>-<n> FETCH_HEAD\`. Ao terminar, remova cada uma com \`git -C <clone> worktree remove --force <worktree>\`.

${METHOD}${own}

Saída:
- Não publique nada no GitHub: nenhum comentário, review ou aprovação. O Shellhive publica a partir do arquivo abaixo.
- Grave os achados em ${findingsPath}, em JSON: {"prs":[{"repo":"dono/nome","number":123,"findings":[{"weight":"bloqueante","path":"app/x.rb","line":42,"body":"bloqueante: ..."}]}]}
- Inclua todos os PRs desta revisão; sem achados, "findings": [].
- "weight" é "bloqueante", "dúvida" ou "sugestão". "line" é a linha no arquivo novo (lado direito do diff), ou null quando o achado não aponta uma linha do diff.
- "body" começa pelo prefixo (bloqueante:, dúvida:, sugestão:; num PR escrito em inglês, blocking:, question:, suggestion:), trata de um problema só, tem até uns 400 caracteres, traz um exemplo concreto (entrada e resultado) e termina com uma linha "Pedido:" dizendo o que o autor deve fazer. Palavras simples, sem elogio nem resumo, sem citar arquivos internos como autoridade.
- Termine com um resumo curto: quantos achados por PR e cada bloqueante em uma linha.`;
}
