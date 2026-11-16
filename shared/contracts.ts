import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const scopeSchema = z.object({ kind: z.enum(["project", "host"]), id: z.string().trim().min(1) });
const memoryText = z.string().min(1).refine((value) => value.trim().length > 0);
export const candidateSchema = z.object({ id: z.string().min(1), text: memoryText, scope: scopeSchema });
export const proposalSchema = z.object({ id: z.string(), revision: z.number().int().positive(), agentId: z.string(), source: z.string().min(1), candidates: z.array(candidateSchema).min(1) });
export const proposeInput = z.object({ source: z.string().trim().min(1).describe("Identifier of the user correction or explicit memory request"), candidates: z.array(candidateSchema).min(2).describe("Faithful alternatives; do not strengthen the user's request") });
export const lookupInput = z.object({ scopes: z.array(scopeSchema).min(1) });
export const memoriesSchema = z.array(z.object({ id: z.string(), text: z.string(), scope: scopeSchema, source: z.string() }));
export const getProposals = defineRpc({ name: "memory.proposals", input: z.object({ agentId: z.string().min(1) }), output: z.object({ proposals: z.array(proposalSchema) }) });
export const setDatabase = defineRpc({ name: "memory.database", input: z.object({ path: z.string().trim().min(1) }), output: z.object({ configured: z.boolean() }) });
export const cancelProposal = defineRpc({ name: "memory.cancel", input: z.object({ agentId: z.string(), proposalId: z.string(), revision: z.number().int() }), output: z.object({ canceled: z.boolean() }) });
export const confirmProposal = defineRpc({ name: "memory.confirm", input: z.object({ agentId: z.string(), proposalId: z.string(), revision: z.number().int(), confirmationId: z.string().min(1), selected: z.array(candidateSchema).min(1) }), output: z.object({ status: z.literal("committed"), count: z.number().int() }) });
