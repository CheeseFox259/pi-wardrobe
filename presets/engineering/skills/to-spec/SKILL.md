---
name: to-spec
description: Synthesize requirements, domain models, and architecture decisions into an authoritative specification.
---

# To Spec

Synthesize settled requirements, user stories, and architectural decisions into an authoritative specification document.

## Prerequisites

- Access to project tracker configuration (e.g., `docs/agents/issue-tracker.md`) or repo docs directory.
- If target specification directories or tracker configurations are missing, report the workflow prerequisite as **UNAVAILABLE** and prompt the user to configure tracking via `/setup-matt-pocock-skills`. Never create remote issues without authorization.

## Process

1. **Problem Statement & Solution**:
   Articulate the user's problem and proposed solution in domain terminology.
2. **User Stories**:
   List numbered, verifiable user stories in the format: `As an <actor>, I want <feature>, so that <benefit>`.
3. **Implementation & Testing Seams**:
   Document architectural decisions, data models, contracts, and testing seams without fragile code snippets.
4. **Publish**:
   Output the specification to the configured local or remote issue tracker.
