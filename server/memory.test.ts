import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MemoryService } from "./memory.ts";
import { findSource, sameContext, scopeId, sources } from "./context.ts";
import { proposeInput } from "../shared/contracts.ts";
import { z } from "zod";
import contribute from "../index.server.ts";
import type { PluginServerContext } from "@getpaseo/plugin/server";

const context = { agentId: "agent", serverId: "host-a", workspaceId: "workspace-a", projectId: "project-a", cwd: null, workspaceName: null };
const source = { role: "user_message" as const, excerpt: "example", locator: { agentId: "agent", serverId: "host-a", projection: "projected" as const, epoch: "epoch", seqStart: 1, seqEnd: 1, hash: "hash" } };

test("proposal tool schema exposes object and array inputs and validates actions", () => {
  const schema = z.toJSONSchema(proposeInput);
  assert.equal(schema.type, "object");
  const locator = schema.properties?.locator;
  const candidatesSchema = schema.properties?.candidates;
  assert.ok(locator && typeof locator === "object");
  assert.ok(candidatesSchema && typeof candidatesSchema === "object");
  assert.equal(locator.type, "object");
  assert.equal(candidatesSchema.type, "array");
  assert.equal(proposeInput.safeParse({ action: "sources" }).success, true);
  assert.equal(proposeInput.safeParse({ action: "propose" }).success, false);
  const candidates = [{ id: "a", text: "one", scopeKind: "host" }, { id: "b", text: "two", scopeKind: "project" }];
  assert.equal(proposeInput.safeParse({ action: "propose", locator: source.locator, candidates }).success, true);
  assert.equal(proposeInput.safeParse({ action: "propose", locator: JSON.stringify(source.locator), candidates }).success, false);
  assert.equal(proposeInput.safeParse({ action: "propose", locator: source.locator, candidates: JSON.stringify(candidates) }).success, false);
  assert.equal(proposeInput.safeParse({ action: "propose", locator: source.locator, candidates: candidates.slice(0, 1) }).success, false);
});

test("selection, cancellation, scope filtering and confirmation identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-smem-"));
  const service = new MemoryService();
  const project = { kind: "project" as const, id: "project-a" };
  const host = { kind: "host" as const, id: "host-a" };
  const candidates = [{ id: "a", text: "first", scope: project }, { id: "b", text: "second", scope: host }];
  try {
    const p = service.propose(context, source, candidates);
    assert.throws(() => service.lookup([project]), /not been configured/);
    service.configure(join(dir, "memory.sqlite"));
    assert.deepEqual(service.lookup([project]), []);
    const edited = [{ ...candidates[0]!, text: "user edited" }];
    assert.equal(service.confirm("agent", p.id, 1, "confirmation-1", edited, context), 1);
    assert.equal(service.cancel("agent", p.id, 1), false);
    assert.equal(service.confirm("agent", p.id, 1, "confirmation-1", edited, context), 1);
    assert.throws(() => service.confirm("agent", p.id, 1, "confirmation-1", candidates, context), /different content/);
    assert.equal(service.lookup([project])[0]?.text, "user edited");
    assert.deepEqual(service.lookup([host]), []);
    assert.deepEqual(service.lookup([{ kind: "project", id: "project-b" }]), []);
    const canceled = service.propose(context, source, candidates);
    assert.equal(service.cancel("agent", canceled.id, 1), true);
    assert.equal(service.cancel("agent", canceled.id, 1), false);
    assert.throws(() => service.confirm("agent", canceled.id, 1, "confirmation-2", candidates, context), /unavailable/);
    assert.equal(service.lookup([project]).length, 1);
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("failed initialization leaves the existing database available", () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-smem-"));
  const service = new MemoryService();
  const scope = { kind: "host" as const, id: "host-a" };
  try {
    service.configure(join(dir, "valid.sqlite"));
    const candidate = { id: "a", text: "kept", scope };
    const p = service.propose(context, source, [candidate]);
    service.confirm("agent", p.id, 1, "confirmed", [candidate], context);
    const broken = join(dir, "broken.sqlite");
    const db = new DatabaseSync(broken);
    db.exec("CREATE TABLE other (id INTEGER); CREATE INDEX confirmations ON other(id)");
    db.close();
    assert.throws(() => service.configure(broken));
    assert.equal(service.lookup([scope])[0]?.text, "kept");
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a database failure rolls back the complete confirmation", () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-smem-"));
  const path = join(dir, "memory.sqlite");
  const service = new MemoryService();
  const scope = { kind: "host" as const, id: "host-a" };
  try {
    service.configure(path);
    const db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER reject_second BEFORE INSERT ON memories WHEN NEW.text = 'reject' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    db.close();
    const candidates = [{ id: "a", text: "first", scope }, { id: "b", text: "reject", scope }];
    const p = service.propose(context, source, candidates);
    assert.throws(() => service.confirm("agent", p.id, 1, "atomic", candidates, context));
    assert.deepEqual(service.lookup([scope]), []);
    assert.equal(service.confirm("agent", p.id, 1, "atomic", [candidates[0]!], context), 1);
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("invalid selection does not partially save", () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-smem-"));
  const service = new MemoryService();
  const scope = { kind: "host" as const, id: "host-a" };
  try {
    service.configure(join(dir, "memory.sqlite"));
    const candidate = { id: "a", text: "one", scope };
    const p = service.propose(context, source, [candidate]);
    assert.throws(() => service.confirm("agent", p.id, 1, "bad", [candidate, { ...candidate, id: "missing" }], context));
    assert.deepEqual(service.lookup([scope]), []);
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("timeline locators are tied to the returned projection, epoch and text", async () => {
  const entries = [
    { item: { type: "user_message", text: "original", messageId: "message" }, seqStart: 1, seqEnd: 1 },
    { item: { type: "assistant_message", text: "assistant" }, seqStart: 2, seqEnd: 2 },
    { item: { type: "user_message", text: "<paseo-system>forwarded</paseo-system>" }, seqStart: 3, seqEnd: 3 },
  ];
  const page = { projection: "projected", epoch: "epoch", entries, error: null };
  const handle = { id: "agent", address: { serverId: "host-a" }, timeline: { refetch: async () => page } } as unknown as Parameters<typeof sources>[0];
  const found = await sources(handle);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.locator.projection, "projected");
  assert.equal((await findSource(handle, found[0]!.locator)).excerpt, "original");
  for (const locator of [{ ...found[0]!.locator, hash: "wrong" }, { ...found[0]!.locator, epoch: "old" }, { ...found[0]!.locator, agentId: "other" }, { ...found[0]!.locator, seqStart: 2 }]) {
    await assert.rejects(findSource(handle, locator), /not found/);
  }
  entries[0]!.item.text = "changed";
  await assert.rejects(findSource(handle, found[0]!.locator), /not found/);
});

test("scope and context changes cannot redirect a proposal", () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-smem-"));
  const service = new MemoryService();
  const candidate = { id: "a", text: "original", scope: { kind: "project" as const, id: "project-a" } };
  try {
    service.configure(join(dir, "memory.sqlite"));
    assert.throws(() => scopeId({ ...context, projectId: null }, "project"), /unavailable/);
    assert.equal(sameContext(context, { ...context, workspaceId: "other" }), false);
    assert.throws(() => service.propose(context, source, [{ ...candidate, scope: { ...candidate.scope, id: "other" } }]), /scope/);
    const p = service.propose(context, source, [candidate]);
    assert.throws(() => service.confirm("agent", p.id, 1, "id", [candidate], { ...context, projectId: "other" }), /context/);
    assert.throws(() => service.confirm("agent", p.id, 1, "id", [{ ...candidate, scope: { ...candidate.scope, id: "other" } }], context), /scope/);
    assert.deepEqual(service.lookup([candidate.scope]), []);
    const edited = { ...candidate, text: "  edited exactly  ", scope: { kind: "host" as const, id: "host-a" } };
    service.confirm("agent", p.id, 1, "id", [edited], context);
    const stored = service.lookup([edited.scope])[0]!;
    assert.equal(stored.text, edited.text);
    assert.equal(JSON.parse(stored.source).version, 1);
    assert.equal(stored.source.includes("example"), false);
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("legacy source and confirmation payload remain unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-smem-"));
  const path = join(dir, "memory.sqlite");
  const service = new MemoryService();
  const selected = [{ id: "a", text: "old", scope: { kind: "host" as const, id: "host-a" } }];
  try {
    service.configure(path);
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO confirmations VALUES (?, ?)").run("legacy-id", JSON.stringify({ agentId: "agent", id: "old-proposal", revision: 1, selected }));
    db.prepare("INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?)").run("old-memory", "old", "host", "host-a", "legacy source", "legacy-id");
    db.close();
    assert.equal(service.confirmed("agent", "old-proposal", 1, "legacy-id", selected), true);
    assert.equal(service.lookup([selected[0]!.scope])[0]!.source, "legacy source");
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("timeline card lifecycle separates database outcome from append failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-smem-"));
  const handlers: Record<string, (...args: any[]) => any> = {};
  let hook: (...args: any[]) => any = () => undefined;
  const server = {
    addHook: (_name: string, fn: (...args: any[]) => any) => { hook = fn; },
    handle: (contract: { name: string }, fn: (...args: any[]) => any) => { handlers[contract.name] = fn; },
  } as unknown as PluginServerContext;
  const cleanup = contribute(server);
  const published: any[] = [];
  let failAppend = false;
  const handle = {
    id: "agent", address: { serverId: "host-a" }, workspaceId: "workspace-a", cwd: "E:\\project",
    refresh: async () => ({ agent: {} }),
    timeline: {
      refetch: async () => ({ projection: "projected", epoch: "epoch", error: null, entries: [{ item: { type: "user_message", text: "source text", messageId: "message" }, seqStart: 1, seqEnd: 1 }] }),
      append: async (row: any) => { if (failAppend) throw new Error("append failed"); published.push(row); },
    },
  };
  const paseo = { agents: { ref: () => handle }, workspaces: { ref: () => ({ refresh: async () => ({ projectId: "project-a", name: "workspace" }) }) } };
  try {
    const tools = (await hook({ request: { tools: [] } })).tools;
    const tool = tools.find((item: { name: string }) => item.name === "memory_propose");
    const contextArg = { agent: { id: "agent" }, paseo };
    const sourceResult = await tool.execute({ action: "sources" }, contextArg);
    assert.equal(published.length, 0);
    const locator = sourceResult.structuredContent.sources[0].locator;
    const input = { action: "propose", locator, candidates: [{ id: "a", text: "one", scopeKind: "project" }, { id: "b", text: "two", scopeKind: "host" }] };
    const first = (await tool.execute(input, contextArg)).structuredContent;
    assert.equal(first.cardPublished, true);
    assert.deepEqual(Object.keys(published[0].data).sort(), ["agentId", "proposalId", "revision", "status"]);
    const p = first.proposal;
    const refs = { agentId: "agent", proposalId: p.id, revision: p.revision };
    assert.equal((await handlers["memory.proposal"]!(refs)).proposal.id, p.id);
    assert.equal((await handlers["memory.proposal"]!({ ...refs, revision: 2 })).proposal, null);
    handlers["memory.database"]!({ path: join(dir, "memory.sqlite") });
    const selected = [{ id: "a", text: "edited", scope: { kind: "project", id: "project-a" } }];
    const confirm = { ...refs, confirmationId: "first", selected };
    const saved = await handlers["memory.confirm"]!(confirm, { paseo });
    assert.equal(saved.cardUpdated, true);
    assert.equal(published[1].id, published[0].id);
    assert.deepEqual(published[1].data.selected, selected);
    assert.equal((await handlers["memory.proposal"]!(refs)).proposal, null);
    assert.equal((await handlers["memory.confirm"]!(confirm, { paseo })).count, 1);
    assert.equal(published.length, 2);
    const second = (await tool.execute(input, contextArg)).structuredContent.proposal;
    const cancelRefs = { agentId: "agent", proposalId: second.id, revision: 1 };
    const canceled = await handlers["memory.cancel"]!(cancelRefs, { paseo });
    assert.equal(canceled.canceled, true);
    assert.equal(published[3].id, published[2].id);
    assert.equal(published[3].data.status, "canceled");
    const third = (await tool.execute(input, contextArg)).structuredContent.proposal;
    failAppend = true;
    const failedUpdate = await handlers["memory.confirm"]!({ agentId: "agent", proposalId: third.id, revision: 1, confirmationId: "third", selected }, { paseo });
    assert.equal(failedUpdate.status, "committed");
    assert.equal(failedUpdate.cardUpdated, false);
    const db = new DatabaseSync(join(dir, "memory.sqlite"));
    assert.equal(db.prepare("SELECT count(*) AS n FROM memories").get()?.n, 2);
    db.close();
    const failedPublish = (await tool.execute(input, contextArg)).structuredContent;
    assert.equal(failedPublish.cardPublished, false);
    assert.match(failedPublish.message, /no memory was saved/);
    const canceledWithoutCard = await handlers["memory.cancel"]!({ agentId: "agent", proposalId: failedPublish.proposal.id, revision: 1 }, { paseo });
    assert.equal(canceledWithoutCard.canceled, true);
    assert.equal(canceledWithoutCard.cardUpdated, false);
  } finally { await cleanup?.(); rmSync(dir, { recursive: true, force: true }); }
});
