---
name: to-tickets
description: Break a plan or specification into tracer-bullet tickets with explicit blocking edges.
---

# To Tickets

Decompose specifications into vertical tracer-bullet slices that can each be implemented, tested, and verified independently.

## Prerequisites

- Authoritative specification or requirements doc in context.
- Configured issue tracker or `.scratch/` tickets directory.
- If no issue tracker or specification exists, report this workflow as **UNAVAILABLE** until a specification is settled.

## Process

1. **Draft Vertical Slices**:
   Each slice must cut across layers (domain, API/CLI, tests) and be verifiable on its own.
2. **Explicit Blockers**:
   Declare exact dependencies between tickets. Tickets without blockers can start immediately.
3. **Review & Publish**:
   Confirm ticket sizing and blocking edges before persisting to the configured tracker.
