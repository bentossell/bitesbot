# Bidirectional Links

## Goal
Auto-detect and create wiki-style `[[links]]` between markdown files in workspace. Agent can follow trails and discover connections.

## Use Case
In `thoughts.md`:
```markdown
Working on [[bitesbot]] voice support today.
Related to [[clawdbot]] transcription approach.
```

These link to:
- `~/repos/bitesbot/` (repo)
- `~/repos/clawdbot/` (repo)
- Or `memory/bitesbot.md`, `memory/clawdbot.md` (topic files)

## qmd Integration
qmd already indexes files for semantic search. Bidirectional links would:
1. Enhance qmd's graph with explicit connections
2. Allow agent to traverse links during search
3. Surface "backlinks" (what links TO this file)

## Implementation

### Phase 1: Link Detection
- Scan markdown for `[[term]]` patterns
- Also auto-detect potential links:
  - Repo names mentioned in text
  - File paths
  - Repeated proper nouns

### Phase 2: Link Resolution
```typescript
type LinkTarget = 
  | { type: 'repo', path: string }
  | { type: 'file', path: string }
  | { type: 'topic', name: string }  // creates if missing
```

### Phase 3: Backlinks Index
```json
{
  "bitesbot": {
    "linkedFrom": ["thoughts.md", "memory/2026-01-28.md"],
    "linksTo": ["clawdbot", "telegram"]
  }
}
```

### Phase 4: Agent Instructions
Update AGENTS.md to teach agent:
- How to use `[[links]]`
- How to query backlinks
- When to create new topic files

## Questions
- Does qmd already support wiki links?
- Should links be stored in a separate index or inline?
- Auto-create topic files on first link?
