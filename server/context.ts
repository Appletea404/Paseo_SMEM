import { createHash } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { contextSchema, locatorSchema, sourceSchema } from "../shared/contracts.ts";
import type { z } from "zod";

type Paseo = Parameters<Parameters<PluginServerContext["handle"]>[1]>[1]["paseo"];
type Locator = z.infer<typeof locatorSchema>;
export async function session(paseo: Paseo, agentId: string) {
  const handle = paseo.agents.ref(agentId);
  const snapshot = await handle.refresh();
  if (!snapshot || !handle.workspaceId) throw new Error("Agent or workspace is unavailable.");
  const workspace = await paseo.workspaces.ref(handle.workspaceId).refresh();
  if (!workspace) throw new Error("Workspace is unavailable.");
  const context = contextSchema.parse({ agentId: handle.id, serverId: handle.address.serverId, workspaceId: handle.workspaceId, projectId: workspace.projectId ?? null, cwd: handle.cwd ?? null, workspaceName: workspace.name ?? null });
  return { handle, context };
}
export async function sources(handle: Awaited<ReturnType<typeof session>>["handle"]) {
  const page = await handle.timeline.refetch({ projection: "canonical", direction: "tail", limit: 100 });
  if (page.error) throw new Error(page.error);
  return page.entries.flatMap((entry) => {
    const item = entry.item;
    if (item.type !== "user_message" || /^\s*<paseo-system\b/.test(item.text)) return [];
    const locator = locatorSchema.parse({ agentId: handle.id, serverId: handle.address.serverId, projection: page.projection, epoch: page.epoch, seqStart: entry.seqStart, seqEnd: entry.seqEnd, messageId: item.messageId, clientMessageId: item.clientMessageId, hash: createHash("sha256").update(item.text).digest("hex") });
    return [sourceSchema.parse({ locator, excerpt: item.text.slice(0, 500), role: "user_message" })];
  });
}
export async function findSource(handle: Awaited<ReturnType<typeof session>>["handle"], locator: Locator) {
  const expected = locatorSchema.parse(locator);
  if (expected.agentId !== handle.id || expected.serverId !== handle.address.serverId) throw new Error("Source agent or host mismatch.");
  const page = await handle.timeline.refetch({ projection: expected.projection, direction: "before", cursor: { epoch: expected.epoch, seq: expected.seqEnd + 1 }, limit: 1 });
  if (page.error || page.staleCursor || page.reset || page.gap || page.projection !== expected.projection || page.epoch !== expected.epoch || page.entries.length !== 1) throw new Error("Source could not be verified at the requested cursor.");
  const entry = page.entries[0]!;
  const item = entry.item;
  if (item.type !== "user_message" || /^\s*<paseo-system\b/.test(item.text)) throw new Error("Source is not a user message.");
  const actual = locatorSchema.parse({ agentId: handle.id, serverId: handle.address.serverId, projection: page.projection, epoch: page.epoch, seqStart: entry.seqStart, seqEnd: entry.seqEnd, messageId: item.messageId, clientMessageId: item.clientMessageId, hash: createHash("sha256").update(item.text).digest("hex") });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Source locator does not match.");
  return sourceSchema.parse({ locator: actual, excerpt: item.text.slice(0, 500), role: "user_message" });
}
export function scopeId(context: z.infer<typeof contextSchema>, kind: "project" | "host") {
  const id = kind === "host" ? context.serverId : context.projectId;
  if (!id) throw new Error("Project scope is unavailable.");
  return { kind, id };
}
export function sameContext(a: z.infer<typeof contextSchema>, b: z.infer<typeof contextSchema>) {
  return a.agentId === b.agentId && a.serverId === b.serverId && a.workspaceId === b.workspaceId && a.projectId === b.projectId;
}
