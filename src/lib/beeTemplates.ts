import type { Bee } from "./types";

/**
 * A ready-made bee: its whole prompt, written out. The user replaces each
 * {{...}} with their own content; nothing else is filled in by the app.
 */
export interface BeeTemplate {
  id: string;
  name: string;
  description: string;
  /** What the bee needs set up, shown when picking it. */
  needs?: string;
  trigger: Bee["trigger"];
  prompt: string;
}

/** A {{...}} part still waiting for the user's content. */
export const PLACEHOLDER = /\{\{[^}\n]+\}\}/;

/** The starting text of a bee with no template. */
export const BLANK_PROMPT = `Você está rodando como uma abelha do Worker bee do Shellhive, sem ninguém acompanhando o terminal. Não faça perguntas: quando precisar decidir, escolha o caminho mais seguro e diga no fim o que escolheu.

Tarefa:
{{Descreva o que a abelha deve fazer, em quais repositórios e pastas.}}

No fim, responda com um resumo curto do que fez e do que ficou pendente.`;

const WORKTREES_PROMPT = `Você está rodando como uma abelha do Worker bee do Shellhive, sem ninguém acompanhando o terminal. Não faça perguntas.

Tarefa: apagar as worktrees que não servem mais.

Clones onde procurar worktrees:
{{Liste as pastas dos seus clones, uma por linha. Ex.: ~/projects/meu-app}}

Em cada clone:
1. Liste as worktrees com \`git -C <clone> worktree list --porcelain\`. A pasta principal do clone nunca é apagada.
2. Uma worktree só pode ser apagada quando passa em todas estas regras:
   - o PR da branch dela foi mergeado (\`gh pr list --state merged --head <branch> --json number,mergedAt,headRefOid\`, rodado dentro do clone);
   - a branch não tem commit depois do que foi mergeado (o commit atual da worktree é o \`headRefOid\` do PR, ou um ancestral dele);
   - não há alteração sem commit nem arquivo não rastreado (\`git -C <worktree> status --porcelain\` vazio);
   - {{Acrescente outras regras, ou apague esta linha. Ex.: só worktrees sem uso há mais de 7 dias.}}
3. Apague cada worktree que passou com \`git -C <clone> worktree remove <worktree>\`, sem --force.
4. {{Diga se a branch local também deve ser apagada com \`git -C <clone> branch -D <branch>\`, ou apague esta linha para manter as branches.}}
5. Não apague nada que não passou em todas as regras.

No fim, responda com a lista de worktrees removidas e mantidas, cada uma com o motivo.`;

const REVIEW_PROMPT = `Você está rodando como uma abelha de review do Worker bee do Shellhive, sem ninguém acompanhando o terminal. Não faça perguntas.

Repositórios a revisar e a pasta do clone de cada um:
{{Liste um por linha, no formato dono/repositório: pasta do clone. Ex.: acme/api: ~/projects/api}}

1. Ache os PRs abertos que pedem a minha revisão nesses repositórios: \`gh search prs --review-requested=@me --state=open --json number,title,url,isDraft,repository\`. Ignore rascunhos e PRs de outros repositórios.
2. Pule o PR quando:
   - o pedido de revisão tem menos de 15 minutos (veja o último ReviewRequestedEvent no timeline do PR), para dar tempo de os PRs relacionados chegarem;
   - a minha última revisão (não descartada) já é do commit atual do PR, comparando o \`commit_id\` dela em \`gh api repos/<repo>/pulls/<n>/reviews\` com o \`headRefOid\` do PR.
3. Junte os PRs da mesma tarefa: mesmo nome de branch, ou a mesma chave de tarefa (como ABC-123) no título ou na branch. Revise cada grupo de uma vez.
4. Se eu já revisei o PR antes, revise só os commits novos (\`gh api repos/<repo>/compare/<commit revisado>...<commit atual>\`) e confira, lendo o código atual, se cada ponto da revisão anterior foi resolvido; o que foi resolvido não volta.
5. Leia o código numa worktree própria, nunca mudando a branch da pasta do clone: \`git -C <clone> fetch -q origin <branch>\` e \`git -C <clone> worktree add --detach "$TMPDIR/shellhive-review/<repositório>-<n>" FETCH_HEAD\`. No fim, remova cada uma com \`git -C <clone> worktree remove --force <worktree>\`.

Como revisar:
- Reconstrua a tarefa inteira: o que foi pedido (objetivo, escopo, critérios) e os PRs irmãos. Compare entre repositórios contra as branches dos irmãos, nunca contra a base.
- Avalie o nível pelo estrago se quebrar, não pelo tamanho. Na dúvida, o nível mais alto.
- Pedido: compare as mudanças de comportamento com o objetivo. Mudança arriscada bloqueia; sem relação vira pergunta.
- Quem consome: ache todo leitor e todo outro escritor do que mudou. Consumidor quebrado ou caminho esquecido bloqueia.
- Fonte única: valor duplicado, fixo no código em vez de lido da fonte, ou diferente entre repositórios bloqueia.
- Estado final na falha: e se falhar, atrasar, rodar duas vezes ou fora de ordem? Não pode perder dado nem esconder a falha.
- Nomes que não batem com o comportamento bloqueiam. Implementação paralela de algo que já existe bloqueia.
- Testes cobrem as bordas que o PR cria; falta de teste de borda é sugestão.
- Todo bug afirmado precisa de evidência verificada (código lido, comando rodado). O que não foi verificado vira pergunta. Não suba servidores.
- {{Como você revisa: o que olhar primeiro, o que ignorar, regras do seu projeto. Ou apague esta linha.}}

Como publicar:
- Cada achado vira um comentário na linha do código: \`gh api repos/<repo>/pulls/<n>/comments -f body=... -f commit_id=<commit atual> -f path=<arquivo> -F line=<linha> -f side=RIGHT\`. Achado sem linha no diff vira comentário no PR: \`gh api repos/<repo>/issues/<n>/comments -f body=...\`.
- O comentário começa com bloqueante:, dúvida: ou sugestão:, trata de um problema só, tem até uns 400 caracteres, traz um exemplo concreto e termina com uma linha "Pedido:" dizendo o que o autor deve fazer.
- Depois dos comentários, envie a revisão: \`gh api repos/<repo>/pulls/<n>/reviews -f event=REQUEST_CHANGES -f commit_id=<commit atual> -f body=...\` quando houver algum bloqueante, ou \`event=COMMENT\` quando só houver dúvidas e sugestões.
- Sem nenhum achado, não publique nada no PR.
- Nunca aprove um PR (nunca use event=APPROVE).

No fim, responda com um resumo: para cada PR, quantos achados e cada bloqueante em uma linha; e a lista dos PRs sem achados, com o link, dizendo que falta eu aprovar.`;

export const TEMPLATES: BeeTemplate[] = [
  {
    id: "review",
    name: "Review",
    description:
      "Revisa os PRs que pedem a sua revisão, junta os PRs da mesma tarefa e publica só os problemas. Os PRs sem problema ficam para você aprovar.",
    needs: "GitHub (gh)",
    trigger: { kind: "interval", minutes: 15 },
    prompt: REVIEW_PROMPT,
  },
  {
    id: "worktrees",
    name: "Limpar worktrees",
    description: "Apaga as worktrees de branches já mergeadas, sem commit novo e sem alteração pendente.",
    needs: "GitHub (gh)",
    trigger: { kind: "schedule", days: [5], time: "18:00" },
    prompt: WORKTREES_PROMPT,
  },
];
