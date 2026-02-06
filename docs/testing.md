---
summary: "How to run tests: unit, e2e, and what each covers"
read_when:
  - Running tests locally
  - Adding new tests
  - Debugging test failures
  - Setting up E2E environment
---

# Testing — bitesbot

## Quick Start

```bash
# Daily workflow (fast, no external deps)
pnpm test:unit

# Full test suite
pnpm test

# Before pushing
pnpm precommit    # typecheck + lint + test:unit
```

## Test Suites

### Unit Tests (default)

```bash
pnpm test:unit
```

- **Files:** `tests/*.test.ts`
- **Speed:** Fast (seconds)
- **External deps:** None (mocked)
- **Covers:** Config parsing, markdown formatting, adapters, session management

### E2E Tests

```bash
pnpm test:e2e
```

- **Files:** `tests/*.e2e.ts`
- **Speed:** Slower (starts gateway, real Telegram)
- **External deps:** Requires `.env.e2e` with Telegram credentials
- **Covers:** Full gateway flow, Telegram integration, CLI bridges

## Running Specific Tests

```bash
# Single file
pnpm test tests/config.test.ts

# Pattern match
pnpm test -- -t "session"

# Watch mode
pnpm test -- --watch
```

## E2E Setup

Copy and configure E2E environment:

```bash
# Create .env.e2e with:
TG_E2E_RUN=1
TG_E2E_BOT_TOKEN=your_test_bot_token
TG_E2E_ALLOWED_CHAT_ID=your_telegram_user_id
TG_E2E_GATEWAY_PORT=8788
```

For full Telegram client tests (not just bot):
- `TG_E2E_API_ID` — Telegram API ID
- `TG_E2E_API_HASH` — Telegram API hash
- `TG_E2E_SESSION` — Telegram session string

Generate session: `pnpm telegram:session`

## Test Files Overview

| File | What it tests |
|------|---------------|
| `config.test.ts` | Configuration loading and validation |
| `bridge-events.test.ts` | Bridge event handling |
| `jsonl-session.test.ts` | JSONL protocol parsing |
| `memory-*.test.ts` | Memory/recall integration |
| `pi-*.test.ts` | Pi adapter specifics |
| `codex-*.test.ts` | Codex adapter specifics |
| `cron-service.test.ts` | Scheduled jobs |
| `telegram-*.e2e.ts` | Full Telegram integration |
| `pi-agent.e2e.ts` | Pi agent E2E flow |

## Pre-commit Hook

The repo has a Husky pre-commit hook that runs:

```bash
pnpm precommit
# = pnpm typecheck && pnpm lint && pnpm test:unit
```

To skip (not recommended):
```bash
git commit --no-verify
```

## Coverage

Not currently configured. To add:

```bash
# In vitest.config.ts, add:
coverage: {
  provider: 'v8',
  reporter: ['text', 'html'],
  thresholds: { lines: 70 }
}
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| E2E tests skip | Set `TG_E2E_RUN=1` in `.env.e2e` |
| Telegram auth fails | Regenerate session: `pnpm telegram:session` |
| Port conflict in E2E | Check `TG_E2E_GATEWAY_PORT`, kill old processes |
| Test timeout | Increase timeout in test file or config |

## Writing Tests

### Unit test template

```typescript
import { describe, it, expect } from 'vitest';

describe('MyFeature', () => {
  it('should do something', () => {
    const result = myFunction();
    expect(result).toBe(expected);
  });
});
```

### E2E test template

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('MyFeature E2E', () => {
  beforeAll(async () => {
    // Start gateway, setup
  });

  afterAll(async () => {
    // Cleanup
  });

  it('should work end-to-end', async () => {
    // Test real flow
  });
});
```
