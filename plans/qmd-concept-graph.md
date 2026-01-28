# QMD Concept Graph + Implicit Bidirectional Links

## Goal
Extend qmd so agents can query “related files” for any term, not just exact matches. Build a concept graph from all workspace files and surface backlinks/related context automatically during search.

## Non-Goals
- Auto-editing markdown files to insert `[[links]]`
- Full knowledge-graph reasoning
- Replacing qmd embeddings/semantic search

## Concepts
- **Concept**: normalized term (project, person, topic, task)
- **Alias**: alternate form that maps to a canonical concept (e.g. `bensbites` → `ben's bites`)
- **Mention**: occurrence of a concept in a file
- **Related file**: file that mentions the same concept
- **Related concept**: co-occurs with a concept in the same file/section

## Data Model
```json
{
  "concepts": {
    "bitesbot": {
      "type": "project",
      "aliases": ["BitesBot"],
      "mentions": [{"file":"thoughts.md","count":5}],
      "related": {"grizzly":0.42,"car mot":0.08}
    }
  },
  "files": {
    "thoughts.md": {"concepts":["bitesbot","grizzly","car mot"]}
  }
}
```

## Extraction Pipeline (qmd)
1. **Normalize text**: strip code blocks, collapse whitespace, keep headings
2. **Candidate concepts**:
   - Title-case phrases (2–4 tokens)
   - repo/project names from `~/repos/*`
   - tags (`#tag`) and wiki-style `[[terms]]` if present
   - configurable allowlist/stoplist
3. **Normalize**: lowercase, trim punctuation, singularize basic plurals
4. **Alias resolution**: map aliases to canonical concepts (config file)
5. **Scoring**:
   - mention weight = occurrences / file length
   - related weight = co-occurrence in same paragraph or heading

## Alias Config (per collection)
```json
{
  "aliases": {
    "bensbites": "ben's bites",
    "bb": "ben's bites",
    "bitesbot": "bitesbot"
  }
}
```

## Storage
- Add `concepts.json` or `concepts.sqlite` inside qmd collection directory
- Update during `qmd embed` (full rebuild) and incremental file updates

## Query API (qmd)
- `qmd concepts <term>` → list files + counts
- `qmd related <term>` → related concepts + top files
- `qmd file <path>` → concepts present in a file
- `qmd aliases list` → list alias mappings
- `qmd aliases add <alias> <canonical>` → add mapping
- `qmd aliases remove <alias>` → remove mapping

## Agent Integration
- When agent runs qmd search, also query `qmd related <term>`
- Include a short “Related files” section in context assembly (top 3–5 files)
- Allow opt-out via flag (e.g. `--no-related`)

## Phases
1. **Indexer**: concept extraction + storage in qmd
2. **CLI**: concepts/related/file commands
3. **Agent hook**: include related files in context retrieval

## Risks
- Noise from false positives
- Performance on large workspaces
- Concept drift without incremental updates

## Open Questions
- Should non-markdown files be included by default?
- Use sqlite vs json for scale?
- Do we need per-collection config for stop/allow lists?
