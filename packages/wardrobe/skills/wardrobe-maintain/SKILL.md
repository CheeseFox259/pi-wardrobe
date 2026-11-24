---
name: wardrobe-maintain
description: Fix a bug or add a requested capability in a standard Wardrobe preset.
---

# Maintain a preset

Call `wardrobe_workflow` with action `maintain`, the chosen profile or local source, and the concrete request. The result loads this shared method together with the preset’s design policy. Use that policy for product choices and preservation constraints.

A simple fix can use the existing single item. For multiple independent outcomes, save bounded `submission.work` items while forming the check plan: each has `id`, `origins` (the returned maintenance item ID), `goal`, affected relative `paths`, exact `checks`, and optional `dependsOn` implementation IDs. Use the current model and supplied component contracts to decompose the request once. Keep every requested outcome represented; a saved summary or decision does not finish declared implementation items.

Focus `implementation:<id>` for its actionable material. Save `{"work":[{"id":"<id>","ready":true}]}` inside `submission` when the implementation is ready for checking. The claim is tied to its affected candidate inputs and becomes stale when they change. `check` runs this item's checks with actual staged dependencies before final coverage; it never grants installation eligibility. Final `verify` checks all required work and the complete candidate.

Reproduce the relevant behavior in the returned candidate, inspect the affected implementation, and make the requested change. Declare resource changes through the tool submission. Resource `package` values are package aliases (for example `self` or `addon-7`), not npm/git sources; paths are safe relative resource paths. When removing a package declaration, include `retire` operations for its original catalog resources in the same save. Upstream upgrades use `wardrobe-update`; maintenance stays scoped to the request.

Once the relevant behavior and affected implementation support a scoped fix and check plan, make the change and save the conclusion promptly. Planned checks can run during `verify`; saving does not depend on completing verification. Expand investigation only for a named missing fact, dependency, or failure needed to resolve the request. Preserve existing behavior outside the request. If an explicit requirement depends on an unresolved product choice, save a finite blocker and continue independent work.

Before expanding an implementation investigation, include its `missingFact` (`question`, `why` it changes the decision, finite `nextStep`) in the next partial save. Ordinary related reads and edits need no extra management calls. Use the saved goal, current edits and prior conclusions after focus/resume. Rephrased summaries and questions do not refresh delivery; recovery points at the unfinished outcome.

When several items are present, use `focus` to choose or switch the current item without imposing an order. Fill the returned `nextCall` save template to preserve the summary, decisions, resource changes, and checks; review fields belong inside `submission`, for example `{"action":"save","submission":{"summary":"<completed fix>","checks":[]}}`. Save an item-addressed blocker with a finite next step when needed, and resolve it with `submission.resolvedBlockers`; independent items remain available. Run checks that demonstrate the requested behavior and preserve affected existing behavior. Final `verify` merges saved work with the supplied submission and reports failures to repair. Required work and blockers must be resolved before installation.

Submit affected checks through `save`; `verify` runs them with a fresh `HOME` and Pi agent directory. For an earlier shell diagnostic, set both `HOME` and `PI_CODING_AGENT_DIR` to fresh disposable directories: candidate tests can invoke installers and write settings.

For verification failures, select one concrete failure or shared cause, inspect its named implementation and installed dependency, make the repair, and save the partial change before expanding to another failure. Save the repair decision describing the partial fix, then use `verify` to measure remaining failures; a failed verification reopens the repair item.

At `READY_TO_INSTALL`, install with existing user authorization. `INSTALLED` confirms an installed revision, which remains inactive. Report what changed, verification evidence, and any remaining questions. Pi owns its program upgrade, model selection, and authentication.
