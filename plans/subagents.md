# Subagents

**Status: ✅ Implemented (2026-01-28)**

## Goal
Allow primary agent to spawn child agents for specific tasks, similar to clawdbot's implementation.

## Implementation

### Files Created
- `src/bridge/subagent-registry.ts` — SubagentRegistry class, tracks spawned agents per chat
- `src/bridge/subagent-commands.ts` — Command parsing and formatting utilities

### Files Modified
- `src/bridge/jsonl-bridge.ts` — Added /spawn, /subagents commands and spawnSubagent function
- `src/bridge/index.ts` — Added exports

### Commands

**Spawn a subagent:**
```
/spawn "task description"
/spawn --label "Research" "task"
/spawn --cli droid "task"
```

**Manage subagents:**
```
/subagents              # list active + recent
/subagents list         # same
/subagents stop <id>    # stop specific run
/subagents stop all     # stop all for this chat
/subagents log <id>     # show output so far
```

**Stop behavior:**
- `/stop` now also stops all subagents for the chat

### Features
- Concurrency limit: max 4 subagents per chat
- Auto-announce on completion with status icon and duration
- Prunes old completed runs (keeps last 10 per chat)
- Subagents run with fresh context (no session resume)

### Not Yet Implemented
- [ ] Tool interception (main agent spawning via tool call)
- [ ] Persistence across gateway restarts
- [ ] Nested subagents prevention
- [ ] Cost tracking per subagent

## Original Research Notes

### Clawdbot Patterns (Reference)
1. **Spawn tool** - agent calls `spawn_subagent(task, model)`
2. **Registry** - tracks active subagents per session  
3. **Announce** - notifies user of subagent activity
4. **Cross-agent** - can spawn different agent types (claude, droid, etc.)
