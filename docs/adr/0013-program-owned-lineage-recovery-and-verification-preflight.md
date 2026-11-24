# Program-owned lineage recovery and verification preflight repair

Status: implemented; native default-model acceptance pending.

## Context

Paid trial 45 saved all 22 decisions but used 18 `verify` calls, including 15 repeated `WORKFLOW_OWNED_FIELD` failures. Those errors told the model to restore program-owned lineage while the inherited handoff still pointed back to `verify`. A separate invalid resource declaration and a missing skill companion also returned generic errors rather than a focused repair. The subsequent focused behavior-check repair used 19 assistant turns without an edit or saved repair. These results identify execution/interface defects; they do not prove that smaller updates will complete or that the default model's completion rate has improved.

## Decision

The manager restores its frozen upstream, preset/update and existing-skill provenance, and manifest skill source/ref fields from the exact base before applying reviewed decisions. This happens for runtime loading and final verification. `manifest.piVersion` is program-owned runtime metadata and advances to the actual current Pi rather than reverting to the old base (see ADR-0015). New custom skill content and model-owned fields remain intact; adopt/adapt/resource decisions are still applied and compiled by the program afterward. Verification and installation seal the resulting candidate, never the model-authored provenance.

Resource compilation, candidate maintenance validation, dependency staging and final candidate-consistency failures use the existing `verification-repair` handoff. They return `CHECK_FAILED`, preserve the concrete diagnostic and affected files, focus the repair item and make `save` the next transition. Incomplete ledgers, stale submissions and cancellation retain their existing control semantics. Candidate behavior failures, non-portable tests and incorrect paths are not hidden or automatically repaired.

## Consequences

Public-tool regressions prove that tampered lineage is restored before a successful verification and inactive installation, an invalid resource operation can be removed through a focused save and then installed, and a missing skill companion returns the same focused repair with its original structured references. Deterministic tests do not establish real-model completion, reliability or cost improvement; a later paid acceptance run remains separate.
