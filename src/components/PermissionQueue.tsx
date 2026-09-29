import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../lib/store";
import { describeTool, looksDestructive } from "../lib/describe";
import { describeRule, ruleFor } from "../lib/permRules";
import type { PermissionDecision, PermissionRequest, QuestionItem } from "../lib/types";
import { CommandCard } from "./CommandCard";
import { PluginApprovals, pendingApprovals } from "./PluginApprovals";

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

function Item({ req }: { req: PermissionRequest }) {
  const { tabs, groups, activateTab, dropPermission, addGroupRule } = useStore();
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

  return (
    <li className={`perm-item ${risky ? "risky" : ""} ${sent ? "sent" : ""}`}>
      <div className="perm-head">
        <span className="perm-tool">{tool ?? "ferramenta"}</span>
        {risky && <span className="risk-tag" title="Padrão destrutivo detectado">risco</span>}
        <Countdown req={req} />
      </div>
      <code className="perm-cmd" title={summary}>
        {summary}
      </code>
      <div className="perm-meta">
        <button className="link" onClick={() => tab && activateTab(tab.id)} title="Ir para a aba">
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
      {group && rule && !risky && (
        <button
          className="perm-always"
          disabled={!!sent}
          title={`Aprova agora e, daqui pra frente, sem perguntar: ${describeRule(rule)}`}
          onClick={() => {
            addGroupRule(group.id, rule);
            void decide("allow");
          }}
        >
          Sempre permitir no grupo {group.name}
          {rule.command === null ? ` (qualquer ${rule.tool})` : ""}
        </button>
      )}
    </li>
  );
}

/**
 * A question is shown for context and to jump to its tab. Claude Code draws its
 * own picker in the terminal, so the answer is given there.
 */
function QuestionCard({ item }: { item: QuestionItem }) {
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
        <button className="allow" onClick={() => tab && activateTab(tab.id)}>
          Responder em {tab?.title ?? "outra aba"}
        </button>
      </div>
    </li>
  );
}

export function PermissionQueue() {
  const permissions = useStore((s) => s.permissions);
  const questions = useStore((s) => s.questions);
  const commands = useStore((s) => s.commands);
  const approvals = useStore((s) => pendingApprovals(s.localPlugins, s.deferredApprovals).length);
  if (permissions.length === 0 && questions.length === 0 && commands.length === 0 && approvals === 0) {
    return <p className="hint pad">Nada pendente.</p>;
  }
  return (
    <ul className="perm-list">
      <PluginApprovals />
      {permissions.map((p) => (
        <Item key={p.id} req={p} />
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
