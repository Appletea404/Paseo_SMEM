import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MemoryPanel } from "./client/memory.tsx";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({ id: "shared-memory", title: "Shared memory", icon: "Brain", context: "agent", Component: MemoryPanel });
  client.addCommandCenterItem({ id: "open-shared-memory", title: "Review shared memory", icon: "Brain", context: "agent", onSelect({ openPanel }) { openPanel("shared-memory"); } });
  return () => {};
}
