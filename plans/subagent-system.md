# Subagent System Design

## Overview

Enable parallel background agent runs spawned from the main session. Subagents run isolated CLI processes, complete their task, and announce results back to the chat.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      jsonl-bridge                           │
│  ┌─────────────────┐    ┌─────────────────────────────────┐│
│  │  SessionStore   │    │      SubagentRegistry           ││
│  │  (main sessions)│    │  Map<runId, SubagentRunRecord>  ││
│  └─────────────────┘    └─────────────────────────────────┘│
│           │                          │                      │
│           ▼                          ▼                      │
│  ┌─────────────────┐    ┌─────────────────────────────────┐│
│  │  JsonlSession   │    │  SubagentSession (extends)      ││
│  │  (1 per chat)   │    │  - requesterChatId              ││
│  │                 │    │  - task, label                  ││
│  │                 │    │  - announce on complete         ││
│  └─────────────────┘    └─────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Data Structures

### SubagentRunRecord

```typescript
type SubagentRunRecord = {
  runId: string                    // unique id (uuid)
  requesterChatId: number | string // chat that spawned this
  requesterSessionId: string       // parent session id
  childSessionId?: string          // once CLI starts
  cli: string                      // claude | droid
  task: string                     // the prompt/task
  label?: string                   // optional display name
  status: 'queued' | 'running' | 'completed' | 'error' | 'stopped'
  createdAt: number
  startedAt?: number
  endedAt?: number
  result?: string                  // final output
  error?: string
}
```

### SubagentRegistry

```typescript
class SubagentRegistry {
  private runs: Map<string, SubagentRunRecord>
  private byRequester: Map<string, Set<string>>  // chatId -> runIds
  
  spawn(opts: SpawnOpts): SubagentRunRecord
  list(chatId: string | number): SubagentRunRecord[]
  get(runId: string): SubagentRunRecord | undefined
  stop(runId: string): boolean
  stopAll(chatId: string | number): number
  update(runId: string, patch: Partial<SubagentRunRecord>): void
}
```

## Spawning Flow

1. User sends `/spawn "research X"` or main agent calls spawn tool
2. Registry creates `SubagentRunRecord` with status `queued`
3. Check concurrency limit (default: 4 per chat)
4. Spawn new `JsonlSession` with:
   - Same working directory
   - Task as prompt
   - Separate session ID (no resume from parent)
5. On CLI start → status `running`, capture `childSessionId`
6. On CLI complete → status `completed`, capture result
7. Announce result back to chat

## Announce Flow

When subagent completes:

```typescript
const announceSubagent = async (record: SubagentRunRecord) => {
  const duration = formatDuration(record.endedAt - record.startedAt)
  const label = record.label || 'Subagent'
  const status = record.error ? '❌' : '✅'
  
  const message = [
    `${status} ${label} (${duration})`,
    '',
    record.result || record.error || '(no output)',
  ].join('\n')
  
  await send(record.requesterChatId, message)
}
```

## Commands

### /spawn

```
/spawn "task description"
/spawn --label "Research" "find info about X"
/spawn --cli droid "task"
```

Creates a new subagent run.

### /subagents

```
/subagents              # list active + recent
/subagents list         # same
/subagents stop <id|#>  # stop specific run
/subagents stop all     # stop all for this chat
/subagents log <id|#>   # show output so far
```

### /stop behavior

Existing `/stop` should also stop all subagents for the chat.

## Concurrency Control

```typescript
const SUBAGENT_MAX_CONCURRENT = 4  // per chat

const canSpawn = (chatId: string | number): boolean => {
  const active = registry.list(chatId)
    .filter(r => r.status === 'running' || r.status === 'queued')
  return active.length < SUBAGENT_MAX_CONCURRENT
}
```

## Tool Exposure (Optional)

Expose `spawn` as a tool so the main agent can spawn subagents programmatically:

```typescript
// In manifest tools section
{
  name: 'spawn_subagent',
  description: 'Spawn a background agent to work on a task in parallel',
  parameters: {
    task: { type: 'string', required: true },
    label: { type: 'string' },
    cli: { type: 'string', enum: ['claude', 'droid'] }
  }
}
```

The bridge intercepts this tool call and spawns via registry instead of letting CLI execute it.

## File Structure

```
src/bridge/
  subagent-registry.ts    # SubagentRegistry class
  subagent-session.ts     # Extended session with announce
  jsonl-bridge.ts         # Add spawn command handling
```

## Implementation Phases

### Phase 1: Registry + Manual Spawn
- [ ] `SubagentRegistry` class
- [ ] `/spawn` command parsing
- [ ] Spawn subagent as separate `JsonlSession`
- [ ] Announce on completion
- [ ] `/subagents list`

### Phase 2: Management
- [ ] `/subagents stop`
- [ ] `/stop` stops all subagents
- [ ] Concurrency limit
- [ ] `/subagents log`

### Phase 3: Tool Integration
- [ ] `spawn_subagent` tool interception
- [ ] Main agent can spawn subagents programmatically
- [ ] Result passed back to main agent context

## Config

```typescript
// In BridgeConfig or adapter manifest
subagents?: {
  maxConcurrent?: number      // default: 4
  defaultCli?: string         // inherit from main or specify
  announceFormat?: 'full' | 'summary'
  workingDir?: string         // same as main or separate
}
```

## Limitations (v1)

- No nested subagents (subagents cannot spawn subagents)
- No tool restrictions (subagents get same tools as main)
- No separate working directories (share parent workspace)
- No persistence across restart (in-memory registry)
- Results announced as chat message only (not injected into parent context)

## Future Enhancements

- Persist registry to disk for restart recovery
- Inject subagent results into parent session context
- Tool policy per subagent
- Separate sandboxed working directories
- Cost tracking per subagent
