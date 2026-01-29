# Workspace tools

This repo includes CLI tools to index a markdown workspace for links and concepts.

## Links (`tg-links`)

- Scans workspace markdown for `[[wiki]]` style links
- Builds a bidirectional index of backlinks and forward links
- See `README-LINKS.md` for full usage and examples

## Concepts (`tg-concepts`)

- Extracts concepts from markdown (wiki links, hashtags, and proper nouns)
- Builds an index of mentions and related concepts

Commands:

```bash
tg-concepts rebuild

tg-concepts concepts <term>

tg-concepts related <term>

tg-concepts file <path>
```

Config:

- `concepts.config.json` lives in `~/.config/tg-gateway/` by default
- Supports `stop`, `allow`, and `aliases` lists

## Memory recall

- Memory recall uses `qmd` to search a workspace
- Results are formatted with optional related links from the links index
- Configured via `bridge.memory` in the gateway config
