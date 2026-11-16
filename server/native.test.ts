import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeReview } from "./native.ts";
import { proposalSchema } from "../shared/contracts.ts";

function proposal(count = 2, id = "proposal") {
  return proposalSchema.parse({ id, revision: 1, agentId: "agent", context: { agentId: "agent", serverId: "host", workspaceId: "workspace", projectId: "project", cwd: null, workspaceName: null }, source: { role: "user_message", excerpt: "source", locator: { agentId: "agent", serverId: "host", projection: "projected", epoch: "epoch", seqStart: 1, seqEnd: 1, hash: "hash" } }, candidates: Array.from({ length: count }, (_, i) => ({ id: String(i), text: `문구 ${i}`, scope: { kind: "project", id: "project" } })) });
}
function beforeInput(provider: "codex" | "claude", next: any) {
  const q = next.arguments.questions[0];
  if (provider === "codex") return { questions: [{ id: "0", header: "Question 1", question: q.title, options: q.options.map((label: string) => ({ label })), isOther: true }] };
  return { questions: [{ ...q, allowOther: true }] };
}
async function answer(review: NativeReview, provider: "codex" | "claude", id: string, requestId: string, value: string, options?: { response?: any }) {
  const view = await review.status("host", "agent", id, 1);
  assert.ok("next" in view && view.next);
  const input = beforeInput(provider, view.next);
  assert.equal(review.before("host", "agent", { id: requestId, provider, name: view.next.tool, kind: "question", input }), true);
  const response = options?.response ?? { behavior: "allow", updatedInput: { answers: { [provider === "codex" ? "Question 1" : "기억 선택"]: value } } };
  const processing = review.after("host", "agent", provider, requestId, response, {});
  assert.ok(processing);
  await processing;
  return review.status("host", "agent", id, 1);
}

for (const provider of ["codex", "claude"] as const) {
  test(`${provider}: bulk and individual approvals complete once without partial commit`, async () => {
    const completed: any[] = [];
    const review = new NativeReview(async (input) => { completed.push(input); return { status: "committed" }; });
    review.start(proposal(5), provider);
    let view = await review.status("host", "agent", "proposal", 1);
    assert.ok("next" in view && view.next);
    const firstQuestion = JSON.stringify(view.next.arguments);
    for (let i = 0; i < 4; i++) assert.ok(firstQuestion.includes(`문구 ${i}`));
    assert.equal(firstQuestion.includes("문구 4"), false);
    view = await answer(review, provider, "proposal", "r1", "표시 항목 모두 저장");
    assert.equal(completed.length, 0);
    view = await answer(review, provider, "proposal", "r2", "후보별 검토");
    assert.equal(completed.length, 0);
    view = await answer(review, provider, "proposal", "r3", "이 문구와 범위로 저장");
    assert.equal(view.status, "committed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].selected.length, 5);
    assert.equal(completed[0].finalRequestId, "r3");
    assert.equal(review.after("host", "agent", provider, "r3", { behavior: "allow" }, {}), false);
  });
}

test("edited text is confirmed exactly, then scope change and skip", async () => {
  const completed: any[] = [];
  const review = new NativeReview(async (input) => { completed.push(input); return { status: "committed" }; });
  review.start(proposal(), "claude");
  await answer(review, "claude", "proposal", "r1", "후보별 검토");
  await answer(review, "claude", "proposal", "r2", "문구 수정");
  const text = "저장 안 함,\n두 번째 줄";
  let view = await answer(review, "claude", "proposal", "r3", text);
  assert.ok("next" in view && view.next);
  assert.ok(JSON.stringify(view.next.arguments).includes("저장 안 함,\\n두 번째 줄"));
  assert.equal(completed.length, 0);
  await answer(review, "claude", "proposal", "r4", "범위 변경");
  await answer(review, "claude", "proposal", "r5", "이 호스트 전체에 저장");
  view = await answer(review, "claude", "proposal", "r6", "이 후보 선택 안 함");
  assert.equal(view.status, "committed");
  assert.equal(completed[0].selected[0].text, text);
  assert.deepEqual(completed[0].selected[0].scope, { kind: "host", id: "host" });
  assert.equal(completed[0].selected.length, 1);
});

test("unmatched, altered, duplicate and late events never approve", async () => {
  let calls = 0;
  const review = new NativeReview(async () => { calls++; return { status: "committed" }; });
  review.start(proposal(), "codex");
  const view = await review.status("host", "agent", "proposal", 1);
  assert.ok("next" in view && view.next);
  const input = beforeInput("codex", view.next);
  const request = { id: "r1", provider: "codex", name: "request_user_input_async", kind: "question", input };
  assert.equal(review.after("host", "agent", "codex", "orphan", { behavior: "allow" }, {}), false);
  assert.equal(review.before("host", "agent", { ...request, id: "orphan" }), false);
  assert.equal(review.before("host", "other", request), false);
  assert.equal(review.before("host", "agent", { ...request, provider: "claude" }), false);
  const altered = structuredClone(input); altered.questions[0].options.reverse();
  assert.equal(review.before("host", "agent", { ...request, input: altered }), false);
  assert.equal(review.before("host", "agent", request), true);
  assert.equal(review.before("host", "agent", { ...request, id: "r2" }), false);
  assert.equal(review.after("host", "agent", "codex", "wrong", { behavior: "allow" }, {}), false);
  const processing = review.after("host", "agent", "codex", "r1", { behavior: "allow", updatedInput: { answers: { "Question 1": "기타" } } }, {});
  assert.ok(processing);
  await processing;
  assert.equal((await review.status("host", "agent", "proposal", 1)).status, "result_unknown");
  assert.equal(review.after("host", "agent", "codex", "r1", { behavior: "allow" }, {}), false);
  assert.equal(calls, 0);
});

test("deny, missing answer and callback failure do not claim commit", async () => {
  const denied = new NativeReview(async () => ({ status: "committed" }));
  denied.start(proposal(), "codex");
  assert.equal((await answer(denied, "codex", "proposal", "r1", "", { response: { behavior: "deny" } })).status, "canceled");
  const missing = new NativeReview(async () => ({ status: "committed" }));
  missing.start(proposal(), "codex");
  assert.equal((await answer(missing, "codex", "proposal", "r1", "", { response: { behavior: "allow", updatedInput: { answers: {} } } })).status, "result_unknown");
  const failed = new NativeReview(async () => { throw new Error("unknown outcome"); });
  failed.start(proposal(), "codex");
  assert.equal((await answer(failed, "codex", "proposal", "r1", "표시 항목 모두 저장")).status, "result_unknown");
});

test("status waits for already registered processing and callback runs once", async () => {
  let finish!: (value: { status: "committed" }) => void;
  let calls = 0;
  const review = new NativeReview(async () => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  review.start(proposal(), "codex");
  const view = await review.status("host", "agent", "proposal", 1);
  assert.ok("next" in view && view.next);
  assert.equal(review.before("host", "agent", { id: "r1", provider: "codex", name: "request_user_input_async", kind: "question", input: beforeInput("codex", view.next) }), true);
  const processing = review.after("host", "agent", "codex", "r1", { behavior: "allow", updatedInput: { answers: { "Question 1": "표시 항목 모두 저장" } } }, {});
  assert.ok(processing);
  const waiting = review.status("host", "agent", "proposal", 1);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish({ status: "committed" });
  await processing;
  assert.equal((await waiting).status, "committed");
  assert.equal(calls, 1);
});

test("aborted signal prevents starting completion", async () => {
  let calls = 0;
  const review = new NativeReview(async () => { calls++; return { status: "committed" }; });
  review.start(proposal(), "codex");
  const view = await review.status("host", "agent", "proposal", 1);
  assert.ok("next" in view && view.next);
  assert.equal(review.before("host", "agent", { id: "r1", provider: "codex", name: "request_user_input_async", kind: "question", input: beforeInput("codex", view.next) }), true);
  const controller = new AbortController();
  controller.abort();
  const processing = review.after("host", "agent", "codex", "r1", { behavior: "allow", updatedInput: { answers: { "Question 1": "표시 항목 모두 저장" } } }, {}, controller.signal);
  assert.ok(processing);
  await processing;
  assert.equal((await review.status("host", "agent", "proposal", 1)).status, "result_unknown");
  assert.equal(calls, 0);
});
