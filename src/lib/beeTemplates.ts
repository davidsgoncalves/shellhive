import type { Bee, Repo } from "./types";

/**
 * A ready-made bee: its whole prompt, written out for the user to adapt. Parts
 * in [brackets] are meant to be replaced; {{variables}} are filled by the app
 * on each run.
 */
export interface BeeTemplate {
  id: string;
  name: string;
  description: string;
  /** How it runs: "review" has the app find the pull requests and publish. */
  kind: Bee["template"];
  /** What the bee needs set up, shown when picking it. */
  needs?: string;
  trigger: Bee["trigger"];
  prompt: string;
}

/** Variables every bee's prompt can use. */
export const COMMON_VARIABLES = ["{{repositorios}}", "{{nome}}"];
/** Variables a review bee's prompt must have, filled for each group of pull requests. */
export const REVIEW_VARIABLES = ["{{prs}}", "{{arquivo_achados}}", "{{pasta_worktrees}}"];

/** The starting text of a bee with no template. */
export const BLANK_PROMPT = `Você está rodando como a abelha "{{nome}}" do Worker bee do Shellhive, sem ninguém acompanhando o terminal. Não faça perguntas: quando precisar decidir, escolha o caminho mais seguro e diga no fim o que escolheu.

Repositórios (repositório: pasta do clone):
{{repositorios}}

Tarefa:
[Descreva o que a abelha deve fazer.]

No fim, responda com um resumo curto do que fez e do que ficou pendente.`;

const WORKTREES_PROMPT = `Você está rodando como a abelha "{{nome}}" do Worker bee do Shellhive, sem ninguém acompanhando o terminal. Não faça perguntas.

Tarefa: apagar as worktrees que não servem mais nos repositórios abaixo.

Repositórios (repositório: pasta do clone):
{{repositorios}}

Em cada repositório:
1. Liste as worktrees com \`git -C <pasta> worktree list --porcelain\`. A pasta principal do clone nunca é apagada.
2. Uma worktree só pode ser apagada quando passa em todas estas regras:
   - o PR da branch dela foi mergeado (\`gh pr list -R <repositório> --state merged --head <branch> --json number,mergedAt,headRefOid\`);
   - a branch não tem commit depois do que foi mergeado (o commit atual da worktree é o \`headRefOid\` do PR, ou um ancestral dele);
   - não há alteração sem commit nem arquivo não rastreado (\`git -C <worktree> status --porcelain\` vazio);
   - [Acrescente ou troque regras aqui, por exemplo: só worktrees sem uso há mais de 7 dias.]
3. Apague cada worktree que passou com \`git -C <pasta> worktree remove <worktree>\`, sem --force.
4. [Apague também a branch local da worktree removida com \`git -C <pasta> branch -D <branch>\`, ou tire este passo para manter as branches.]
5. Não apague nada que não passou em todas as regras.

No fim, responda com a lista de worktrees removidas e mantidas, cada uma com o motivo.`;

const REVIEW_PROMPT = `Você está rodando como a abelha de review "{{nome}}" do Worker bee do Shellhive, sem ninguém acompanhando o terminal. Não faça perguntas.

PRs desta revisão, revisados juntos por serem da mesma tarefa:
{{prs}}

Preparação:
- Para cada PR: \`gh pr view <n> -R <repo> --json title,body,author,baseRefName,headRefName,files,commits\`, \`gh pr diff <n> -R <repo>\`, e as revisões e comentários anteriores em \`gh api repos/<repo>/pulls/<n>/reviews\` e \`gh api repos/<repo>/pulls/<n>/comments\`.
- Leia o código numa worktree própria; nunca mude a branch da pasta do clone. Para cada PR: \`git -C <clone> fetch -q origin <branch>\` e \`git -C <clone> worktree add --detach "{{pasta_worktrees}}/<nome-do-repo>-<n>" FETCH_HEAD\`. Ao terminar, remova cada uma com \`git -C <clone> worktree remove --force <worktree>\`.

Método de revisão:
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
- Cada achado vai para o PR cujo código ele trata.
- [Acrescente aqui como você revisa: o que olhar primeiro, o que ignorar, regras do seu projeto.]

Saída:
- Não publique nada no GitHub: nenhum comentário, review ou aprovação. O Shellhive publica a partir do arquivo abaixo.
- Grave os achados em {{arquivo_achados}}, em JSON: {"prs":[{"repo":"dono/nome","number":123,"findings":[{"weight":"bloqueante","path":"app/x.rb","line":42,"body":"bloqueante: ..."}]}]}
- Inclua todos os PRs desta revisão; sem achados, "findings": [].
- "weight" é "bloqueante", "dúvida" ou "sugestão". "line" é a linha no arquivo novo (lado direito do diff), ou null quando o achado não aponta uma linha do diff.
- "body" começa pelo prefixo (bloqueante:, dúvida:, sugestão:; num PR escrito em inglês, blocking:, question:, suggestion:), trata de um problema só, tem até uns 400 caracteres, traz um exemplo concreto (entrada e resultado) e termina com uma linha "Pedido:" dizendo o que o autor deve fazer. Palavras simples, sem elogio nem resumo, sem citar arquivos internos como autoridade.
- Termine com um resumo curto: quantos achados por PR e cada bloqueante em uma linha.`;

export const TEMPLATES: BeeTemplate[] = [
  {
    id: "review",
    name: "Review",
    description:
      "Revisa os PRs que pedem a sua revisão, junta os PRs da mesma tarefa e publica só os problemas. Quando não acha nada, avisa você para aprovar.",
    kind: "review",
    needs: "GitHub (gh)",
    trigger: { kind: "interval", minutes: 15 },
    prompt: REVIEW_PROMPT,
  },
  {
    id: "worktrees",
    name: "Limpar worktrees",
    description: "Apaga as worktrees de branches já mergeadas, sem commit novo e sem alteração pendente.",
    kind: "free",
    needs: "GitHub (gh)",
    trigger: { kind: "schedule", days: [5], time: "18:00" },
    prompt: WORKTREES_PROMPT,
  },
];

/** The prompt of a review bee made before prompts were written out: the template with its notes in place. */
export function reviewPromptOf(bee: Bee): string {
  if (bee.instructions.includes("{{prs}}")) return bee.instructions;
  const notes = bee.instructions.trim();
  return notes
    ? REVIEW_PROMPT.replace(/- \[Acrescente aqui como você revisa[^\n]*/, `- ${notes}`)
    : REVIEW_PROMPT;
}

/** Fills a prompt's {{variables}}; unknown ones are left as written. */
export function fillPrompt(prompt: string, vars: Record<string, string>): string {
  return prompt.replace(/\{\{(\w+)\}\}/g, (all, key: string) => vars[key] ?? all);
}

/** The repositories of a bee, one per line, for {{repositorios}}. */
export function repoLines(bee: Bee, repos: Repo[]): string {
  const mine = repos.filter((r) => bee.repos.includes(r.slug));
  return mine.length ? mine.map((r) => `- ${r.slug}: ${r.path}`).join("\n") : "- (nenhum repositório escolhido)";
}
