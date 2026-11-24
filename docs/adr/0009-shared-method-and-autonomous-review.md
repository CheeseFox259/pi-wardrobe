# Shared methods and autonomous preset review

Date: 2026-10-26
Status: accepted by user; implementation under verification

## Context

Paid chains 39–41 failed before the first runtime review decision. Sequential release-note batches, an accepted-batch-only progress clock, and restricted file discovery introduced barriers that were not validated by deterministic passing tests. Prior completed runs used substantially longer resumed work and acceptance feedback.

## Decision

The manager owns common update and maintenance methods. A preset owns design principles and feature tradeoffs in its private policy; the two layers load together. Missing private policy uses a conservative preservation fallback, never another preset's philosophy. Policy is read from frozen input during the task.

New tasks expose a complete change list with original evidence pointers. The model chooses dependency order, edits the candidate, and saves partial review decisions. A pending question does not prevent independent work. Required work cannot be deferred into a successful installation.

The program performs basic runtime loading checks and final coverage, resource, dependency, affected-behavior, and artifact verification. Runtime loading failure is a repair finding, not a sequential gate on unrelated work. Installation requires the verified current artifact and existing authorization.

Remove the 24-turn-without-accepted-batch stop. New evidence, changed candidate content, and saved decisions count as progress. A sustained absence of all three gets one bounded recovery followed by a preserved paused task. Context retains native history and saved work; there are no model-managed workflow coordinates or mandatory intermediate checkpoints.

## Consequences

There is no fixed per-item model-call count or promised cost. Final verification may reveal integration failures after several independent changes; durable drafts and the immutable base preserve recovery. Legacy saved workflows retain their original representation. A fresh full-chain run will use the native default Pi model for comparison, operated by a separate Codex GPT-6 Luna/max session, without runtime hints or candidate edits by the operator.
