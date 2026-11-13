import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { onScreen, useStore } from "../lib/store";
import { describeTool, looksDestructive } from "../lib/describe";
import { describeRule, ruleFor } from "../lib/permRules";
import { isBeeTab, type PermissionDecision, type PermissionRequest, type QuestionItem } from "../lib/types";
import { CommandCard } from "./CommandCard";
import { PluginApprovals, pendingApprovals } from "./PluginApprovals";
import { answerApproval, useFlowApprovals } from "../lib/flows";
import type { FlowNode, FlowRun } from "../lib/types";

/** A flow stopped at an approval: what reached it, and the two ways out. */
export function FlowApprovalCard({ run, node }: { run: FlowRun; node: FlowNode }) {
  const setFlowView = useStore((s) => s.setFlowView);
  const question = node.kind === "approval" && node.question.trim() ? node.question : "Seguir com o fluxo?";
  const input = run.states[node.id]?.output ?? "";
  return (
    <li className="perm-item question">
      <div className="perm-head">
        <span className="perm-tool">Fluxo · {run.flowName}</span>
        <time>{new Date(run.states[node.id]?.startedAt ?? run.startedAt).toLocaleTimeString()}</time>
      </div>
      <p className="question-text">{question}</p>
      {input && <pre className="flow-approval-input">{input.slice(0, 1200)}</pre>}
      <div className="perm-meta">
        <button className="link" onClick={() => setFlowView({ flowId: run.flowId, runId: run.id })}>
          Ver a execução
        </button>
      </div>
      <div className="perm-actions">
        <button className="deny" onClick={() => answerApproval(run.id, node.id, false)}>
          Recusar
        </button>
        <button className="allow" onClick={() => answerApproval(run.id, node.id, true)}>
          Aprovar
        </button>
      </div>
    </li>
  );
}

function Countdown({ req }: { req: PermissionRequest }) {
  const secondsLeft = () =>
    Math.max(0, Math.round((req.received_at + req.expires_in * 1000 - Date.now()) / 1000));
  const [left, setLeft] = useState(secondsLeft);
  useEffect(() => {
    const id = setInterval(() => setLeft(secondsLeft()), 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.received_at, req.expires_in]);
  return (
    <time className={left <= 15 ? "urgent" : ""} title="Depois disso o Claude pergunta no próprio terminal">
      {left}s
    </time>
  );
}

/** What a permission card can do: decide, and allow from now on in the tab's group. */
export function usePermissionActions(req: PermissionRequest) {
  const { tabs, groups, dropPermission, addGroupRule } = useStore();
  const [sent, setSent] = useState<PermissionDecision | null>(null);
  const tab = tabs.find((t) => t.id === req.tab_id);
  const tool = req.payload.tool_name;
  const summary = describeTool(tool, req.payload.tool_input);
  const risky = looksDestructive(tool, req.payload.tool_input);
  const group = groups.find((g) => g.id === tab?.groupId && !g.fixed);
  const rule = ruleFor(req.payload);

  const decide = async (decision: PermissionDecision) => {
    setSent(decision);
    const accepted = await invoke<boolean>("permission_decide", { id: req.id, decision });
    if (!accepted) dropPermission(req.id);
  };
  const always =
    group && rule && !risky
      ? {
          label: `Sempre permitir no grupo ${group.name}${rule.command === null ? ` (qualquer ${rule.tool})` : ""}`,
          title: `Aprova agora e, daqui pra frente, sem perguntar: ${describeRule(rule)}`,
          run: () => {
            addGroupRule(group.id, rule);
            void decide("allow");
          },
        }
      : null;
  return { tab, tool, summary, risky, sent, decide, always };
}

export function PermissionCard({
  req,
  overlay = false,
  onOpen,
}: {
  req: PermissionRequest;
  overlay?: boolean;
  /** Replaces going to the tab, for a tab that is not in the lists. */
  onOpen?: () => void;
}) {
  const activateTab = useStore((s) => s.activateTab);
  const { tab, tool, summary, risky, sent, decide, always } = usePermissionActions(req);

  return (
    <li className={`perm-item ${risky ? "risky" : ""} ${sent ? "sent" : ""} ${overlay ? "overlay" : ""}`}>
      <div className="perm-head">
        <span className="perm-tool">{tool ?? "ferramenta"}</span>
        {risky && <span className="risk-tag" title="Padrão destrutivo detectado">risco</span>}
        <Countdown req={req} />
      </div>
      <code className="perm-cmd" title={summary}>
        {summary}
      </code>
      <div className="perm-meta">
        <button className="link" onClick={() => (onOpen ? onOpen() : tab && activateTab(tab.id))} title="Ir para a aba">
          {tab?.title ?? "aba desconhecida"}
        </button>
        {req.payload.cwd && <span className="muted">{req.payload.cwd.split("/").slice(-2).join("/")}</span>}
      </div>
      <div className="perm-actions">
        <button className="deny" disabled={!!sent} onClick={() => decide("deny")}>
          Negar
        </button>
        <button className="ask" disabled={!!sent} onClick={() => decide("ask")} title="Deixa o Claude perguntar no terminal">
          No terminal
        </button>
        <button
          className="allow"
          disabled={!!sent || risky}
          onClick={() => decide("allow")}
          title={risky ? "Comando destrutivo: decida na própria aba" : undefined}
        >
          Permitir
        </button>
      </div>
      {always && (
        <button className="perm-always" disabled={!!sent} title={always.title} onClick={always.run}>
          {always.label}
        </button>
      )}
    </li>
  );
}

/**
 * A question is shown for context and to jump to its tab. Claude Code draws its
 * own picker in the terminal, so the answer is given there.
 */
export function QuestionCard({ item, onOpen }: { item: QuestionItem; onOpen?: () => void }) {
  const { tabs, activateTab } = useStore();
  const tab = tabs.find((t) => t.id === item.tab_id);
  return (
    <li className="perm-item question">
      <div className="perm-head">
        <span className="perm-tool">{item.questions[0]?.header ?? "Pergunta"}</span>
        <time>{new Date(item.received_at).toLocaleTimeString()}</time>
      </div>
      {item.questions.map((q, i) => (
        <div key={i} className="question-block">
          <p className="question-text">{q.question}</p>
          {q.options && q.options.length > 0 && (
            <ul className="question-options">
              {q.options.map((o, j) => (
                <li key={j} title={o.description}>
                  {o.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      <div className="perm-actions">
        <button className="allow" onClick={() => (onOpen ? onOpen() : tab && activateTab(tab.id))}>
          Responder em {tab?.title ?? "outra aba"}
        </button>
      </div>
    </li>
  );
}

/**
 * What waits in the Fila: requests from tabs off screen. A tab on screen shows
 * its own over its terminal, and a question there is already in the terminal.
 */
export function useQueued() {
  const s = useStore();
  // A bee's requests wait in the Worker bee panel instead.
  const bee = new Set(s.tabs.filter(isBeeTab).map((t) => t.id));
  const away = (tabId: string | null | undefined) => !onScreen(s, tabId) && !bee.has(tabId ?? "");
  return {
    permissions: s.permissions.filter((p) => away(p.tab_id)),
    questions: s.questions.filter((q) => away(q.tab_id)),
    // A bee's command waits here: its tab closes when the run ends.
    commands: s.commands.filter((c) => (c.bee ? !onScreen(s, c.tab_id) : away(c.tab_id))),
    approvals: pendingApprovals(s.localPlugins, s.deferredApprovals).length,
  };
}

export function PermissionQueue() {
  const { permissions, questions, commands, approvals } = useQueued();
  const flowApprovals = useFlowApprovals();
  if (permissions.length === 0 && questions.length === 0 && commands.length === 0 && approvals === 0 && flowApprovals.length === 0) {
    return <p className="hint pad">Nada pendente.</p>;
  }
  return (
    <ul className="perm-list">
      <PluginApprovals />
      {flowApprovals.map(({ run, node }) => (
        <FlowApprovalCard key={`${run.id}:${node.id}`} run={run} node={node} />
      ))}
      {permissions.map((p) => (
        <PermissionCard key={p.id} req={p} />
      ))}
      {questions.map((q) => (
        <QuestionCard key={q.id} item={q} />
      ))}
      {commands.map((c) => (
        <CommandCard key={c.id} item={c} />
      ))}
    </ul>
  );
}
