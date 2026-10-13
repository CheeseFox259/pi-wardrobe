---
name: project-architecture
description: Design, review, and evolve project-wide architecture, module boundaries, and integration seams.
---

# Project Architecture

Establish and preserve deep module boundaries, high seams for testing, and maintainable layered structures.

## Prerequisites

- Read access to codebase manifests, module entries, and architecture docs.
- If the project architecture or source trees are inaccessible, report the workflow prerequisite as **UNAVAILABLE**.

## Process

1. **Identify Module Seams**:
   Find the highest, deepest interface seam for feature integration to minimize coupling and surface area.
2. **Evaluate Dependency Directions**:
   Ensure dependencies point inward toward core domain rules. Flag circular imports and leaky abstractions.
3. **Deep Modules**:
   Strive for simple, narrow interfaces backed by substantial internal implementations.
