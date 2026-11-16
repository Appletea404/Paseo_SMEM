import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { candidateSchema, memoriesSchema, proposalSchema, type scopeSchema } from "../shared/contracts.ts";
import type { z } from "zod";

type Scope = z.infer<typeof scopeSchema>;
type Proposal = z.infer<typeof proposalSchema>;
type Candidate = z.infer<typeof candidateSchema>;

export class MemoryService {
  private proposals = new Map<string, Proposal>();
  private db: DatabaseSync | undefined;

  configure(path: string) {
    if (!isAbsolute(path)) throw new Error("An absolute database path is required.");
    const db = new DatabaseSync(path);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS confirmations (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, source TEXT NOT NULL, confirmation_id TEXT NOT NULL)");
    } catch (error) { db.close(); throw error; }
    this.db?.close();
    this.db = db;
  }

  propose(agentId: string, source: string, candidates: Candidate[]) {
    if (new Set(candidates.map((c) => c.id)).size !== candidates.length) throw new Error("Duplicate candidate IDs.");
    const proposal = proposalSchema.parse({ id: randomUUID(), revision: 1, agentId, source, candidates });
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  list(agentId: string) { return [...this.proposals.values()].filter((p) => p.agentId === agentId); }
  cancel(agentId: string, id: string, revision: number) {
    const p = this.proposals.get(id);
    if (!p || p.agentId !== agentId || p.revision !== revision) return false;
    return this.proposals.delete(id);
  }
  confirm(agentId: string, id: string, revision: number, confirmationId: string, selected: Candidate[]) {
    if (!this.db) throw new Error("Database path has not been configured.");
    const payload = JSON.stringify({ agentId, id, revision, selected });
    const existing = this.db.prepare("SELECT payload FROM confirmations WHERE id = ?").get(confirmationId);
    if (existing) {
      if (existing.payload !== payload) throw new Error("Confirmation ID already used with different content.");
      return selected.length;
    }
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.agentId !== agentId || proposal.revision !== revision) throw new Error("Proposal is unavailable or changed.");
    if (new Set(selected.map((c) => c.id)).size !== selected.length || selected.some((c) => !proposal.candidates.some((p) => p.id === c.id))) throw new Error("Invalid candidate selection.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO confirmations VALUES (?, ?)").run(confirmationId, payload);
      const insert = this.db.prepare("INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?)");
      for (const c of selected) insert.run(randomUUID(), c.text, c.scope.kind, c.scope.id, proposal.source, confirmationId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.proposals.delete(id);
    return selected.length;
  }
  lookup(scopes: Scope[]) {
    if (!this.db) throw new Error("Database path has not been configured.");
    const stmt = this.db.prepare("SELECT id, text, scope_kind, scope_id, source FROM memories WHERE scope_kind = ? AND scope_id = ?");
    const found = new Map<string, unknown>();
    for (const scope of scopes) for (const row of stmt.all(scope.kind, scope.id)) found.set(String(row.id), { id: row.id, text: row.text, scope: { kind: row.scope_kind, id: row.scope_id }, source: row.source });
    return memoriesSchema.parse([...found.values()]);
  }
  close() { this.db?.close(); }
}
