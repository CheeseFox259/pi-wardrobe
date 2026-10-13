---
name: domain-modeling
description: Build and sharpen the project domain model, ubiquitous vocabulary, and architectural decision records.
---

# Domain Modeling

Actively build, maintain, and sharpen the domain model and ubiquitous vocabulary in `CONTEXT.md` and Architectural Decision Records (`docs/adr/`).

## Prerequisites

- File system access to repository documentation (`read`, `write`, `edit`).
- If repository documentation roots are missing or read-only, report the workflow prerequisite as **UNAVAILABLE**.

## Process

1. **Verify Canonical Terms**:
   Cross-reference user vocabulary against `CONTEXT.md`. Challenge overloaded or fuzzy definitions immediately.
2. **Document Decisions in ADRs**:
   Record significant technical and architectural choices using the format in `ADR-FORMAT.md`.
3. **Keep Context Authoritative**:
   Maintain single-context or multi-context structures following `CONTEXT-FORMAT.md`.
