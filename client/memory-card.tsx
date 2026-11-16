import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { cancelProposal, confirmProposal, getProposal, type cardSchema, type candidateSchema, type proposalSchema } from "../shared/contracts.ts";
import type { z } from "zod";

type Card = z.infer<typeof cardSchema>;
type Proposal = z.infer<typeof proposalSchema>;
type Candidate = z.infer<typeof candidateSchema>;

export function MemoryCard({ agentId, item, theme, layout }: PluginTimelineItemProps<Card>) {
  const get = useRpc(getProposal), confirm = useRpc(confirmProposal), cancel = useRpc(cancelProposal);
  const data = item.data;
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [kinds, setKinds] = useState<Record<string, "project" | "host">>({});
  const [details, setDetails] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [result, setResult] = useState<{ status: "saved" | "canceled"; selected?: Candidate[]; cardUpdated: boolean } | null>(null);
  const [message, setMessage] = useState("");
  const color = theme.colors.foreground;
  useEffect(() => {
    let active = true;
    setProposal(null); setLoaded(false); setSelected({}); setEdits({}); setKinds({}); setResult(null); setMessage("");
    if (data.status !== "pending" || data.agentId !== agentId) { setLoaded(true); return () => { active = false; }; }
    void get({ agentId, proposalId: data.proposalId, revision: data.revision }).then((value) => {
      if (active) { setProposal(value.proposal); setLoaded(true); }
    }).catch(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [agentId, data.status, data.proposalId, data.revision]);
  const display = result ?? (data.status === "saved" ? { status: "saved" as const, selected: data.selected, cardUpdated: true } : data.status === "canceled" ? { status: "canceled" as const, cardUpdated: true } : null);
  if (data.agentId !== agentId) return <Text style={{ color }}>현재 제안을 사용할 수 없습니다.</Text>;
  if (display) return <View style={{ padding: layout.compact ? 10 : 14, gap: 6 }}>
    <Text style={{ color }}>{display.status === "saved" ? "저장한 내용" : "저장 안 함"}</Text>
    {display.selected?.map((c) => <Text key={c.id} style={{ color }}>{c.text} · {c.scope.kind === "project" ? "이 프로젝트" : "이 호스트 전체"} ({c.scope.id})</Text>)}
    {!display.cardUpdated && <Text style={{ color }}>처리는 완료됐습니다. 대화 카드 갱신 여부는 확인되지 않았습니다.</Text>}
  </View>;
  if (!loaded) return <Text style={{ color }}>제안을 불러오는 중입니다.</Text>;
  if (!proposal || proposal.agentId !== agentId || proposal.id !== data.proposalId || proposal.revision !== data.revision) return <Text style={{ color }}>현재 제안을 사용할 수 없습니다.</Text>;
  const p = proposal;
  const run = async (action: () => Promise<void>) => {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(true); setMessage("처리 중입니다.");
    try { await action(); } catch (e) { setMessage(`결과 미확인 또는 오류: ${String(e)}`); }
    finally { pendingRef.current = false; setPending(false); }
  };
  return <View style={{ padding: layout.compact ? 10 : 14, gap: layout.compact ? 8 : 12 }}>
    <Text style={{ color }}>기억할 내용을 선택해 주세요</Text>
    <Text style={{ color }}>근거: {p.source.excerpt}</Text>
    <Text style={{ color }}>작업공간: {p.context.workspaceName ?? "이름 없음"} · 경로: {p.context.cwd ?? "확인되지 않음"}</Text>
    <Pressable onPress={() => setDetails(!details)}><Text style={{ color }}>{details ? "근거 상세 닫기" : "근거 상세"}</Text></Pressable>
    {details && <Text style={{ color }}>프로젝트: {p.context.projectId ?? "없음"} · 호스트: {p.context.serverId} · 버전: {p.revision} · {p.source.role} · {p.source.locator.projection} · {p.source.locator.epoch} · {p.source.locator.seqStart}–{p.source.locator.seqEnd} · 해시: {p.source.locator.hash}</Text>}
    {p.candidates.map((c, i) => <View key={c.id} style={{ gap: 6 }}>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: !!selected[c.id] }} onPress={() => setSelected((s) => ({ ...s, [c.id]: !s[c.id] }))}><Text style={{ color }}>{selected[c.id] ? "☑" : "□"} {i + 1}. {c.text}</Text></Pressable>
      <Text style={{ color }}>저장할 문구</Text>
      <TextInput multiline value={edits[c.id] ?? c.text} onChangeText={(text) => setEdits((s) => ({ ...s, [c.id]: text }))} style={{ color, borderWidth: 1, borderColor: color, padding: 8 }} />
      <Text style={{ color }}>저장 범위를 선택해 주세요</Text>
      <Pressable disabled={!p.context.projectId} accessibilityRole="radio" accessibilityState={{ checked: kinds[c.id] === "project", disabled: !p.context.projectId }} onPress={() => setKinds((s) => ({ ...s, [c.id]: "project" }))}><Text style={{ color }}>{kinds[c.id] === "project" ? "◉" : "○"} 이 프로젝트{p.context.projectId ? "" : " (사용 불가)"}</Text></Pressable>
      <Pressable accessibilityRole="radio" accessibilityState={{ checked: kinds[c.id] === "host" }} onPress={() => setKinds((s) => ({ ...s, [c.id]: "host" }))}><Text style={{ color }}>{kinds[c.id] === "host" ? "◉" : "○"} 이 호스트 전체</Text></Pressable>
    </View>)}
    <Pressable onPress={() => setSelected(Object.fromEntries(p.candidates.map((c) => [c.id, true])))}><Text style={{ color }}>모두 선택</Text></Pressable>
    <Pressable disabled={pending} onPress={() => void run(async () => {
      const choices = p.candidates.filter((c) => selected[c.id]);
      if (!choices.length) { setMessage("후보를 선택해 주세요."); return; }
      if (choices.some((c) => !kinds[c.id])) { setMessage("선택한 후보마다 범위를 선택해 주세요."); return; }
      const items = choices.map((c) => { const kind = kinds[c.id]!; return { id: c.id, text: edits[c.id] ?? c.text, scope: { kind, id: kind === "project" ? p.context.projectId ?? "" : p.context.serverId } }; });
      const response = await confirm({ agentId, proposalId: p.id, revision: p.revision, confirmationId: `${p.id}:${p.revision}`, selected: items });
      setResult({ status: "saved", selected: items, cardUpdated: response.cardUpdated });
    })}><Text style={{ color }}>선택 항목 저장</Text></Pressable>
    <Pressable disabled={pending} onPress={() => void run(async () => {
      const response = await cancel({ agentId, proposalId: p.id, revision: p.revision });
      if (response.canceled) setResult({ status: "canceled", cardUpdated: response.cardUpdated });
      else setMessage("취소되지 않았습니다. 현재 상태 확인이 필요합니다.");
    })}><Text style={{ color }}>저장 안 함</Text></Pressable>
    {!!message && <Text style={{ color }}>{message}</Text>}
  </View>;
}
