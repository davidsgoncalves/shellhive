import { makeNode, NODE_GAP, NODE_W } from "./flowGraph";
import type { Bee, Flow, FlowEdge } from "./types";

const STEP = NODE_W + NODE_GAP;
const Y = 80;

/**
 * Bees used to start on their own triggers. Each one that did becomes a flow,
 * trigger then bee; a bee started after another joins that bee's flow, linked
 * after it. Bees keep their prompt and lose the trigger.
 */
export function beesToFlows(bees: Bee[], flows: Flow[]): { bees: Bee[]; flows: Flow[] } {
  if (!bees.some((b) => b.trigger)) return { bees, flows };
  const out = [...flows];
  const flowOf = new Map<string, Flow>();
  const nodeOf = new Map<string, string>();

  const ownFlow = (bee: Bee, triggerNode: ReturnType<typeof makeNode>): Flow => {
    const beeNode = makeNode({ kind: "bee", beeId: bee.id, dir: null }, 40 + STEP, Y);
    const flow: Flow = {
      id: crypto.randomUUID(),
      name: bee.name,
      enabled: bee.enabled,
      nodes: [triggerNode, beeNode],
      edges: [{ id: crypto.randomUUID(), from: triggerNode.id, port: "out", to: beeNode.id }],
      createdAt: Date.now(),
      lastRunAt: bee.lastRunAt,
    };
    out.push(flow);
    flowOf.set(bee.id, flow);
    nodeOf.set(bee.id, beeNode.id);
    return flow;
  };

  const after = (b: Bee) => (b.trigger?.kind === "event" && b.trigger.event.on === "beeDone" ? b.trigger.event.beeId : null);

  for (const bee of bees) {
    const t = bee.trigger;
    if (!t || t.kind === "manual" || after(bee)) continue;
    ownFlow(bee, makeNode({ kind: "trigger", trigger: t, missed: bee.missed ?? "run" }, 40, Y));
  }
  // Chains, in as many passes as they are long.
  let pending = bees.filter((b) => after(b));
  for (let pass = 0; pending.length && pass < bees.length + 1; pass++) {
    const left: Bee[] = [];
    for (const bee of pending) {
      const source = bees.find((b) => b.id === after(bee));
      if (!source) continue;
      let flow = flowOf.get(source.id);
      // A chain from a bee that only ran by hand starts with a manual trigger.
      if (!flow) {
        if (after(source)) {
          left.push(bee);
          continue;
        }
        flow = ownFlow(source, makeNode({ kind: "trigger", trigger: { kind: "manual" }, missed: "run" }, 40, Y));
      }
      const prev = flow.nodes.find((n) => n.id === nodeOf.get(source.id))!;
      const below = flow.nodes.filter((n) => n.x === prev.x + STEP).length;
      const node = makeNode({ kind: "bee", beeId: bee.id, dir: null }, prev.x + STEP, prev.y + below * 110);
      const edge: FlowEdge = { id: crypto.randomUUID(), from: prev.id, port: "out", to: node.id };
      flow.nodes.push(node);
      flow.edges.push(edge);
      flowOf.set(bee.id, flow);
      nodeOf.set(bee.id, node.id);
    }
    pending = left;
  }
  const stripped = bees.map((b) => {
    const rest: Bee = { ...b };
    delete rest.trigger;
    delete rest.missed;
    return rest;
  });
  return { bees: stripped, flows: out };
}
