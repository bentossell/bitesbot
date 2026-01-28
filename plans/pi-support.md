# Pi Support (Mario's Agent)

## Goal
Add Pi as a CLI adapter alongside droid and claude.

## Research Needed
- [ ] Find Pi's CLI interface / JSONL output format
- [ ] Check if Pi supports session resume (`-s` flag equivalent)
- [ ] Identify any Pi-specific event types

## Implementation
1. Create `adapters/pi.yaml` manifest
2. Update `jsonl-session.ts` to handle Pi event types (if different from droid/claude)
3. Test session resume behavior

## Manifest Template
```yaml
name: pi
command: /path/to/pi
args: []
outputFormat: stream-json
resumeFlag: --session  # or whatever Pi uses
```

## Questions
- Does Pi emit `session_start`, `completion`, `tool_start/end` events?
- What's the session resume mechanism?
- Any special auth or config needed?
