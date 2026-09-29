// Tool of the example plugin: reads the arguments as JSON from stdin and
// prints the reply as JSON on stdout.
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const { nome } = JSON.parse(input || "{}");
  const mensagem = `Olá, ${nome || "pessoa"}! Rodando em ${process.env.SHELLHIVE_TAB_CWD || "?"}.`;
  console.log(JSON.stringify({ text: mensagem, panel: { mensagem } }));
});
