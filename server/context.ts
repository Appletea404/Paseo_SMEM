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
  const matches = (await sources(handle)).filter((s) => JSON.stringify(s.locator) === JSON.stringify(locatorSchema.parse(locator)));
  if (matches.length !== 1) throw new Error("Source not found or ambiguous within the latest 100 timeline entries.");
  return matches[0]!;
}
export function scopeId(context: z.infer<typeof contextSchema>, kind: "project" | "host") {
  const id = kind === "host" ? context.serverId : context.projectId;
  if (!id) throw new Error("Project scope is unavailable.");
  return { kind, id };
}
export function sameContext(a: z.infer<typeof contextSchema>, b: z.infer<typeof contextSchema>) {
  return a.agentId === b.agentId && a.serverId === b.serverId && a.workspaceId === b.workspaceId && a.projectId === b.projectId;
}
