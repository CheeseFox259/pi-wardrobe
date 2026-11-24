# Component contracts and bounded implementation

Date: 2026-11-16
Status: accepted product/design direction; implementation verification pending.

## Context

Paid trial 69 continuation02 preserved integrity and loaded the preset policy but stalled after 71 more turns without verify/install. Saved package decisions deferred necessary adaptations into one requested integration item. A decision ledger could express adoption intent but did not explicitly represent the implementation still owed. Product-policy loading, task completion and real-model efficiency are separate claims.

## Decision

Presets specify component maintenance contracts: defaults, preservation boundaries, explicit user overrides and expected behavior. Shared methods retain execution ownership. The current execution model decomposes compound requirements into bounded implementation items in the existing ledger; the manager validates references, dependencies, structural coverage and completion evidence. Simple maintenance can use one item. There is no extra planning model and no Perfect Pi-specific decomposition in the manager.

Investigation relevant to the current item remains available. Broadening investigation names the missing fact that can change the decision. Recovery points at concrete unresolved work. Implementation claims, program-applied adoption and passing verification stay distinct; final installation still requires the verified current artifact.

This extends ADR-0009/0010 without restoring sequential batch gates. Focus remains a view, cross-item saves are allowed, and blockers do not prevent independent work. Changes to narrative alone do not constitute delivery. Local affected checks complement final integration verification and never replace it.

## Consequences

The ledger and public protocol become slightly richer to make necessary work visible. Component policies need deliberate maintenance, and structural coverage cannot prove natural-language completeness. Independent frozen product checks and a later real paid full-chain test remain necessary. The complete known problem set is implemented and checked together before that test rather than using paid runs to discover already identified gaps.
