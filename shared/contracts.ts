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
  action: z.enum(["sources", "propose", "status"]).describe("Call sources, then propose, then status after each native response."),
  locator: locatorSchema.optional().describe("Required for propose: copy a locator returned by sources."),
  candidates: z.array(z.object({ id: z.string().min(1), text: memoryText, scopeKind: z.enum(["project", "host"]) })).min(2).optional().describe("Required for propose: faithful alternatives without strengthening the request."),
  proposalId: z.string().min(1).optional().describe("Required for status."),
  revision: z.number().int().positive().optional().describe("Required for status."),
}).refine((input) => input.action !== "propose" || (input.locator !== undefined && input.candidates !== undefined), { message: "Propose requires locator and candidates." }).refine((input) => input.action !== "status" || (input.proposalId !== undefined && input.revision !== undefined), { message: "Status requires proposalId and revision." });
const nativeArguments = z.union([
  z.object({ questions: z.array(z.object({ title: z.string(), options: z.array(z.string()) })) }),
  z.object({ questions: z.array(z.object({ question: z.string(), header: z.string(), options: z.array(z.object({ label: z.string(), description: z.string() })), multiSelect: z.literal(false) })) }),
]);
export const actualNativeStatusSchema = z.object({ status: z.enum(["awaiting_question", "awaiting_response", "processing", "committed", "canceled", "failed", "result_unknown", "unavailable"]), proposalId: z.string().optional(), revision: z.number().int().positive().optional(), next: z.object({ tool: z.enum(["request_user_input_async", "AskUserQuestion"]), arguments: nativeArguments, stage: z.string() }).optional(), count: z.number().int().optional(), selected: z.array(candidateSchema).optional() });
export const lookupInput = z.object({ scopes: z.array(z.enum(["project", "host"])).min(1) });
export const memoriesSchema = z.array(z.object({ id: z.string(), text: z.string(), scope: scopeSchema, source: z.string() }));
export const getProposals = defineRpc({ name: "memory.proposals", input: z.object({ agentId: z.string().min(1) }), output: z.object({ proposals: z.array(proposalSchema) }) });
export const getProposal = defineRpc({ name: "memory.proposal", input: z.object({ agentId: z.string().min(1), proposalId: z.string().min(1), revision: z.number().int().positive() }), output: z.object({ proposal: proposalSchema.nullable() }) });
export const setDatabase = defineRpc({ name: "memory.database", input: z.object({ path: z.string().trim().min(1) }), output: z.object({ configured: z.boolean() }) });
