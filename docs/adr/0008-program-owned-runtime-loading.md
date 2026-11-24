# Program-owned runtime loading and separate capability review

Accepted on 2026-10-24 following the user's grill confirmation.

Paid trial #39 accepted no update work. Its initial runtime item combined the entire migration request, all extensions and release notes under one open-ended decision. A successful load and a complete capability review had no distinct completion boundaries.

The program owns the basic runtime loading check. For a new update with a Pi version change, it materializes the isolated candidate and executes the native loading check without a model decision. A successful result completes only this check. A failure returns concrete diagnostics and remains pending until the actual candidate passes. Cancellation preserves the pending candidate for explicit resume.

Runtime capability review remains model work. Exact release-note text is partitioned into bounded, individually required reviews, without summarization or omission. Missing release evidence is unresolved work, not an optional feature that can simply be deferred. The loading check and these reviews cannot be merged into one broad item.

Explicit integration requirements remain a separate required item, including when upstream discovery reports no changes. They cannot be deferred into a completed workflow. Optional changes with ambiguous behavior retain the previously agreed defer policy. Successful loading never grants installation permission or substitutes for affected behavior checks.

Unchanged runtime reviews with no additional checks or presentation obligations can record decisions without rebuilding the candidate. Candidate edits and obligations retain mandatory verification. Installation continues to require the final sealed candidate and valid verification evidence; a no-change review creates no installed revision.

The rules apply to all presets. Existing saved workspaces retain their historical queue and semantics; this decision governs newly prepared updates. Immutable trial evidence is not rewritten. The earlier requirement to isolate blocked items and continue independent items remains separate unfinished work.
