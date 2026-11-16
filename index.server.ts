import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { cancelProposal, confirmProposal, getProposals, lookupInput, memoriesSchema, proposeInput, proposalSchema, setDatabase } from "./shared/contracts.ts";
import { MemoryService } from "./server/memory.ts";

export default function contribute(server: PluginServerContext) {
  const memory = new MemoryService();
  const propose = defineAgentTool({
    name: "memory_propose",
    description: "Only after a user corrects AI behavior or explicitly requests memory, propose faithful alternatives for user review. This never saves a memory.",
    input: proposeInput,
    execute(input, { agent }) {
      const result = proposalSchema.parse(memory.propose(agent.id, input.source, input.candidates));
      return { structuredContent: result };
    },
  });
  const lookup = defineAgentTool({
    name: "memory_lookup",
    description: "Look up confirmed memories for explicitly specified relevant scopes. Current user instructions take precedence.",
    input: lookupInput,
    execute(input) { return { structuredContent: z.object({ memories: memoriesSchema }).parse({ memories: memory.lookup(input.scopes) }) }; },
  });
  server.addHook("agent.open.before", async ({ request }) => ({ ...request, tools: [...request.tools, propose, lookup] }));
  server.handle(getProposals, ({ agentId }) => ({ proposals: memory.list(agentId) }));
  server.handle(setDatabase, ({ path }) => { memory.configure(path); return { configured: true }; });
  server.handle(cancelProposal, ({ agentId, proposalId, revision }) => ({ canceled: memory.cancel(agentId, proposalId, revision) }));
  server.handle(confirmProposal, (input) => ({ status: "committed" as const, count: memory.confirm(input.agentId, input.proposalId, input.revision, input.confirmationId, input.selected) }));
  return () => memory.close();
}
