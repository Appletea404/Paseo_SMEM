import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MemoryPanel } from "./client/memory.tsx";
import { MemoryCard } from "./client/memory-card.tsx";
import { cardSchema } from "./shared/contracts.ts";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({ id: "shared-memory", title: "Shared memory DB", icon: "Brain", context: "agent", Component: MemoryPanel });
  client.addCommandCenterItem({ id: "open-shared-memory", title: "Configure shared memory DB", icon: "Brain", context: "agent", onSelect({ openPanel }) { openPanel("shared-memory"); } });
  client.addTimelineRenderer({ kind: "memory-review", version: 1, schema: cardSchema, Component: MemoryCard });
  return () => {};
}
