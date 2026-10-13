---
name: code-review
description: Review changes along two distinct axes - Standards adherence and Specification fidelity.
---

# Code Review

Review code changes since a fixed point (commit SHA, branch, or tag) along two orthogonal axes:
1. **Standards**: Compliance with documented coding guidelines and Fowler smells.
2. **Spec**: Faithfulness to the requirements and user stories in the specification.

## Prerequisites

- Local git repository with commits or staged diffs to inspect.
- If subagents are not supported by the runtime, report subagent execution as **UNAVAILABLE** and perform the two-axis analysis sequentially in the current turn without falsely claiming separate subagents ran.

## Process

1. **Pin Diff Baseline**:
   Resolve the comparison baseline with `git diff <base>...HEAD`.
2. **Evaluate Standards**:
   Review code structure against repository rules and clean-code principles (no dead code, clear naming, no speculative abstractions).
3. **Evaluate Spec Fidelity**:
   Verify every acceptance criterion in the specification has corresponding tests and implementation.
4. **Report Findings**:
   Provide actionable recommendations categorized by severity and axis.
