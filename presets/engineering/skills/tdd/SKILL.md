---
name: tdd
description: Execute test-driven development with strict red-green-refactor cycles at explicit interface seams.
---

# Test-Driven Development (TDD)

Drive implementation through executable tests at verified public seams.

## Prerequisites

- Test runner in the project environment (e.g. `node --test`, `pytest`, `cargo test`).
- If no test harness or runner exists in the project, report the TDD workflow prerequisite as **UNAVAILABLE** and prompt the user to establish a test framework.

## Process

1. **Pick One Seam**:
   Choose the highest stable seam covering the desired behavior.
2. **Write a Failing Test (Red)**:
   Write a concise test asserting expected behavior. Run it to verify it fails for the right reason.
3. **Implement (Green)**:
   Write the minimal code necessary to satisfy the assertion.
4. **Refactor**:
   Clean up duplication, improve names, and ensure tests remain green. Consult `tests.md` and `mocking.md` for guidelines.
