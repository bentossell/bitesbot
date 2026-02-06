# Size Reduction Proposal (No Feature Cuts)

This plan consolidates modules and removes duplication while preserving all current functionality and persistence.

## 1) `src/bridge/*` → 2 files

**Current:** 5,143 LOC across 15 files.

**Plan:**
- **`bridge.ts`** (main): merge
  - `jsonl-bridge.ts`
  - `subagent-commands.ts`
  - `subagent-registry.ts`
  - `command-queue.ts`
  - `sendfile.ts`
  - `normalize.ts`
  - `memory-sync.ts`
  - `auto-memory-flush.ts`
  - `session-tools.ts`
  - `manifest.ts`
- **`bridge-session.ts`** (runtime): merge
  - `jsonl-session.ts`
  - `env-file.ts`
  - `session-store.ts` (if only used by bridge)

**Dedupe targets:**
- Single command routing table for `/new`, `/spawn`, `/cron`, `/sessions_*`.
- Remove parse/format/reply helpers that duplicate logic in `jsonl-bridge`.
- Dead-code check: `sessions-tools.ts` + `session-registry.ts` appear unused; if confirmed, remove (≈52 LOC).

**Expected reduction:** ~900–1,300 LOC.

---

## 2) `src/gateway/*` → 1 file

**Current:** 1,167 LOC across 7 files.

**Plan:**
- Merge `server.ts`, `config.ts`, `auth.ts`, `normalize.ts`, `telegram-markdown.ts`, `telegram-renderer.ts`, `media.ts` into **`gateway.ts`**.
- Deduplicate `downloadTelegramFile` (exists in both `server.ts` and `media.ts`).

**Expected reduction:** ~150–250 LOC.

---

## 3) `src/cron/*` → 1 file

**Current:** 771 LOC across 6 files.

**Plan:**
- Merge `service.ts`, `scheduler.ts`, `store.ts`, `run-history.ts`, `types.ts`, `index.ts` into **`cron.ts`**.
- Inline `store` and `run-history` helpers into `CronService`.

**Expected reduction:** ~120–180 LOC.

---

## 4) `src/workspace/*` → 2 files

**Current:** 1,156 LOC across 9 files.

**Plan:**
- **`workspace.ts`**: merge `links.ts`, `links-index.ts`, `concepts.ts`, `concepts-index.ts`, `path-utils.ts`, `boot-context.ts`.
- **`workspace-cli.ts`**: merge `links-cli.ts` + `concepts-cli.ts`.

**Dedupe target:** shared index read/write logic between links and concepts.

**Expected reduction:** ~200–300 LOC.

---

## 5) `src/memory/*` → 1 file

**Current:** 467 LOC across 4 files.

**Plan:**
- Merge `tools.ts`, `recall.ts`, `qmd-client.ts`, `types.ts` into **`memory.ts`**.
- Inline `types.ts` and shared prompt formatting helpers.

**Expected reduction:** ~40–80 LOC.

---

## 6) `src/daemon/*` → 1 file

**Current:** 323 LOC across 3 files.

**Plan:**
- Merge `cli.ts`, `run.ts`, `pid.ts` into **`daemon.ts`**.
- Inline `runGateway` in CLI to remove indirection.

**Expected reduction:** ~30–50 LOC.

---

## 7) `src/protocol/*` → 1 file

**Current:** 157 LOC across 2 files.

**Plan:**
- Merge `normalized.ts` into `types.ts` if only used by gateway/bridge.

**Expected reduction:** ~20–30 LOC.

---

## Estimated Total Reduction

- **Conservative:** ~1,460 LOC
- **Aggressive:** ~2,190 LOC

This reduces the codebase from ~9,556 LOC to ~7,300–8,100 LOC without cutting any functionality.
