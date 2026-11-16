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
  const page = { projection: "projected", epoch: "epoch", entries, error: null, staleCursor: false, reset: false, gap: false };
  const handle = { id: "agent", address: { serverId: "host-a" }, timeline: { refetch: async (options: { direction: string }) => options.direction === "tail" ? page : { ...page, entries: [entries[0]] } } } as unknown as Parameters<typeof sources>[0];
  const found = await sources(handle);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.locator.projection, "projected");
  assert.equal((await findSource(handle, found[0]!.locator)).excerpt, "original");
  for (const locator of [{ ...found[0]!.locator, hash: "wrong" }, { ...found[0]!.locator, epoch: "old" }, { ...found[0]!.locator, agentId: "other" }, { ...found[0]!.locator, seqStart: 2 }]) {
    await assert.rejects(findSource(handle, locator), /mismatch|match|verified/);
  }
  entries[0]!.item.text = "changed";
  await assert.rejects(findSource(handle, found[0]!.locator), /match/);
  page.staleCursor = true;
  await assert.rejects(findSource(handle, found[0]!.locator), /verified/);
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

test("native permission hooks connect confirmed selections to one transaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-smem-"));
  const path = join(dir, "memory.sqlite");
  const handlers: Record<string, (...args: any[]) => any> = {};
  const hooks: Record<string, (...args: any[]) => any> = {};
  const server = {
    addHook: (name: string, fn: (...args: any[]) => any) => { hooks[name] = fn; },
    handle: (contract: { name: string }, fn: (...args: any[]) => any) => { handlers[contract.name] = fn; },
  } as unknown as PluginServerContext;
  const cleanup = contribute(server);
  const agent = { id: "agent", provider: "codex" };
  let appendCalls = 0;
  let currentProject = "project-a";
  let onSource = () => {};
  const handle = {
    id: "agent", address: { serverId: "host-a" }, workspaceId: "workspace-a", cwd: "E:\\project",
    refresh: async () => ({ agent: {} }),
    timeline: {
      refetch: async () => { onSource(); return { projection: "projected", epoch: "epoch", error: null, staleCursor: false, reset: false, gap: false, entries: [{ item: { type: "user_message", text: "source text", messageId: "message" }, seqStart: 1, seqEnd: 1 }] }; },
      append: async () => { appendCalls++; },
    },
  };
  const paseo = { agents: { ref: () => handle }, workspaces: { ref: () => ({ refresh: async () => ({ projectId: currentProject, name: "workspace" }) }) } };
  const signal = new AbortController();
  const hookContext = { paseo, signal: signal.signal };
  try {
    const tools = (await hooks["agent.open.before"]!({ request: { tools: [] } })).tools;
    const tool = tools.find((item: { name: string }) => item.name === "memory_propose");
    const toolContext = { agent, paseo };
    const listed = (await tool.execute({ action: "sources" }, toolContext)).structuredContent;
    assert.equal(appendCalls, 0);
    assert.equal(handlers["memory.confirm"], undefined);
    assert.equal(handlers["memory.cancel"], undefined);
    handlers["memory.database"]!({ path });
    const candidates = [{ id: "a", text: "one", scopeKind: "project" }, { id: "b", text: "two", scopeKind: "host" }];
    const start = async () => (await tool.execute({ action: "propose", locator: listed.sources[0].locator, candidates }, toolContext)).structuredContent;
    const status = async (proposalId: string) => (await tool.execute({ action: "status", proposalId, revision: 1 }, toolContext)).structuredContent;
    const requestFor = (view: any, id: string) => { const q = view.next.arguments.questions[0]; return { id, provider: "codex", name: "request_user_input_async", kind: "question", input: { questions: [{ id: "0", header: "Question 1", question: q.title, options: q.options.map((label: string) => ({ label })), isOther: true }] } }; };
    const answer = { behavior: "allow", updatedInput: { answers: { "Question 1": "표시 항목 모두 저장" } } };
    const first = await start();
    assert.equal(first.status, "awaiting_question");
    assert.equal((await status(first.proposalId)).status, "awaiting_question");
    const request = requestFor(first, "request-1");
    await hooks["agent.permission.before"]!({ agent: { ...agent, id: "other" }, request }, hookContext);
    await hooks["agent.permission.after"]!({ agent, requestId: "wrong", resolution: answer }, hookContext);
    assert.equal((await status(first.proposalId)).status, "awaiting_question");
    await hooks["agent.permission.before"]!({ agent, request }, hookContext);
    await hooks["agent.permission.after"]!({ agent, requestId: request.id, resolution: answer }, hookContext);
    const saved = await status(first.proposalId);
    assert.equal(saved.status, "committed");
    assert.equal(saved.count, 2);
    assert.deepEqual(saved.selected.map((c: any) => c.text), ["one", "two"]);
    const db = new DatabaseSync(path);
    const rows = db.prepare("SELECT source FROM memories").all();
    assert.equal(rows.length, 2);
    const stored = JSON.parse(String(rows[0]!.source));
    assert.equal(stored.version, 2);
    assert.equal(stored.evidence.length, 2);
    assert.equal(JSON.stringify(stored).includes("source text"), false);
    db.close();
    const canceled = await start();
    const cancelRequest = requestFor(canceled, "request-2");
    await hooks["agent.permission.before"]!({ agent, request: cancelRequest }, hookContext);
    await hooks["agent.permission.after"]!({ agent, requestId: cancelRequest.id, resolution: { behavior: "deny" } }, hookContext);
    assert.equal((await status(canceled.proposalId)).status, "canceled");
    const changed = await start();
    const changedRequest = requestFor(changed, "request-3");
    await hooks["agent.permission.before"]!({ agent, request: changedRequest }, hookContext);
    currentProject = "different";
    await hooks["agent.permission.after"]!({ agent, requestId: changedRequest.id, resolution: answer }, hookContext);
    assert.equal((await status(changed.proposalId)).status, "failed");
    currentProject = "project-a";
    const aborted = await start();
    const abortRequest = requestFor(aborted, "request-4");
    await hooks["agent.permission.before"]!({ agent, request: abortRequest }, hookContext);
    onSource = () => signal.abort();
    await hooks["agent.permission.after"]!({ agent, requestId: abortRequest.id, resolution: answer }, hookContext);
    assert.equal((await status(aborted.proposalId)).status, "failed");
    const check = new DatabaseSync(path);
    assert.equal(check.prepare("SELECT count(*) AS n FROM memories").get()?.n, 2);
    check.close();
    assert.equal(appendCalls, 0);
  } finally { await cleanup?.(); rmSync(dir, { recursive: true, force: true }); }
});
