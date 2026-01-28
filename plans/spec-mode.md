# Spec/Plan Mode

## Goal
Support spec/plan mode in Telegram for each agent - agent creates a plan, user approves before execution.

## Research: Clawdbot Approach
Reference: `~/repos/clawdbot/`

Look for:
- How spec mode is triggered
- How plans are presented to user
- Approval flow
- How approved plan feeds into execution

## User Flow
```
User: "Add dark mode to the app"

Bot: 📋 Spec Mode

**Plan: Add Dark Mode**

1. Add theme context provider
2. Create dark color tokens
3. Update components to use theme
4. Add toggle in settings

[Approve] [Edit] [Cancel]

User: [Approve]

Bot: ✅ Executing plan...
🔧 Creating ThemeContext.tsx
...
```

## Implementation

### Phase 1: Trigger Detection
Detect when to enter spec mode:
- Explicit: `/spec add dark mode`
- Implicit: Complex tasks, new features
- Agent-initiated: Agent decides task needs planning

### Phase 2: Plan Format
```typescript
type Plan = {
  title: string
  steps: PlanStep[]
  estimatedCost?: number
  risks?: string[]
}

type PlanStep = {
  id: number
  description: string
  files?: string[]  // files to be modified
}
```

### Phase 3: Telegram UI
- Present plan as formatted message
- Inline keyboard: [✅ Approve] [✏️ Edit] [❌ Cancel]
- Handle callback queries

### Phase 4: Execution
- On approve, feed plan to agent as context
- Agent executes step by step
- Report progress per step

## Per-Agent Behavior
Different agents might plan differently:
- **droid**: Uses Factory spec mode natively
- **claude**: May need prompt engineering for planning
- **pi**: TBD

## Questions
- Store plans in workspace for reference?
- Allow partial approval (approve steps 1-3, skip 4)?
- How to handle plan edits?
