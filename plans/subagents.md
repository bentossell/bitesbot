# Subagents

## Goal
Allow primary agent to spawn child agents for specific tasks, similar to clawdbot's implementation.

## Research: Clawdbot Approach
Reference: `~/repos/clawdbot/src/agents/clawdbot-tools.subagents.*`

Key files to study:
- `clawdbot-tools.ts` - main tool definitions
- `subagent-registry.ts` - tracks spawned agents
- `subagent-announce.ts` - formats announcements
- `subagent-announce-queue.ts` - message queuing

## Clawdbot Patterns
1. **Spawn tool** - agent calls `spawn_subagent(task, model)`
2. **Registry** - tracks active subagents per session
3. **Announce** - notifies user of subagent activity
4. **Cross-agent** - can spawn different agent types (claude, droid, etc.)

## Implementation for Bitesbot

### Phase 1: Basic Spawn
```typescript
// New tool for agents
{
  name: 'spawn_subagent',
  input: { task: string, agent?: string },
  // Spawns new JsonlSession with task as prompt
}
```

### Phase 2: Registry
Track subagents per chat:
```typescript
type SubagentEntry = {
  id: string
  parentSessionId: string
  task: string
  agent: string  // droid, claude, pi
  status: 'running' | 'completed' | 'failed'
}
```

### Phase 3: Result Routing
- Subagent output routes back to parent
- Parent can use result in its response
- User sees subagent activity in Telegram

## Questions
- Parallel or sequential subagents?
- Depth limit (subagent spawning subagent)?
- How to handle long-running subagent tasks?
- Token/cost tracking across agents?
