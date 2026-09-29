# Shellhive

Antes chamado Claude Terminal.

Terminal com abas agrupadas por assunto, feito para quem roda várias sessões do
Claude Code ao mesmo tempo. Cada aba mostra em que estado está a sessão, os
pedidos de permissão de todas elas caem numa fila única, e o histórico de
sessões antigas é pesquisável por conteúdo.

Funciona no macOS e no Linux. É um app Tauri com xterm.js sobre o seu próprio
shell, então `.zshrc`, aliases e tudo mais continuam valendo.

## O que ele faz

- **Estado por sessão.** A bolinha de cada aba diz se o Claude está
  trabalhando, esperando permissão, esperando você ou parado.
- **Fila de permissões.** Todo pedido de permissão de todas as abas aparece num
  painel único, com o comando completo. Você responde ali, sem trocar de aba.
  Comandos com padrão destrutivo ficam marcados e exigem decisão na própria aba.
- **Grupos de abas.** Nome, cor e pasta base por grupo, no estilo dos grupos de
  aba do Chrome. A lista fica na lateral ou numa barra superior, à sua escolha.
- **Telas divididas.** Até quatro terminais ao mesmo tempo, em cinco arranjos.
  Botão direito em qualquer terminal escolhe o painel pelo número.
- **Histórico.** Lista com título, pasta e branch, busca no conteúdo
  completo das conversas e retomada com um clique. Fixe as que você usa sempre.
- **Plugins oficiais.** Recursos extras que vêm com o app e se ligam em
  Configurações > Plugins. Todos começam desligados. O primeiro é o **Editor em painel**: o Claude abre um
  editor embaixo do terminal para você preencher ou revisar algo, em texto,
  planilha, JSON ou XML, e recebe de volta o que você escreveu. O segundo é
  **Diagramas Mermaid**: fluxogramas, sequências e modelos de dados num painel
  abaixo do terminal, que dá para copiar como imagem ou salvar em SVG.
- **Limites de uso.** Consumo das janelas de 5 horas e 7 dias no topo, contexto
  e custo por aba.
- **Avisos do sistema.** Notificação quando uma sessão termina ou pede
  permissão com a janela fora de foco, e alerta para sessão parada esperando
  você há muito tempo.

## Instalação

Baixe o instalador da [última release](../../releases/latest):

| Sistema | Arquivo |
| --- | --- |
| macOS Apple Silicon (M1 ou mais novo) | `macOS-Apple-Silicon.dmg` |
| macOS Intel | `macOS-Intel.dmg` |
| Linux | `Linux.AppImage` |
| Debian ou Ubuntu | `Linux-Debian-Ubuntu.deb` |
| Windows 10 ou 11 | `Windows.exe` |

O app verifica atualizações ao abrir e a cada seis horas. No macOS e no
AppImage ele instala sozinho depois da sua confirmação. Instalado pelo `.deb`,
ele baixa o pacote novo e entrega ao instalador do sistema, que pede sua senha.

Quem instalou o Claude Terminal pelo `.deb` até a versão 0.1.12 precisa baixar e
instalar o `.deb` do Shellhive uma vez à mão, porque essas versões não
conseguiam buscar atualizações. O pacote novo substitui o antigo sozinho, e
daí em diante as atualizações chegam pelo app.

O build não é assinado por uma conta de desenvolvedor da Apple, então o macOS
marca o download com o atributo de quarentena. Se o sistema disser que o app
está danificado, remova a marca e abra normalmente:

```bash
xattr -dr com.apple.quarantine "/Applications/Shellhive.app"
```

### Windows

O instalador `Windows.exe` ainda não foi usado a fundo numa máquina real; os
erros que aparecerem chegam pelos relatórios de erro, para quem aceitar o
envio. As abas abrem no PowerShell, e os hooks do Claude Code rodam pelo próprio
executável do app em vez de scripts de shell. O instalador não é assinado, então
o Windows mostra o aviso do SmartScreen: clique em "Mais informações" e em
"Executar assim mesmo". O app se atualiza sozinho como no macOS.

### Windows com WSL

O Shellhive roda dentro do WSL como um app Linux, com a janela aberta pelo
próprio Windows. O Claude Code, as abas e as sessões ficam todos dentro da
distribuição Linux.

Requisitos: Windows 11, ou Windows 10 21H2 ou mais novo, com o WSL instalado
pela Microsoft Store (`wsl --update`). As janelas gráficas do Linux já vêm
ligadas nessas versões.

Dentro do Ubuntu do WSL, instale o `.deb`:

```bash
sudo apt install ./Shellhive_<versão>_Linux-Debian-Ubuntu.deb
shellhive &
```

O app também aparece no menu Iniciar do Windows como Shellhive, junto dos
outros apps do WSL.

- **Atualizações:** o app avisa quando há versão nova e baixa o pacote, mas o
  WSL não tem a janela de senha do sistema. A mensagem de erro traz o comando
  `sudo apt install` com o caminho do pacote baixado, para rodar numa aba.
- **Links:** ⌘-clique vira Ctrl-clique, e links e arquivos abrem no Windows,
  pelo `wslview` quando instalado (`sudo apt install wslu`) ou pelo Explorer.
- **AppImage:** também funciona, mas precisa de `sudo apt install libfuse2`
  (Ubuntu 22.04) ou `libfuse2t64` (Ubuntu 24.04).

## Como ele conversa com o Claude Code

Nada do seu `~/.claude/settings.json` é alterado. O app escreve os próprios
arquivos em `~/Library/Application Support/shellhive` (ou
`~/.config/shellhive` no Linux) e coloca um atalho `claude` no PATH de
cada aba, além de definir uma função de shell com o mesmo nome. Qualquer
`claude` digitado numa aba passa por ele e ganha:

- `--settings` com os hooks que alimentam o estado das abas, a fila de
  permissões e a barra de limites;
- `--mcp-config` com o servidor MCP do próprio app;
- uma statusline que espelha os dados para o app e delega para a que você já
  usava.

Sessões abertas fora do app não são afetadas.

### Seus próprios plugins

Peça ao Claude algo como "cria um plugin do Shellhive que mostra o status do
deploy". Ele lê o guia que o app mantém em `plugins/GUIDE.md`, dentro da pasta
de dados, e escreve a pasta do plugin ao lado. Em poucos segundos o plugin
aparece na Fila para você aprovar, com os programas que vai rodar e as
permissões do painel; depois de aprovado, ele liga em Configurações > Plugins.
Qualquer mudança nos arquivos pede aprovação de novo.

- As ferramentas são programas da pasta do plugin (`node`, `python3`, um
  script), que recebem os argumentos em JSON e respondem pela saída padrão.
- O painel é um arquivo HTML que abre abaixo do terminal, isolado do app, sem
  rede, e conversa com o Shellhive só pelas funções que o plugin declarou.
- A pasta `plugins/_exemplo/` tem um plugin completo para servir de modelo.

### Ferramentas que o Claude ganha

| Ferramenta | Para quê |
| --- | --- |
| `open_editor` | Do plugin Editor em painel. Abre o editor e devolve o texto final. Salva o arquivo quando recebe um caminho. Detecta planilha, JSON e XML pela extensão |
| `show_diagram` | Do plugin Diagramas Mermaid. Mostra um diagrama Mermaid no painel abaixo do terminal; um erro de sintaxe volta para o Claude corrigir |
| `list_sessions` | Lista as sessões gravadas na máquina, com título e pasta |
| `suggest_command` | Mostra um comando de shell como botão na fila. Ao clicar em Executar, ele roda na sessão como `! comando` |

No início de cada sessão o Claude recebe um contexto dizendo que está rodando
aqui dentro, mais uma frase de cada plugin ligado; com o Editor em painel, que
deve usá-lo no lugar de pedir um editor externo.

## Atalhos

| Ação | macOS | Linux |
| --- | --- | --- |
| Nova sessão | `⌘T` | `Ctrl+Shift+T` |
| Fechar aba | `⌘W` | `Ctrl+Shift+W` |
| Reabrir a última aba fechada | `⌘⇧T` | `Ctrl+Shift+R` |
| Trocar de aba | `⌘1` a `⌘9` | `Alt+1` a `Alt+9` |
| Aba anterior e próxima | `⌘⇧[` e `⌘⇧]` | `Ctrl+PgUp` e `Ctrl+PgDn` |
| Buscar abas | `⌘P` | `Ctrl+Shift+P` |
| Buscar no terminal | `⌘F` | `Ctrl+Shift+F` |
| Abrir link ou arquivo | `⌘`-clique | `Ctrl`-clique |
| Mostrar ou esconder a lista de sessões | `⌘B` | `Ctrl+Shift+B` |
| Mostrar ou esconder o painel da direita | `⌘E` | `Ctrl+Shift+E` |
| Limpar a tela do terminal | `⌘K` | `Ctrl+Shift+K` |
| Configurações | `⌘,` | `Ctrl+Shift+,` |
| Mini painel flutuante | `⌘⇧M` | `Ctrl+Shift+M` |

## Relatórios de erro

O app guarda os próprios erros em `errors.log`, na pasta de dados. Em
**Configurações → Sobre**, "Relatar problema" abre uma issue neste repositório
já preenchida com a versão, o sistema e as últimas linhas desse registro.

Com o envio ligado (o app pergunta uma vez, e a opção fica no Sobre), os mesmos
erros vão para o Sentry. Nada do que é digitado ou exibido no terminal é
enviado. Antes de sair da máquina, o texto perde o caminho da pasta pessoal, o
nome de usuário e qualquer sequência parecida com um token. O envio só existe
nos builds que carregam o DSN do projeto, passado pelo secret
`SHELLHIVE_SENTRY_DSN` do repositório.

## Onde ficam os dados

Tudo em `~/Library/Application Support/shellhive` no macOS, ou
`~/.config/shellhive` no Linux (`%APPDATA%\shellhive` no Windows). Na primeira
abertura depois da troca de nome, o app copia a pasta `claude-terminal` das
versões antigas para lá e deixa a original como backup; "Importar de novo do
Claude Terminal", no Sobre, refaz essa cópia:

| Arquivo | Conteúdo |
| --- | --- |
| `data.db` | SQLite com o layout, os eventos de hook, as métricas de permissão e o índice de busca |
| `errors.log` | Os erros do app, já sem caminhos pessoais nem tokens |
| `error-reports.json` | Se o envio de relatórios de erro está ligado |
| `hooks.json` | Configuração passada ao Claude Code via `--settings` |
| `mcp.json` | Registro do servidor MCP |
| `bin/claude` | Atalho que injeta as configurações |
| `forward.sh`, `permission.sh`, `statusline.sh`, `session_start.sh` | Scripts chamados pelos hooks |

Os transcripts continuam onde o Claude Code os grava, em `~/.claude/projects`.
O banco guarda só o índice.

## Desenvolvimento

Requer Node 22, pnpm e Rust estável.

```bash
pnpm install
pnpm tauri dev
```

Verificações que o CI roda:

```bash
pnpm exec tsc --noEmit
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

### Publicar uma versão

O workflow `release` roda a cada push em `main` e só publica quando a versão de
`src-tauri/tauri.conf.json` ainda não tem tag. Compila macOS `aarch64` e `x64`
e Linux `x64`, assina os pacotes, cria a tag e publica a release com o
`latest.json` que o auto-update consome.

```bash
pnpm bump          # patch; aceita minor ou major
git commit -am "..." && git push
```

Os segredos `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
precisam existir no repositório para a assinatura funcionar.

## Licença

MIT.
