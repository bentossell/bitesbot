import { sessionRegistry, type SessionRecord } from "./session-registry.js"

export type SessionsListResult = Array<{ id: string; name: string; status: string; startedAt: string; lastMessageAt: string; messageCount: number }>
export type SessionsHistoryResult = Array<{ role: string; content: string; timestamp: string }>
export type SessionsSendResult = { sent: boolean; reply?: string; error?: string }

export const isSessionsTool = (n: string): boolean => ["sessions_list", "sessions_history", "sessions_send"].includes(n)

const findSession = (x: string): SessionRecord | undefined => sessionRegistry.get(x) || sessionRegistry.findByName(x) || sessionRegistry.list({ includeCompleted: true }).find((s: SessionRecord) => s.id.startsWith(x))

export const handleSessionsList = (p: { include_completed?: boolean }): SessionsListResult => sessionRegistry.list({ includeCompleted: p.include_completed }).map((s: SessionRecord) => ({ id: s.id, name: s.name, status: s.status, startedAt: new Date(s.startedAt).toISOString(), lastMessageAt: new Date(s.lastMessageAt).toISOString(), messageCount: s.messageCount }))

export const handleSessionsHistory = (p: { session_id: string; limit?: number }): SessionsHistoryResult | { error: string } => { const s = findSession(p.session_id); if (!s) return { error: "Session not found: " + p.session_id }; return sessionRegistry.getHistory(s.id, { limit: p.limit ?? 50 }).map((m: { role: string; content: string; timestamp: number }) => ({ role: m.role, content: m.content, timestamp: new Date(m.timestamp).toISOString() })) }

export const handleSessionsSend = async (p: { session_id: string; message: string; wait_for_reply?: boolean; timeout_ms?: number }, from: string): Promise<SessionsSendResult> => { const s = findSession(p.session_id); if (!s) return { sent: false, error: "Session not found: " + p.session_id }; if (s.status !== "active") return { sent: false, error: "Session is not active: " + s.status }; if (p.wait_for_reply) { try { const r = await Promise.race([sessionRegistry.queueMessage(s.id, from, p.message), new Promise<string | undefined>((_, rej) => setTimeout(() => rej(new Error("Timeout")), p.timeout_ms ?? 30000))]); return { sent: true, reply: r } } catch (e) { return { sent: true, error: e instanceof Error ? e.message : "Error" } } } void sessionRegistry.queueMessage(s.id, from, p.message); return { sent: true } }

export const handleSessionsTool = async (n: string, p: Record<string, unknown>, from: string): Promise<unknown> => { if (n === "sessions_list") return handleSessionsList(p as { include_completed?: boolean }); if (n === "sessions_history") return handleSessionsHistory(p as { session_id: string; limit?: number }); if (n === "sessions_send") return handleSessionsSend(p as { session_id: string; message: string; wait_for_reply?: boolean; timeout_ms?: number }, from); return { error: "Unknown tool: " + n } }

export const formatPendingMessagesForInjection = (id: string): string | null => { const p = sessionRegistry.getPendingMessages(id); if (p.length === 0) return null; return ["[Cross-session messages received:]", ...p.map((x: { from: string; message: string }) => "From " + x.from + ": " + x.message)].join("\n") }
