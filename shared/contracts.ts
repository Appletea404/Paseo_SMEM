import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const scopeSchema = z.object({ kind: z.enum(["project", "host"]), id: z.string().trim().min(1) });
const memoryText = z.string().min(1).refine((value) => value.trim().length > 0);
export const candidateSchema = z.object({ id: z.string().min(1), text: memoryText, scope: scopeSchema });
export const contextSchema = z.object({ agentId: z.string().min(1), serverId: z.string().min(1), workspaceId: z.string().min(1), projectId: z.string().nullable(), cwd: z.string().nullable(), workspaceName: z.string().nullable() });
export const locatorSchema = z.object({ agentId: z.string(), serverId: z.string(), projection: z.enum(["canonical", "projected"]), epoch: z.string(), seqStart: z.number(), seqEnd: z.number(), messageId: z.string().optional(), clientMessageId: z.string().optional(), hash: z.string() });
export const sourceSchema = z.object({ locator: locatorSchema, excerpt: z.string(), role: z.literal("user_message") });
export const proposalSchema = z.object({ id: z.string(), revision: z.number().int().positive(), agentId: z.string(), context: contextSchema, source: sourceSchema, candidates: z.array(candidateSchema).min(1) });
export const proposeInput = z.object({
  action: z.enum(["sources", "propose"]).describe("First call sources; then call propose. Sources does not create a proposal."),
  locator: locatorSchema.optional().describe("Required for propose: copy a locator returned by sources."),
  candidates: z.array(z.object({ id: z.string().min(1), text: memoryText, scopeKind: z.enum(["project", "host"]) })).min(2).optional().describe("Required for propose: faithful alternatives without strengthening the request."),
}).refine((input) => input.action !== "propose" || (input.locator !== undefined && input.candidates !== undefined), { message: "Propose requires locator and candidates." });
export const lookupInput = z.object({ scopes: z.array(z.enum(["project", "host"])).min(1) });
export const memoriesSchema = z.array(z.object({ id: z.string(), text: z.string(), scope: scopeSchema, source: z.string() }));
export const getProposals = defineRpc({ name: "memory.proposals", input: z.object({ agentId: z.string().min(1) }), output: z.object({ proposals: z.array(proposalSchema) }) });
export const setDatabase = defineRpc({ name: "memory.database", input: z.object({ path: z.string().trim().min(1) }), output: z.object({ configured: z.boolean() }) });
export const cancelProposal = defineRpc({ name: "memory.cancel", input: z.object({ agentId: z.string(), proposalId: z.string(), revision: z.number().int() }), output: z.object({ canceled: z.boolean() }) });
export const confirmProposal = defineRpc({ name: "memory.confirm", input: z.object({ agentId: z.string(), proposalId: z.string(), revision: z.number().int(), confirmationId: z.string().min(1), selected: z.array(candidateSchema).min(1) }), output: z.object({ status: z.literal("committed"), count: z.number().int() }) });
