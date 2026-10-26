import { useEffect, useLayoutEffect, useState } from "react";
import { useStore } from "../lib/store";
import { shortcutLabel } from "../lib/shortcuts";

interface Step {
  /** The panel shown while the step is on screen. */
  panel?: string;
  /** What gets the spotlight. */
  target: string;
  title: string;
  text: string;
}

function steps(layout: string): Step[] {
  return [
    {
      target: ".activity-rail",
      title: "Barra de atividades",
      text: `Cada ícone abre um painel ao lado dos terminais. Arraste os ícones para mudar a ordem. ${shortcutLabel("sidebar")} mostra e esconde o painel.`,
    },
    ...(layout === "sidebar"
      ? [
          {
            panel: "tabs",
            target: ".side-panel",
            title: "Sessões",
            text: "As abas abertas, separadas por grupo. Clique numa aba para trazer o terminal dela.",
          },
        ]
      : []),
    {
      panel: "queue",
      target: ".side-panel",
      title: "Fila",
      text: `Um pedido de permissão ou uma pergunta aparece em cima da aba que pediu, quando ela está na tela. Os pedidos das abas fora da tela esperam aqui. ${shortcutLabel("events")} abre a Fila.`,
    },
    {
      panel: "sessions",
      target: ".side-panel",
      title: "Histórico",
      text: "As sessões anteriores do Claude, para retomar. As fixadas ficam no topo.",
    },
    {
      panel: "bees",
      target: ".side-panel",
      title: "Worker bee",
      text: "Uma worker bee é um prompt pronto que o Shellhive roda sozinho na hora marcada, numa sessão escondida. O resultado de cada execução fica aqui, e o que ela pedir para você aparece em Esperando você.",
    },
    {
      panel: "bees",
      target: ".bee-new",
      title: "Nova worker bee",
      text: "Comece de um template (Review, Limpar worktrees, Resumo do dia), do zero, ou peça para o Claude montar com você. Nos templates, troque cada {{...}} pelo seu conteúdo.",
    },
  ];
}

const BALLOON_WIDTH = 300;
const GAP = 12;

/** Presents the Swarm update: an intro screen, then a spotlight over each part of the layout. */
export function Tour() {
  const open = useStore((s) => s.tourOpen);
  const seen = useStore((s) => s.tourSeen);
  const setOpen = useStore((s) => s.setTourOpen);
  const layout = useStore((s) => s.layout);
  const setPanelTab = useStore((s) => s.setPanelTab);
  const setBeeView = useStore((s) => s.setBeeView);
  // -1 is the intro screen.
  const [index, setIndex] = useState(-1);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const list = steps(layout);
  const step = index >= 0 ? list[index] : null;

  useEffect(() => {
    if (!seen) setOpen(true);
  }, [seen, setOpen]);

  useEffect(() => {
    if (open) setIndex(-1);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  useEffect(() => {
    if (step?.panel) setPanelTab(step.panel);
  }, [step, setPanelTab]);

  // Measured after the panel of the step is on screen, and again when the window changes size.
  useLayoutEffect(() => {
    if (!step) return setRect(null);
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setRect(document.querySelector(step.target)?.getBoundingClientRect() ?? null));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
    };
  }, [step]);

  if (!open) return null;

  if (!step) {
    return (
      <div className="tour-backdrop">
        <div className="tour-intro">
          <img src="/icon.png" alt="" />
          <h2>Shellhive - Swarm update</h2>
          <ul>
            <li>Uma barra de ícones à esquerda troca o painel, e os terminais ganham o resto da tela.</li>
            <li>Pedidos de permissão aparecem em cima da aba que pediu.</li>
            <li>Worker bees: prompts prontos que rodam sozinhos na hora marcada.</li>
          </ul>
          <div className="row">
            <button className="ghost auto" onClick={() => setOpen(false)}>
              Pular
            </button>
            <button className="primary" autoFocus onClick={() => setIndex(0)}>
              Fazer o tour
            </button>
          </div>
        </div>
      </div>
    );
  }

  const last = index === list.length - 1;
  const right = rect ? rect.right + GAP + BALLOON_WIDTH <= window.innerWidth : true;
  const left = rect ? (right ? rect.right + GAP : Math.max(GAP, rect.left - GAP - BALLOON_WIDTH)) : GAP;
  const top = rect ? Math.min(Math.max(GAP, rect.top), window.innerHeight - 220) : GAP;

  return (
    <div className="tour-layer">
      {rect ? (
        <div
          className="tour-spot"
          style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8 }}
        />
      ) : (
        <div className="tour-dim" />
      )}
      <div className="tour-balloon" style={{ left, top, width: BALLOON_WIDTH }}>
        <span className="tour-count">
          {index + 1} de {list.length}
        </span>
        <h3>{step.title}</h3>
        <p>{step.text}</p>
        <div className="row">
          {index > 0 && (
            <button className="ghost auto" onClick={() => setIndex(index - 1)}>
              Voltar
            </button>
          )}
          {last ? (
            <>
              <button className="ghost auto" onClick={() => setOpen(false)}>
                Fechar
              </button>
              <button
                className="primary"
                autoFocus
                onClick={() => {
                  setOpen(false);
                  setBeeView({ mode: "new" });
                }}
              >
                Criar minha primeira worker bee
              </button>
            </>
          ) : (
            <>
              <button className="ghost auto" onClick={() => setOpen(false)}>
                Sair
              </button>
              <button className="primary" autoFocus onClick={() => setIndex(index + 1)}>
                Próximo
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
