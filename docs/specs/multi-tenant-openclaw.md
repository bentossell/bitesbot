# Spec: Multi-Tenant OpenClaw Gateway (Bitesbot Extension)

## Purpose
Extend the existing Telegram Gateway + JSONL bridge into a multi-tenant OpenClaw service that lets users provision bots with cloud tools (Gmail, Docs, Web, X/Twitter), long-term memory, and a server-side working directory. All tenants are isolated in data, auth, and execution.

## Goals
- Multi-tenant isolation with per-tenant config, storage, memory, and tool permissions.
- Unified tool layer for Gmail/Docs/Web/X accessible to agents.
- Server-side working directory per tenant.
- Simple provisioning and ops endpoints.
- Backwards-compatible single-tenant behavior.

## Non-Goals
- Full billing implementation (can add hooks).
- Building UIs (admin console optional stub).
- Replacing Telegram as the primary client.

---

## 1) Architecture

### Current
- `gateway/` handles Telegram + HTTP/WS.
- `bridge/` spawns CLI agents and manages sessions.
- `memory/` qmd-based recall.

### Target
- Add Tenant Registry and Tool Router.
- Every inbound message resolves to a `tenantId`.
- All agent sessions run with tenant-scoped:
  - working directory
  - memory config
  - tool permissions
  - OAuth tokens (if any)

---

## 2) Tenant Model

### Tenant identity
- `tenantId` (string)
- `name`
- `status` (active, suspended)
- `createdAt`, `updatedAt`

### Tenant config
- `allowedChatIds`
- `defaultCli`
- `subagentFallbackCli`
- `toolsEnabled` (gmail, docs, web, x, memory, files)
- `limits` (messages/day, tool calls/day, max storage)
- `workspaceDir`
- `memoryDir`
- `oauth` references (by provider)

### Storage
- Start with JSON/SQLite file in `~/.config/tg-gateway/tenants.json`
- Pluggable interface so it can move to DB later

---

## 3) Working Directory

- `~/bites/tenants/<tenantId>/workspace`
- Use per-tenant folder for read/write, file attachments, and tool outputs
- Cleanups scoped to tenant paths only

---

## 4) Memory Isolation

- Memory per tenant (qmd index + collection)
- `workspaceDir` and qmd index path are tenant-scoped
- No cross-tenant recall

---

## 5) Tool Layer

Introduce a bridge-side Tool Router that can execute.

### Common interface
```
ToolCall {
  tenantId
  tool: 'gmail_search' | 'gmail_read' | 'docs_search' | 'docs_read' | 'web_search' | 'x_read'
  args: {...}
}
ToolResult { ok, data, error }
```

### Providers
- Gmail/Docs: OAuth tokens per tenant.
- Web: search via configurable provider (stub at first).
- X/Twitter: use `bird` CLI or API credentials.

### Execution
- Tool calls run server-side from the bridge.
- Enforced allowlist per tenant.
- Tool usage is logged and rate-limited.

---

## 6) API + Command Surface

### Provisioning endpoints (HTTP)
- `POST /tenants` create
- `GET /tenants/:id`
- `PATCH /tenants/:id`
- `POST /tenants/:id/oauth/:provider` (save tokens)
- `POST /tenants/:id/limits`

### Telegram commands
- `/status` now includes tenant info.
- `/tools` shows enabled tools.
- Optional `/tenant` for debugging (admin only).

---

## 7) Message Flow (End-to-End)

1) Telegram update arrives
2) Resolve `tenantId` via `allowedChatIds` map
3) Load tenant config
4) Bridge spawns session using tenant workspace + memory config
5) Agent may call tools (router validates permissions)
6) Responses delivered to chat with normal Telegram rendering

---

## 8) Security & Isolation

- Strict mapping of chat -> tenant
- Per-tenant tool permissions and OAuth tokens
- No file path traversal across tenant directories
- Audit logging of tool calls + outputs
- PII-safe logging configuration option

---

## 9) Backwards Compatibility

- If no tenant registry exists, default to single tenant using existing config values.
- Existing environment variables remain valid.

---

## 10) Configuration Changes

### GatewayConfig extended
- `tenantsPath` (path to registry file)
- `singleTenantFallback: true` (default)

### BridgeConfig per tenant
- `workingDirectory`, `memory`, `defaultCli`, `toolsEnabled`

---

## 11) Migration Plan

### Phase 1: Minimal Multi-Tenant
- Tenant registry + resolver
- Per-tenant workspace/memory
- Tools disabled by default

### Phase 2: Tool Router
- Add `web_search`, `x_read` (via `bird`)
- OAuth storage scaffolding (gmail/docs stub)

### Phase 3: Full Connectors
- Gmail/Docs with OAuth
- Rate limiting + quotas
- Admin endpoint hardening

---

## 12) Testing

### Unit
- Tenant resolver
- Tool permission checks
- Path isolation

### Integration
- Two tenants; verify no memory leakage
- Tool call blocked when disabled
- Workspace file isolation

### E2E
- Provision tenant -> send Telegram message -> verify workspace output
- OAuth token use (stubbed)

---

## 13) Open Questions

- Tenant mapping: chat == tenant or multiple chats per tenant?
- Storage: JSON/SQLite vs Postgres?
- Web search provider?
- X via `bird` or API tokens?
