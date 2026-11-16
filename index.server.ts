import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { cancelProposal, cardSchema, confirmProposal, getProposal, getProposals, lookupInput, memoriesSchema, proposeInput, proposalSchema, setDatabase, sourceSchema } from "./shared/contracts.ts";
import { MemoryService } from "./server/memory.ts";
import { findSource, sameContext, scopeId, session, sources } from "./server/context.ts";

export default function contribute(server: PluginServerContext) {
  const memory = new MemoryService();
  const propose = defineAgentTool({
    name: "memory_propose",
    description: "Only after a user corrects AI behavior or explicitly requests memory: call action sources, then action propose with a returned locator and faithful candidates. Neither action saves memory. A user_message is not human authentication.",
    input: proposeInput,
    async execute(input, { agent, paseo }) {
      const { handle, context } = await session(paseo, agent.id);
      if (input.action === "sources") return { structuredContent: z.object({ sources: z.array(sourceSchema) }).parse({ sources: await sources(handle) }) };
      if (!input.locator || !input.candidates) throw new Error("Propose requires locator and candidates.");
      const source = await findSource(handle, input.locator);
      const candidates = input.candidates.map((c) => ({ id: c.id, text: c.text, scope: scopeId(context, c.scopeKind) }));
      const result = proposalSchema.parse(memory.propose(context, source, candidates));
      let cardPublished = false;
      try {
        const data = cardSchema.parse({ status: "pending", agentId: agent.id, proposalId: result.id, revision: result.revision });
        await handle.timeline.append({ type: "plugin", id: `memory-${result.id}`, kind: "memory-review", version: 1, data });
        cardPublished = true;
      } catch { /* No memory has been committed. */ }
      return { structuredContent: { proposal: result, cardPublished, ...(cardPublished ? {} : { message: "Card publication failed; no memory was saved." }) } };
    },
  });
  const lookup = defineAgentTool({
    name: "memory_lookup",
    description: "Look up confirmed memories for explicitly specified relevant scopes. Current user instructions take precedence.",
    input: lookupInput,
    async execute(input, { agent, paseo }) { const { context } = await session(paseo, agent.id); return { structuredContent: z.object({ memories: memoriesSchema }).parse({ memories: memory.lookup(input.scopes.map((kind) => scopeId(context, kind))) }) }; },
  });
  server.addHook("agent.open.before", async ({ request }) => ({ ...request, tools: [...request.tools, propose, lookup] }));
  server.handle(getProposals, ({ agentId }) => ({ proposals: memory.list(agentId) }));
  server.handle(getProposal, ({ agentId, proposalId, revision }) => ({ proposal: memory.list(agentId).find((p) => p.id === proposalId && p.revision === revision) ?? null }));
  server.handle(setDatabase, ({ path }) => { memory.configure(path); return { configured: true }; });
  server.handle(cancelProposal, async ({ agentId, proposalId, revision }, { paseo }) => {
    const canceled = memory.cancel(agentId, proposalId, revision);
    let cardUpdated = false;
    if (canceled) try {
      const data = cardSchema.parse({ status: "canceled", agentId, proposalId, revision });
      await paseo.agents.ref(agentId).timeline.append({ type: "plugin", id: `memory-${proposalId}`, kind: "memory-review", version: 1, data });
      cardUpdated = true;
    } catch { /* Cancellation already succeeded. */ }
    return { canceled, cardUpdated };
  });
  server.handle(confirmProposal, async (input, { paseo }) => {
    if (memory.confirmed(input.agentId, input.proposalId, input.revision, input.confirmationId, input.selected)) return { status: "committed" as const, count: input.selected.length, cardUpdated: false };
    const proposal = memory.get(input.agentId, input.proposalId, input.revision);
    const { handle, context } = await session(paseo, input.agentId);
    if (!sameContext(proposal.context, context)) throw new Error("Agent context changed.");
    await findSource(handle, proposal.source.locator);
    const count = memory.confirm(input.agentId, input.proposalId, input.revision, input.confirmationId, input.selected, context);
    let cardUpdated = false;
    try {
      const data = cardSchema.parse({ status: "saved", agentId: input.agentId, proposalId: input.proposalId, revision: input.revision, selected: input.selected });
      await handle.timeline.append({ type: "plugin", id: `memory-${input.proposalId}`, kind: "memory-review", version: 1, data });
      cardUpdated = true;
    } catch { /* The database commit has already succeeded. */ }
    return { status: "committed" as const, count, cardUpdated };
  });
  return () => memory.close();
}
