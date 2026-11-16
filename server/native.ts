import { createHash } from "node:crypto";
import { candidateSchema, proposalSchema } from "../shared/contracts.ts";
import type { z } from "zod";

type Proposal = z.infer<typeof proposalSchema>;
type Candidate = z.infer<typeof candidateSchema>;
type Provider = "codex" | "claude";
type Stage = "bulk" | "candidate" | "edit" | "range";
type Outcome = "awaiting_question" | "awaiting_response" | "processing" | "committed" | "canceled" | "failed" | "result_unknown";
type Question = { title: string; options: string[] };
type Evidence = { candidateId: string; requestId: string; stage: string; fingerprint: string };
export type FinalInput = { proposal: Proposal; selected: Candidate[]; evidence: Evidence[]; finalRequestId: string; isCurrent: () => boolean };
type Completion = { status: "committed" | "failed" | "result_unknown" };
type Request = { id: string; provider: string; name: string; kind: string; input?: unknown };
type Response = { behavior: string; updatedInput?: unknown };
type Binding = { requestId: string; fingerprint: string; stageId: string; consumed: boolean };
type State = {
  proposal: Proposal; provider: Provider; index: number; end: number; stage: Stage; sequence: number;
  items: Candidate[]; selected: Candidate[]; evidence: Evidence[]; question: Question;
  fingerprint: string; stageId: string; binding?: Binding; outcome: Outcome; processing?: Promise<void>;
};

const ALL = "표시 항목 모두 저장";
const REVIEW = "후보별 검토";
const CANCEL = "저장 안 함";
const SAVE = "이 문구와 범위로 저장";
const EDIT = "문구 수정";
const RANGE = "범위 변경";
const SKIP = "이 후보 선택 안 함";
const PROJECT = "이 프로젝트에 저장";
const HOST = "이 호스트 전체에 저장";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: unknown) { return createHash("sha256").update(stable(value)).digest("hex"); }
function scopeText(candidate: Candidate) { return `${candidate.scope.kind === "project" ? "이 프로젝트" : "이 호스트 전체"} (${candidate.scope.id})`; }
function normalized(provider: Provider, question: Question) {
  if (provider === "codex") return { questions: [{ id: "0", header: "Question 1", question: question.title, options: question.options.map((label) => ({ label })), isOther: true }] };
  return { questions: [{ question: question.title, header: "기억 선택", options: question.options.map((label) => ({ label, description: label })), multiSelect: false, allowOther: true }] };
}
function args(provider: Provider, question: Question) {
  if (provider === "codex") return { questions: [{ title: question.title, options: question.options }] };
  return { questions: [{ question: question.title, header: "기억 선택", options: question.options.map((label) => ({ label, description: label })), multiSelect: false }] };
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class NativeReview<Environment = unknown> {
  private states = new Map<string, State>();
  private requests = new Map<string, State | null>();
  private complete: (input: FinalInput, environment: Environment) => Promise<Completion>;
  constructor(complete: (input: FinalInput, environment: Environment) => Promise<Completion>) { this.complete = complete; }

  private key(serverId: string, agentId: string, provider: string, requestId: string) { return JSON.stringify([serverId, agentId, provider, requestId]); }
  private question(state: State) {
    const p = state.proposal;
    const tag = `검토 ${p.id} / 버전 ${p.revision} / 단계 ${state.sequence}`;
    const candidate = state.items[state.index]!;
    const intro = `${tag}\n작업공간: ${p.context.workspaceName ?? "이름 없음"} · 경로: ${p.context.cwd ?? "확인되지 않음"}\n모든 후보 검토가 끝나기 전에는 저장되지 않습니다.`;
    if (state.stage === "bulk") return { title: `${intro}\n${state.items.slice(state.index, state.end).map((c, i) => `${state.index + i + 1}. ${c.text}\n범위: ${scopeText(c)}`).join("\n\n")}`, options: [ALL, REVIEW, CANCEL] };
    const detail = `${intro}\n${state.index + 1}. ${candidate.text}\n범위: ${scopeText(candidate)}`;
    if (state.stage === "edit") return { title: `${detail}\n문구 수정은 기타/직접입력란에 입력해 주세요. 다음 질문에서 입력한 문구를 확인합니다.`, options: ["수정 문구 입력", "다음 질문에서 확인"] };
    if (state.stage === "range") return { title: `${detail}\n저장할 범위를 선택해 주세요.`, options: [...(p.context.projectId ? [PROJECT] : []), HOST, SKIP] };
    return { title: detail, options: [SAVE, EDIT, RANGE, SKIP] };
  }
  private prepare(state: State) {
    state.sequence++;
    state.stageId = `${state.proposal.id}:${state.proposal.revision}:${state.sequence}`;
    state.question = this.question(state);
    state.fingerprint = digest({ provider: state.provider, stageId: state.stageId, input: normalized(state.provider, state.question) });
    state.binding = undefined;
    state.outcome = "awaiting_question";
  }
  start(proposal: Proposal, provider: string) {
    if (provider !== "codex" && provider !== "claude") throw new Error("Unsupported provider.");
    const parsed = proposalSchema.parse(proposal);
    if (this.states.has(parsed.id)) throw new Error("Proposal already has a review.");
    const state: State = { proposal: parsed, provider, index: 0, end: Math.min(4, parsed.candidates.length), stage: "bulk", sequence: 0, items: parsed.candidates.map((c) => candidateSchema.parse(c)), selected: [], evidence: [], question: { title: "", options: [] }, fingerprint: "", stageId: "", outcome: "awaiting_question" };
    this.prepare(state);
    this.states.set(parsed.id, state);
    return this.view(state);
  }
  private view(state: State) {
    const next = state.outcome === "awaiting_question" ? { tool: state.provider === "codex" ? "request_user_input_async" : "AskUserQuestion", arguments: args(state.provider, state.question), stage: state.stageId } : undefined;
    const saved = state.outcome === "committed" ? { count: state.selected.length, selected: state.selected.map((c) => ({ ...c, scope: { ...c.scope } })) } : {};
    return { proposalId: state.proposal.id, revision: state.proposal.revision, status: state.outcome, ...saved, ...(next ? { next } : {}) };
  }
  async status(serverId: string, agentId: string, proposalId: string, revision: number) {
    const state = this.states.get(proposalId);
    if (!state || state.proposal.revision !== revision || state.proposal.agentId !== agentId || state.proposal.context.serverId !== serverId) return { status: "unavailable" as const };
    if (state.processing) await state.processing;
    return this.view(state);
  }
  before(serverId: string, agentId: string, request: Request) {
    if (request.provider !== "codex" && request.provider !== "claude") return false;
    const provider = request.provider;
    if (request.kind !== "question" || request.name !== (provider === "codex" ? "request_user_input_async" : "AskUserQuestion")) return false;
    const key = this.key(serverId, agentId, provider, request.id);
    if (this.requests.has(key)) return false;
    const matches = [...this.states.values()].filter((s) => s.outcome === "awaiting_question" && s.provider === provider && s.proposal.agentId === agentId && s.proposal.context.serverId === serverId && stable(request.input) === stable(normalized(provider, s.question)));
    if (matches.length !== 1) return false;
    const state = matches[0]!;
    state.binding = { requestId: request.id, fingerprint: state.fingerprint, stageId: state.stageId, consumed: false };
    state.outcome = "awaiting_response";
    this.requests.set(key, state);
    return true;
  }
  after(serverId: string, agentId: string, provider: string, requestId: string, response: Response, environment: Environment, signal?: AbortSignal) {
    const key = this.key(serverId, agentId, provider, requestId);
    const state = this.requests.get(key);
    if (state === undefined) this.requests.set(key, null);
    const binding = state?.binding;
    if (!state || !binding || binding.requestId !== requestId || binding.consumed || state.outcome !== "awaiting_response" || binding.stageId !== state.stageId || binding.fingerprint !== state.fingerprint) return false;
    binding.consumed = true;
    state.outcome = "processing";
    const processing = Promise.resolve().then(() => this.consume(state, binding, response, environment, signal));
    state.processing = processing;
    return processing.then(() => {
      if (state.processing === processing) state.processing = undefined;
      return this.view(state);
    });
  }
  private async consume(state: State, binding: Binding, response: Response, environment: Environment, signal?: AbortSignal) {
    if (response.behavior === "deny") { state.outcome = "canceled"; return; }
    const updated = object(response.updatedInput);
    const answers = object(updated?.answers);
    const question = state.question;
    const expectedKey = state.provider === "codex" ? "Question 1" : "기억 선택";
    if (response.behavior !== "allow" || !answers || Object.keys(answers).length !== 1 || typeof answers[expectedKey] !== "string") { state.outcome = "result_unknown"; return; }
    if (updated?.questions !== undefined && stable(updated.questions) !== stable(normalized(state.provider, question).questions)) { state.outcome = "result_unknown"; return; }
    const answer = answers[expectedKey] as string;
    if (!answer.trim()) { state.outcome = "result_unknown"; return; }
    if (state.stage !== "edit" && !question.options.includes(answer)) { state.outcome = "result_unknown"; return; }
    const record = (candidate: Candidate) => { state.selected.push({ ...candidate, scope: { ...candidate.scope } }); state.evidence.push({ candidateId: candidate.id, requestId: binding.requestId, stage: binding.stageId, fingerprint: binding.fingerprint }); };
    if (state.stage === "bulk") {
      if (answer === CANCEL) { state.outcome = "canceled"; return; }
      if (answer === ALL) { for (const item of state.items.slice(state.index, state.end)) record(item); state.index = state.end; }
      else { state.stage = "candidate"; this.prepare(state); return; }
    } else if (state.stage === "edit") {
      state.items[state.index] = { ...state.items[state.index]!, text: answer };
      state.stage = "candidate"; this.prepare(state); return;
    } else if (state.stage === "range") {
      const candidate = state.items[state.index]!;
      if (answer !== SKIP) {
        const kind = answer === PROJECT ? "project" : "host";
        const id = kind === "project" ? state.proposal.context.projectId : state.proposal.context.serverId;
        if (!id) { state.outcome = "result_unknown"; return; }
        record({ ...candidate, scope: { kind, id } });
      }
      state.index++;
    } else {
      if (answer === EDIT) { state.stage = "edit"; this.prepare(state); return; }
      if (answer === RANGE) { state.stage = "range"; this.prepare(state); return; }
      if (answer === SAVE) record(state.items[state.index]!);
      state.index++;
    }
    if (state.index < state.end) { state.stage = "candidate"; this.prepare(state); return; }
    if (state.index < state.items.length) { state.end = Math.min(state.index + 4, state.items.length); state.stage = "bulk"; this.prepare(state); return; }
    if (!state.selected.length) { state.outcome = "canceled"; return; }
    if (signal?.aborted) { state.outcome = "result_unknown"; return; }
    try {
      const result = await this.complete({ proposal: state.proposal, selected: state.selected.map((c) => candidateSchema.parse(c)), evidence: state.evidence.map((e) => ({ ...e })), finalRequestId: binding.requestId, isCurrent: () => state.outcome === "processing" && state.binding === binding && binding.consumed && state.stageId === binding.stageId }, environment);
      state.outcome = result.status;
    } catch { state.outcome = "result_unknown"; }
  }
}
