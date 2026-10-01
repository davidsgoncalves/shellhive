# Plugins do Shellhive

Um plugin acrescenta ferramentas que o agente pode chamar e pedaços de interface:
- um painel abaixo do terminal de uma aba;
- uma aba própria na coluna da direita, visível em qualquer sessão;
- uma vista do tamanho de um terminal, ocupando um espaço da tela dividida;
- uma janela própria;
- um indicador na barra de cima;
- atalhos de teclado;
- etiquetas embaixo do nome das abas;
- itens no menu de clique direito das abas;
- notificações do sistema;
- ferramentas que rodam sozinhas de tempos em tempos. Cada plugin é uma pasta dentro desta pasta (`plugins/`), com um `plugin.json`. A pasta `_exemplo/` tem um plugin completo para copiar.

## Criar um plugin

1. Crie `plugins/<id>/`. O `id` usa só letras minúsculas, números e hífen, e não pode começar com `_`.
2. Escreva `plugins/<id>/plugin.json` e os programas das ferramentas.
3. O Shellhive encontra a pasta em poucos segundos e mostra ao usuário um cartão de aprovação com as ferramentas, os programas e as permissões. Nada roda antes da aprovação.
4. Depois de aprovado, o usuário liga o plugin em Configurações > Plugins. As ferramentas aparecem nas sessões abertas depois disso.

Qualquer alteração em um arquivo da pasta pede aprovação de novo. Se o plugin tiver erro, ele aparece em Configurações > Plugins com a mensagem do problema.

## plugin.json

```json
{
  "id": "deploy",
  "name": "Status do deploy",
  "description": "Uma frase para o usuário sobre o que o plugin faz.",
  "agentContext": "Uma frase para o agente, dita no início de cada sessão com o plugin ligado.",
  "tools": [
    {
      "name": "deploy_status",
      "description": "O que a ferramenta faz, para o agente decidir quando usar.",
      "inputSchema": {
        "type": "object",
        "properties": { "app": { "type": "string" } },
        "required": ["app"]
      },
      "run": ["node", "status.js"]
    }
  ],
  "panel": { "entry": "panel.html", "title": "Deploy" },
  "sidePanel": { "entry": "side.html", "title": "Deploy" },
  "menu": [{ "label": "Ver status do deploy", "tool": "deploy_status" }],
  "schedule": [{ "tool": "deploy_status", "every": 60 }],
  "view": { "entry": "view.html", "title": "Deploy" },
  "window": { "entry": "window.html", "title": "Deploy", "width": 720, "height": 520 },
  "shortcuts": [{ "key": "KeyD", "open": "side" }, { "key": "KeyS", "tool": "deploy_status" }],
  "permissions": ["tab", "tools", "prompt", "storage", "events", "badge", "notify", "status"]
}
```

- `id`: igual ao nome da pasta.
- `name`: obrigatório.
- `description` e `agentContext`: opcionais.
- `tools`: opcional. Cada ferramenta precisa de `name`, que começa com `<id>_`, de `description` e de `run`. O `inputSchema` é JSON Schema; sem ele, a ferramenta aceita qualquer objeto.
- `panel`: opcional. Painel abaixo do terminal da aba.
- `sidePanel`: opcional. Aba do plugin na coluna da direita, ao lado de Fila e Histórico; trabalha sobre a aba ativa.
- `menu`: opcional. Itens no menu de clique direito das abas; cada um chama uma ferramenta do próprio plugin, com `{ "tab": { … } }` como argumentos.
- `view`: opcional. Vista que ocupa um espaço inteiro da tela dividida, no lugar de um terminal; trabalha sobre a aba ativa.
- `window`: opcional. Janela própria do plugin, com `width` e `height` em pixels.
- `shortcuts`: opcional. Cada atalho é `key` (`KeyA` a `KeyZ` ou `Digit0` a `Digit9`) mais `tool` (roda essa ferramenta com `{ "tab": { … } }`) ou `open` (`panel`, `side`, `view` ou `window`). No macOS a combinação é ⌘⌥ + tecla; no Linux e no Windows, Ctrl+Alt+Shift + tecla.
- `schedule`: opcional. Ferramentas que o app roda sozinho enquanto o plugin está ligado, a cada `every` segundos (mínimo 15), com `{ "tabs": [ … ] }` como argumentos.
- `permissions`: opcional. Vale para os painéis; `events` também libera os eventos para os programas, e `badge` e `notify` também valem para as respostas das ferramentas.
- Um plugin precisa de ao menos uma ferramenta ou um painel.

## Ferramentas

`run` é a linha de comando em lista, sem shell: `["node", "status.js"]`, `["python3", "main.py"]`, `["./tool.sh"]`. O programa roda na pasta do plugin e recebe:

- **stdin:** os argumentos da chamada, em JSON.
- **Variáveis de ambiente:**
  - `SHELLHIVE_PLUGIN_DIR`: a pasta do plugin.
  - `SHELLHIVE_TAB_ID`: a aba que chamou.
  - `SHELLHIVE_TAB_CWD`: a pasta em que a aba foi aberta.
  - `SHELLHIVE_EVENTS_FILE`: só com a permissão `events`. Arquivo JSON com a lista de eventos recentes (veja Eventos do agente).

A resposta sai no stdout, de uma de duas formas:

- **Texto puro:** volta para o agente como está.
- **Um objeto JSON com `text`:** também pode ter:
  - `isError` (booleano);
  - `panel`: abre o painel na aba que chamou, com esse valor em `shellhive.onData`;
  - `badge`: texto da etiqueta da aba que chamou, ou `null` para tirar (permissão `badge`);
  - `badges`: objeto `{ "<id da aba>": "texto" | null }`, para várias abas de uma vez, útil numa rotina (permissão `badge`);
  - `notify`: `{ "title": "…", "body": "…" }`, uma notificação do sistema (permissão `notify`);
  - `status`: texto do indicador do plugin na barra de cima, ou `{ "text": "…", "title": "dica" }`, ou `null` para tirar (permissão `status`). Clicar no indicador abre a aba lateral, a vista ou a janela do plugin, nessa ordem de preferência;
  - `view`: abre a vista com esse valor em `shellhive.onData`;
  - `window`: abre a janela com esse valor em `shellhive.onData`.

Cada aba chega como `{ id, title, cwd, sessionId, group, state }`. O `sessionId` é a sessão do agente; ele continua o mesmo quando a sessão é fechada e reaberta, então serve para ligar dados a uma sessão (o `id` da aba muda ao reabrir).

Saída de erro com código diferente de zero vira erro para o agente. Uma chamada tem até 60 segundos, e a saída acima de 256 KB é cortada.

## Painel

- **Formato:** um único arquivo HTML, com CSS e JS embutidos. Arquivos externos e rede estão bloqueados.
- **Isolamento:** o painel roda num quadro isolado e fala com o Shellhive pelo objeto `shellhive`, com as funções liberadas em `permissions`.
- **Tema:** as variáveis de CSS do tema estão disponíveis: `--bg`, `--panel`, `--panel-2`, `--border`, `--fg`, `--muted`, `--accent`, `--danger`, `--success`, `--font-ui`, `--font-mono`.

| Função | Permissão | O que faz |
| --- | --- | --- |
| `shellhive.onData(fn)` | nenhuma | Recebe o `panel` enviado por uma ferramenta; também é chamada com `null` quando o usuário abre o painel pelo menu da aba |
| `shellhive.close()` | nenhuma | Fecha o painel |
| `shellhive.tab()` | `tab` | Devolve a aba do painel; na aba lateral, a aba ativa |
| `shellhive.onTab(fn)` | nenhuma | Chama `fn` com a aba quando ela muda; na aba lateral, a cada troca de aba |
| `shellhive.tabs()` | `tab` | Devolve todas as abas |
| `shellhive.setBadge(texto, idDaAba)` | `badge` | Põe ou tira (`null`) a etiqueta do plugin numa aba; sem id, na aba do painel |
| `shellhive.notify(título, texto)` | `notify` | Mostra uma notificação do sistema |
| `shellhive.setStatus(texto, dica)` | `status` | Põe ou tira (`null`) o indicador do plugin na barra de cima |
| `shellhive.open(lugar, dados)` | nenhuma | Abre `panel`, `side`, `view` ou `window` do plugin, com `dados` em `onData` |
| `shellhive.tool(nome, args)` | `tools` | Chama uma ferramenta do próprio plugin e devolve `{ text, isError }` |
| `shellhive.prompt(texto, { submit })` | `prompt` | Escreve no prompt do agente da aba; envia só com `submit: true` |
| `shellhive.storage.get()` / `.set(valor)` | `storage` | Guarda um valor JSON do plugin, até 256 KB |
| `shellhive.events()` | `events` | Devolve os eventos recentes do agente em todas as abas, do mais antigo ao mais novo |
| `shellhive.onEvent(fn)` | `events` | Chama `fn` com cada evento novo, de qualquer aba, enquanto o painel está aberto |

Todas devolvem Promise. O usuário também abre o painel pelo menu de clique direito da aba, em "Abrir painel". A aba lateral, a vista e a janela usam o mesmo formato de arquivo e as mesmas funções. Na janela própria, `tab()` e `prompt()` não têm aba para trabalhar: use a vista ou a aba lateral quando precisar delas.

## Eventos do agente

Com a permissão `events`, o plugin vê o que o agente faz em cada aba. O Shellhive guarda os 2000 eventos mais recentes, de todas as abas, desde que o app abriu. Cada evento é um objeto:

```json
{
  "type": "tool",
  "tabId": "a1b2…",
  "at": 1790690000000,
  "cwd": "/Users/voce/projects/api/.worktrees/feat-x",
  "tool": "Edit",
  "action": "edit",
  "paths": ["/Users/voce/projects/api/.worktrees/feat-x/src/app.ts"],
  "command": "git status"
}
```

- `type`: `tool` (o agente usou uma ferramenta), `turn-start` (o usuário mandou uma mensagem) ou `turn-end` (o agente terminou de responder).
- `at`: milissegundos desde 1970.
- `cwd`: a pasta em que o agente estava.
- `tool`, `action`, `paths` e `command`: só em `tool`.
  - `action` é `edit` (Edit, Write, MultiEdit, NotebookEdit), `read` (Read, Grep, Glob), `command` (Bash) ou `other`.
  - `paths` traz caminhos absolutos dos arquivos tocados; pode vir vazio.
  - `command` só aparece em comandos.

Para saber em quais repositórios e worktrees o agente está mexendo, junte os `paths` e os `cwd` dos eventos de uma aba e rode `git -C <pasta> rev-parse --show-toplevel` em cada um.

## Testar

- Rode o programa direto no terminal: `echo '{"app":"api"}' | node status.js`.
- Confira em Configurações > Plugins se o plugin aparece sem erro.
- Peça ao usuário para aprovar e ligar, e abra uma sessão nova para usar as ferramentas.
