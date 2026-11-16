import { useRpc, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput } from "react-native";
import { setDatabase } from "../shared/contracts.ts";

export function MemoryPanel({ theme, layout }: PluginAgentPanelProps) {
  const configure = useRpc(setDatabase);
  const [path, setPath] = useState("");
  const [message, setMessage] = useState("DB 경로가 설정되지 않았습니다.");
  const color = theme.colors.foreground;
  return <ScrollView style={{ backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 12 : 16, gap: layout.compact ? 8 : 12 }}>
    <Text style={{ color }}>운영 DB의 절대 경로를 지정해 주세요. 지정 후 열립니다.</Text>
    <TextInput value={path} onChangeText={setPath} placeholder="DB 절대 경로" placeholderTextColor={color} style={{ color, borderWidth: 1, borderColor: color, padding: 8 }} />
    <Pressable onPress={() => void (async () => { try { await configure({ path }); setMessage("DB 경로가 설정되었습니다."); } catch (e) { setMessage(`오류: ${String(e)}`); } })()}><Text style={{ color }}>DB 열기</Text></Pressable>
    <Text style={{ color }}>{message}</Text>
  </ScrollView>;
}
