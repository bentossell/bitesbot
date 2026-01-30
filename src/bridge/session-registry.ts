export type SessionStatus = "active" | "completed" | "error"
export type SessionRecord = { id: string; name: string; status: SessionStatus; startedAt: number; lastMessageAt: number; messageCount: number; chatId: number | string; cli?: string; error?: string }
export type SessionMessage = { id: string; role: "user" | "assistant" | "system"; content: string; timestamp: number }

class SessionRegistry {
  private sessions = new Map<string, SessionRecord>()
  private history = new Map<string, SessionMessage[]>()
  private pending = new Map<string, Array<{ message: string; from: string; resolve: (r?: string) => void }>>()

  register(o: { id: string; name: string; chatId: number | string; cli?: string }): SessionRecord {
    const r: SessionRecord = { id: o.id, name: o.name, status: "active", startedAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0, chatId: o.chatId, cli: o.cli }
    this.sessions.set(o.id, r); this.history.set(o.id, []); return r
  }
  markCompleted(id: string, e?: string): void { const r = this.sessions.get(id); if (!r) return; r.status = e ? "error" : "completed"; if (e) r.error = e }
  recordMessage(id: string, m: Omit<SessionMessage, "id">): void { const r = this.sessions.get(id); if (!r) return; const msg: SessionMessage = { ...m, id: id + "-" + Date.now() }; const h = this.history.get(id) || []; h.push(msg); this.history.set(id, h); r.messageCount++; r.lastMessageAt = m.timestamp }
  get(id: string): SessionRecord | undefined { return this.sessions.get(id) }
  findByName(n: string): SessionRecord | undefined { for (const r of this.sessions.values()) if (r.name === n) return r; return undefined }
  list(o?: { includeCompleted?: boolean }): SessionRecord[] { const a = Array.from(this.sessions.values()); if (o?.includeCompleted) return a.sort((x, y) => y.lastMessageAt - x.lastMessageAt); return a.filter((r: SessionRecord) => r.status === "active").sort((x, y) => y.lastMessageAt - x.lastMessageAt) }
  getHistory(id: string, o?: { limit?: number }): SessionMessage[] { let a = [...(this.history.get(id) || [])]; if (o?.limit) a = a.slice(-o.limit); return a }
  queueMessage(to: string, from: string, msg: string): Promise<string | undefined> { return new Promise(res => { const p = this.pending.get(to) || []; p.push({ message: msg, from, resolve: res }); this.pending.set(to, p) }) }
  getPendingMessages(id: string): Array<{ message: string; from: string; resolve: (r?: string) => void }> { const p = this.pending.get(id) || []; this.pending.delete(id); return p }
  hasPendingMessages(id: string): boolean { return (this.pending.get(id)?.length || 0) > 0 }
}

export const sessionRegistry = new SessionRegistry()
