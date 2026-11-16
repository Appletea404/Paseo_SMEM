import { createHash } from "node:crypto";
import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { actualNativeStatusSchema, getProposal, getProposals, lookupInput, memoriesSchema, proposeInput, setDatabase, sourceSchema } from "./shared/contracts.ts";
import { MemoryService } from "./server/memory.ts";
import { findSource, sameContext, scopeId, session, sources } from "./server/context.ts";
import { NativeReview } from "./server/native.ts";

type HookContext = Parameters<Parameters<PluginServerContext["handle"]>[1]>[1];

type Environment = { paseo: HookContext["paseo"]; signal: AbortSignal; agentId: string; provider: string };

export default function contribute(server: PluginServerContext) {
  const memory = new MemoryService();
  const review = new NativeReview<Environment>(async (input, environment) => {
    const { proposal } = input;
    const valid = () => {
      if (environment.signal.aborted || !input.isCurrent() || environment.agentId !== proposal.agentId) return false;
      try { return JSON.stringify(memory.get(proposal.agentId, proposal.id, proposal.revision)) === JSON.stringify(proposal); } catch { return false; }
    };
    if (!valid()) return { status: "failed" };
    let current: Awaited<ReturnType<typeof session>>;
    try { current = await session(environment.paseo, environment.agentId); } catch { return { status: "failed" }; }
    if (!valid() || !sameContext(proposal.context, current.context)) return { status: "failed" };
    try { await findSource(current.handle, proposal.source.locator); } catch { return { status: "failed" }; }
    if (!valid()) return { status: "failed" };
    const id = createHash("sha256").update(JSON.stringify([proposal.context.serverId, proposal.agentId, input.finalRequestId, proposal.id, proposal.revision])).digest("hex");
    memory.confirm(proposal.agentId, proposal.id, proposal.revision, id, input.selected, current.context, input.evidence);
    return { status: "committed" };
  });
  const propose = defineAgentTool({
    name: "memory_propose",
    description: "Only after a user correction or explicit memory request: call sources, then propose. Call next.tool with next.arguments exactly; after the native response call status once. Repeat only when status supplies another next. An accepted async question is not an answer or commit. Report unavailable tools or missing callbacks; never claim saved before committed. User-message role and native responses do not authenticate a human.",
    input: proposeInput,
    async execute(input, { agent, paseo }) {
      if (input.action === "status") {
        if (!input.proposalId || !input.revision) throw new Error("Status requires proposalId and revision.");
        const serverId = paseo.agents.ref(agent.id).address.serverId;
        return { structuredContent: actualNativeStatusSchema.parse(await review.status(serverId, agent.id, input.proposalId, input.revision)) };
      }
      const { handle, context } = await session(paseo, agent.id);
      if (input.action === "sources") return { structuredContent: z.object({ sources: z.array(sourceSchema) }).parse({ sources: await sources(handle) }) };
      if (!input.locator || !input.candidates) throw new Error("Propose requires locator and candidates.");
      if (agent.provider !== "codex" && agent.provider !== "claude") throw new Error("Unsupported provider.");
      const source = await findSource(handle, input.locator);
      const candidates = input.candidates.map((c) => ({ id: c.id, text: c.text, scope: scopeId(context, c.scopeKind) }));
      const proposal = memory.propose(context, source, candidates);
      return { structuredContent: actualNativeStatusSchema.parse(review.start(proposal, agent.provider)) };
    },
  });
  const lookup = defineAgentTool({
    name: "memory_lookup",
    description: "Look up confirmed memories for explicitly specified relevant scopes. Current user instructions take precedence.",
    input: lookupInput,
    async execute(input, { agent, paseo }) { const { context } = await session(paseo, agent.id); return { structuredContent: z.object({ memories: memoriesSchema }).parse({ memories: memory.lookup(input.scopes.map((kind) => scopeId(context, kind))) }) }; },
  });
  server.addHook("agent.open.before", async ({ request }) => ({ ...request, tools: [...request.tools, propose, lookup] }));
  server.addHook("agent.permission.before", async ({ agent, request }, { paseo }) => {
    if (agent.provider !== request.provider) return;
    review.before(paseo.agents.ref(agent.id).address.serverId, agent.id, request);
  });
  server.addHook("agent.permission.after", async ({ agent, requestId, resolution }, { paseo, signal }) => {
    const result = review.after(paseo.agents.ref(agent.id).address.serverId, agent.id, agent.provider, requestId, resolution, { paseo, signal, agentId: agent.id, provider: agent.provider }, signal);
    if (!result) return;
    const state = await result;
    if (state.status === "canceled") memory.cancel(agent.id, state.proposalId, state.revision);
  });
  server.handle(getProposals, ({ agentId }) => ({ proposals: memory.list(agentId) }));
  server.handle(getProposal, ({ agentId, proposalId, revision }) => ({ proposal: memory.list(agentId).find((p) => p.id === proposalId && p.revision === revision) ?? null }));
  server.handle(setDatabase, ({ path }) => { memory.configure(path); return { configured: true }; });
  return () => memory.close();
}
