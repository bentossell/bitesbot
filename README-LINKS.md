# Bidirectional Links

Wiki-style `[[links]]` for workspace markdown files.

## Overview

This feature enables automatic detection and indexing of `[[term]]` patterns in markdown files within your workspace (default: `~/bites`). The system builds a bidirectional links index showing what links TO each topic (backlinks) and what each topic links TO (forward links).

## Installation

After building the project:

```bash
pnpm run build
pnpm link --global  # Optional: to install globally
```

## CLI Usage

The `tg-links` command provides several subcommands:

### Rebuild Index

Scan all markdown files in workspace and rebuild the links index:

```bash
tg-links rebuild
tg-links rebuild --workspace ~/bites --config ~/.config/tg-gateway
```

### Query Backlinks

Show what files link TO a term:

```bash
tg-links backlinks bitesbot
tg-links backlinks "clawdbot"
```

### Query Forward Links

Show what a term links TO:

```bash
tg-links links thoughts
```

### Show Complete Info

Display all information about a term:

```bash
tg-links info bitesbot
```

Output includes:
- Target type (repo, file, or topic)
- Target path
- Whether the target exists
- Files that link to it (backlinks)
- Terms it links to (forward links)

### Show Full Index

Display the entire links index as JSON:

```bash
tg-links show
```

## Programmatic Usage

```typescript
import { createLinksIndex } from 'tg-gateway/dist/workspace/index.js';

const manager = createLinksIndex('~/bites');

// Rebuild and save index
const index = await manager.rebuildAndSave();

// Query backlinks
const backlinks = await manager.getBacklinks('bitesbot');

// Query forward links
const links = await manager.getForwardLinks('thoughts');

// Get link target info
const target = await manager.getLinkTarget('bitesbot');
```

## Link Resolution

Links are resolved in the following order:

1. **Repository**: `~/repos/{term}/`
2. **Workspace file**: `~/bites/{term}.md`
3. **Memory file**: `~/bites/memory/{term}.md`
4. **Topic** (creates placeholder): `~/bites/memory/{term}.md` (marked as non-existent)

## Index Format

The index is stored at `~/.config/tg-gateway/links-index.json`:

```json
{
  "bitesbot": {
    "linkedFrom": ["thoughts.md", "memory/2026-01-28.md"],
    "linksTo": ["clawdbot", "telegram"],
    "target": {
      "type": "repo",
      "path": "/Users/mini/repos/bitesbot",
      "exists": true
    }
  },
  "thoughts": {
    "linkedFrom": [],
    "linksTo": ["bitesbot", "clawdbot"],
    "target": {
      "type": "file",
      "path": "/Users/mini/bites/thoughts.md",
      "exists": true
    }
  }
}
```

## Example Workflow

1. Create markdown files with wiki-style links:

```markdown
<!-- ~/bites/thoughts.md -->
Working on [[bitesbot]] voice support today.
Related to [[clawdbot]] transcription approach.
Need to review [[telegram]] bot API docs.
```

2. Rebuild the index:

```bash
tg-links rebuild
```

3. Query backlinks to see what mentions a topic:

```bash
tg-links backlinks bitesbot
# Output: Files linking to "bitesbot":
#   - thoughts.md
```

4. Query forward links to see what a file references:

```bash
tg-links links thoughts
# Output: "thoughts" links to:
#   - bitesbot
#   - clawdbot
#   - telegram
```

## Integration with Agent

The agent can use this tooling to:
- Discover connections between topics
- Follow trails of related work
- Surface relevant context via backlinks
- Navigate the knowledge graph

Future: Update `AGENTS.md` to teach the agent how to use these commands during conversations.

## Development

Source files:
- `src/workspace/links.ts` - Link detection and resolution
- `src/workspace/links-index.ts` - Backlinks index management
- `src/workspace/links-cli.ts` - CLI interface
- `src/workspace/index.ts` - Public exports
