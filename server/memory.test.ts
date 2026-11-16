import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MemoryService } from "./memory.ts";

test("selection, cancellation, scope filtering and confirmation identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-smem-"));
  const service = new MemoryService();
  const project = { kind: "project" as const, id: "project-a" };
  const host = { kind: "host" as const, id: "host-a" };
  const candidates = [{ id: "a", text: "first", scope: project }, { id: "b", text: "second", scope: host }];
  try {
    const p = service.propose("agent", "user-message-1", candidates);
    assert.throws(() => service.lookup([project]), /not been configured/);
    service.configure(join(dir, "memory.sqlite"));
    assert.deepEqual(service.lookup([project]), []);
    const edited = [{ ...candidates[0]!, text: "user edited" }];
    assert.equal(service.confirm("agent", p.id, 1, "confirmation-1", edited), 1);
    assert.equal(service.cancel("agent", p.id, 1), false);
    assert.equal(service.confirm("agent", p.id, 1, "confirmation-1", edited), 1);
    assert.throws(() => service.confirm("agent", p.id, 1, "confirmation-1", candidates), /different content/);
    assert.equal(service.lookup([project])[0]?.text, "user edited");
    assert.deepEqual(service.lookup([host]), []);
    assert.deepEqual(service.lookup([{ kind: "project", id: "project-b" }]), []);
    const canceled = service.propose("agent", "user-message-2", candidates);
    assert.equal(service.cancel("agent", canceled.id, 1), true);
    assert.equal(service.cancel("agent", canceled.id, 1), false);
    assert.throws(() => service.confirm("agent", canceled.id, 1, "confirmation-2", candidates), /unavailable/);
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
    const p = service.propose("agent", "source", [candidate]);
    service.confirm("agent", p.id, 1, "confirmed", [candidate]);
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
    const p = service.propose("agent", "source", candidates);
    assert.throws(() => service.confirm("agent", p.id, 1, "atomic", candidates));
    assert.deepEqual(service.lookup([scope]), []);
    assert.equal(service.confirm("agent", p.id, 1, "atomic", [candidates[0]!]), 1);
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("invalid selection does not partially save", () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-smem-"));
  const service = new MemoryService();
  const scope = { kind: "host" as const, id: "host-a" };
  try {
    service.configure(join(dir, "memory.sqlite"));
    const candidate = { id: "a", text: "one", scope };
    const p = service.propose("agent", "source", [candidate]);
    assert.throws(() => service.confirm("agent", p.id, 1, "bad", [candidate, { ...candidate, id: "missing" }]));
    assert.deepEqual(service.lookup([scope]), []);
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});
