# Codex Support

## Goal
Add OpenAI Codex as a CLI adapter.

## Research Needed
- [ ] Find Codex CLI tool (if exists) or API wrapper
- [ ] Check output format compatibility with JSONL bridge
- [ ] Understand session/context management

## Implementation Options

### Option A: Direct API
Use OpenAI API directly from bitesbot, bypassing CLI pattern.
- Pros: More control, no external CLI dependency
- Cons: Different architecture than other adapters

### Option B: CLI Wrapper
Create/use a Codex CLI that outputs stream-json format.
- Pros: Consistent with droid/claude pattern
- Cons: Need to find or build CLI tool

## Manifest Template (if CLI exists)
```yaml
name: codex
command: codex
args: [--output-format, stream-json]
outputFormat: stream-json
```

## Questions
- Is there an official Codex CLI?
- How does Codex handle conversation context/sessions?
- What's the event format for tool use?
