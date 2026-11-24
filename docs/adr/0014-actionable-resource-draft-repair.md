# Actionable resource-draft validation and repair

Status: implemented; native default-model acceptance pending.

## Context

Paid trial 46 saved three resource operations whose `package` values were npm/git source strings rather than aliases declared in `preset.json.packages`. The compiler correctly rejected them; an offline control using valid aliases and a valid replacement compiled. The verifier did not impose a one-attempt limit, and the workflow stopped because the repair produced no durable delivery.

The generic error did not identify the failing operation. More importantly, ordinary draft merging retained invalid predecessors when corrected operations were appended. The repair handoff named `save` but did not explain that correcting this class of failure requires replacing the complete draft. A later investigation or native recovery also lost any response-only repair template. Candidate full-suite failures collected outside Wardrobe staging are separate evidence and do not justify weakening affected behavior checks.

## Decision

Validate the merged resource draft during `save` without writing the compiled declaration. Reject invalid package aliases, kinds, unsafe paths, missing resources and invalid replacement operations before they enter the durable draft. Diagnostics identify the operation index, field, actual value and allowed aliases or kinds. Resource `package` means an alias declared in `preset.json.packages`; `oldPath` is the previous relative resource path.

Explicit `retire` may name an alias removed from the candidate only when that exact resource exists in the workflow catalog. All surviving resources still require declared aliases; reject orphaned catalog entries before writing the declaration, with the concrete retirement operations. A removed alias leaves no empty selector, while a still-declared package retains empty selections to disable discovery. This permits intentional package removal without silently discarding resources. Trial 58 exposed both the impossible retirement and the compiler rewriting stale selectors after candidate edits.

Verification preflight retains formatted declaration diagnostics and their structured fields. Staging repair includes `preset.json` alongside package metadata so the model receives the actual failing field and file.

Legacy invalid drafts remain subject to final verification. Resource compilation failures persist their structured operation details and produce a `nextCall` containing `replace: true` and the complete saved draft, including every unrelated decision. The template survives subsequent `details` and native recovery handoffs. The model corrects the indexed resource operation and the repair decision, then saves and verifies again. Successful draft saves clear this repair state.

Resource and behavior gates remain strict. The manager does not infer that candidate tests run outside the materialized environment are manager defects, skip them, or convert their failures into passes.

## Consequences

Public-tool regressions prove that a source-valued package is rejected with an actionable error and never persisted, and that a legacy invalid draft can be repaired through the returned complete replacement template before verification and inactive installation. The trial-46 offline replay preserves all 22 original decisions while saving five corrected resource operations. These deterministic results do not establish real-model completion, reliability or cost improvement; a separate native default-model acceptance run remains necessary.

Additional public-tool coverage removes a package declaration, explicitly retires its frozen export, verifies and installs inactive. Resource tests reject incomplete retirement without writing files and retain discovery suppression for declared packages. A trial-58 clone replay compiles all three removed-package retirements while leaving the historical candidate unchanged.
