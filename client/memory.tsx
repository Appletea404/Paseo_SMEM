import { useRpc, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { cancelProposal, confirmProposal, getProposals, setDatabase, type proposalSchema } from "../shared/contracts.ts";
import type { z } from "zod";

type Proposal = z.infer<typeof proposalSchema>;
export function MemoryPanel({ agentId, theme, layout }: PluginAgentPanelProps) {
  const get = useRpc(getProposals), configure = useRpc(setDatabase), cancel = useRpc(cancelProposal), confirm = useRpc(confirmProposal);
  const [path, setPath] = useState("");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [scopeKinds, setScopeKinds] = useState<Record<string, "project" | "host">>({});
  const [message, setMessage] = useState("DB 경로가 설정되지 않았습니다.");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const currentAgent = useRef(agentId);
  const generation = useRef(0);
  if (currentAgent.current !== agentId) { currentAgent.current = agentId; generation.current++; }
  const currentGeneration = generation.current;
  useEffect(() => { setProposals([]); setSelected({}); setEdits({}); setScopeKinds({}); }, [agentId]);
  const color = theme.colors.foreground;
  const refresh = async () => { if (agentId) { const result = await get({ agentId }); if (generation.current === currentGeneration) setProposals(result.proposals); } };
  const action = async (fn: () => Promise<void>) => { try { await fn(); } catch (e) { setMessage(`결과 미확인 또는 오류: ${String(e)}`); } };
  const submit = async (fn: () => Promise<string>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setMessage("요청 처리 중입니다.");
    try {
      const result = await fn();
      if (generation.current === currentGeneration) setMessage(result);
      try { await refresh(); } catch { if (generation.current === currentGeneration) setMessage(`${result} 후보 목록 갱신에 실패했습니다.`); }
    } catch (e) { if (generation.current === currentGeneration) setMessage(`결과 미확인 또는 오류: ${String(e)}`); }
    finally { pendingRef.current = false; setPending(false); }
  };
  return <ScrollView style={{ backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 12 : 16, gap: layout.compact ? 8 : 12 }}>
    <Text style={{ color }}>운영 DB의 절대 경로를 지정해 주세요. 지정 후 열립니다.</Text>
    <TextInput value={path} onChangeText={setPath} placeholder="DB 절대 경로" placeholderTextColor={color} style={{ color, borderWidth: 1, borderColor: color, padding: 8 }} />
    <Pressable onPress={() => void action(async () => { await configure({ path }); setMessage("DB 경로가 설정되었습니다."); })}><Text style={{ color }}>DB 열기</Text></Pressable>
    <Pressable onPress={() => void action(refresh)}><Text style={{ color }}>후보 새로고침</Text></Pressable>
    <Text style={{ color }}>{message}</Text>
    {proposals.filter((p) => p.context.agentId === agentId).map((p) => <View key={p.id} style={{ gap: 8, paddingVertical: 12 }}>
      <Text style={{ color }}>에이전트: {p.context.agentId} · 호스트: {p.context.serverId} · 작업공간: {p.context.workspaceId} · 프로젝트: {p.context.projectId ?? "없음"}</Text>
      <Text style={{ color }}>경로: {p.context.cwd ?? "없음"} · 버전: {p.revision}</Text>
      <Text style={{ color }}>근거: {p.source.role} · {p.source.locator.projection} · {p.source.locator.epoch} · {p.source.locator.seqStart}–{p.source.locator.seqEnd}</Text>
      <Text style={{ color }}>메시지 ID: {p.source.locator.messageId ?? "없음"} · 클라이언트 ID: {p.source.locator.clientMessageId ?? "없음"} · 해시: {p.source.locator.hash}</Text>
      <Text style={{ color }}>{p.source.excerpt}</Text>
      {p.candidates.map((c) => <View key={c.id} style={{ gap: 4 }}>
        <Pressable onPress={() => setSelected((s) => ({ ...s, [`${p.id}:${c.id}`]: !s[`${p.id}:${c.id}`] }))}><Text style={{ color }}>{selected[`${p.id}:${c.id}`] ? "☑" : "□"} 선택</Text></Pressable>
        <TextInput multiline value={edits[`${p.id}:${c.id}`] ?? c.text} onChangeText={(text) => setEdits((s) => ({ ...s, [`${p.id}:${c.id}`]: text }))} style={{ color, borderWidth: 1, borderColor: color, padding: 8 }} />
        <Pressable onPress={() => setScopeKinds((s) => ({ ...s, [`${p.id}:${c.id}`]: (s[`${p.id}:${c.id}`] ?? c.scope.kind) === "project" ? "host" : "project" }))}><Text style={{ color }}>범위: {scopeKinds[`${p.id}:${c.id}`] ?? c.scope.kind} (누르면 변경) · {(scopeKinds[`${p.id}:${c.id}`] ?? c.scope.kind) === "project" ? p.context.projectId ?? "사용 불가" : p.context.serverId}</Text></Pressable>
      </View>)}
      <Pressable onPress={() => setSelected((s) => ({ ...s, ...Object.fromEntries(p.candidates.map((c) => [`${p.id}:${c.id}`, true])) }))}><Text style={{ color }}>모두 선택</Text></Pressable>
      <Pressable disabled={pending} onPress={() => void submit(async () => {
        if (!agentId) throw new Error("에이전트가 없습니다.");
        const items = p.candidates.filter((c) => selected[`${p.id}:${c.id}`]).map((c) => { const kind = scopeKinds[`${p.id}:${c.id}`] ?? c.scope.kind; return { ...c, text: edits[`${p.id}:${c.id}`] ?? c.text, scope: { kind, id: kind === "project" ? p.context.projectId ?? "" : p.context.serverId } }; });
        if (!items.length) throw new Error("후보를 선택해 주세요.");
        const confirmationId = `${p.id}:${p.revision}`;
        await confirm({ agentId, proposalId: p.id, revision: p.revision, confirmationId, selected: items });
        return "선택한 기억이 저장되었습니다.";
      })}><Text style={{ color }}>선택 항목 저장</Text></Pressable>
      <Pressable disabled={pending} onPress={() => void submit(async () => {
        if (!agentId) throw new Error("에이전트가 없습니다.");
        const result = await cancel({ agentId, proposalId: p.id, revision: p.revision });
        return result.canceled ? "취소했습니다(이번 취소로 저장 없음)." : "취소되지 않음: 현재 상태 확인이 필요합니다.";
      })}><Text style={{ color }}>저장 안 함</Text></Pressable>
    </View>)}
  </ScrollView>;
}
