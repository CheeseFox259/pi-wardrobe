# Domain docs

Before exploring this repository, read `CONTEXT.md`, then the relevant ADRs in `docs/adr/`. `CONTEXT.md` is the authoritative domain glossary: definitions and boundaries only, with no implementation details, TODOs, or feature design. `GLOSSARY.md` is a compatibility pointer for skills that use that filename; do not maintain a second glossary there. Use the canonical vocabulary in specs, tickets, reviews, and test names. Surface ADR conflicts instead of silently overriding them.

This single-context repository uses:

```text
/CONTEXT.md
/GLOSSARY.md -> CONTEXT.md (Markdown pointer, not a symlink)
docs/adr/
```

Do not introduce context-specific glossaries or `GLOSSARY-MAP.md` unless separate domain contexts actually emerge.
