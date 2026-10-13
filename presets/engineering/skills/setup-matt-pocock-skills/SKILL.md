---
name: setup-matt-pocock-skills
description: Configure repository conventions for issue tracking, triage label vocabulary, and domain documentation.
---

# Setup Matt Pocock Skills

Configure repository conventions for issue tracking, triage label vocabulary, and domain documentation layout.

## Prerequisites

- **Interactive Question Tools**: Requires `question` or `questionnaire` tool in runtime for guided prompts.
- If interactive question tools are missing, report the interactive wizard workflow as **UNAVAILABLE** and prompt the user to adopt default files directly or configure via text.

## Process

1. **Explore Current Repository State**:
   Inspect git remotes, existing `docs/agents/`, `CONTEXT.md`, and issue trackers.
2. **Issue Tracker Setup**:
   Configure `docs/agents/issue-tracker.md` using the templates in `issue-tracker-github.md`.
3. **Triage Vocabulary**:
   Establish the canonical triage labels described in `triage-labels.md`.
4. **Domain Documentation**:
   Establish `CONTEXT.md` and `docs/adr/` layout following `domain.md`.
