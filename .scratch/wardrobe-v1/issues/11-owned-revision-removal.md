# 11: Release references and remove only unreferenced owned revisions

Remote: https://github.com/CheeseFox259/pi-wardrobe/issues/19
Acceptance source: remote
Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8

Triage: ready-for-agent
Execution: complete
Claimed by: run-20261013T061939Z
Branch: ticket/11-owned-revision-removal
Blocked by: 09
Verified commit: b36a84c
Last attempt: none

## What to build

Read the authoritative remote ticket body at https://github.com/CheeseFox259/pi-wardrobe/issues/19.

## Acceptance criteria

Read the remote ticket body and relevant comments; the local ledger is not a second editable set of acceptance criteria.

## Delivered

`/wardrobe remove <id> [--revision <rev>]`, `/wardrobe release <id> --revision
<rev>` and `/wardrobe retain <id> --revision <rev>`. New: `removal.mjs` (pure
reference evaluation — active lease, strict pin, explicit retain — plus guarded
execution) and `retain.mjs` (the explicit-retain store the spec's `release`
presupposes). `StagingStore`/`LeaseStore`/`PlanStore`/`RetainStore` gained
identifier-validated delete methods. Deletion is confined by realpath inside
`staging/<planId>/`, re-verified immediately before `rmSync`, and refuses
missing paths, stale leases, escaping symlinks (including into sibling
revision roots) and unreadable records as ambiguous ownership. A removal
reports the session transcripts inside the deleted root by count and path;
script side effects are reported as not reversed.

## Commands and results

| Command | Result |
| --- | --- |
| `npm test` (final tree) | 138 tests, 138 pass, 0 fail, exit 0, ~472 s (128 prior, 10 new) |
| `test/owned-revision-removal.test.mjs` alone | 10 tests, 10 pass, 0 fail, ~51 s |
| working-tree review vs baseline `e93dcef` | Two passes on both axes, all as parallel reviewer subagents. Pass 1: 8 findings. Pass 2: verified pass 1 against source; 7 residual findings, all fixed |

Baseline: Pi 1.1.0, Node v26.5.0, npm 11.17.0, macOS arm64.

## Acceptance evidence

| Remote criterion | Covered by |
| --- | --- |
| Active revisions, strict bindings and explicit retain references block deletion; follow historical records alone do not pin all old revisions indefinitely | Tests 1, 2, 3 (strict pin / active lease / explicit retain each refuse) and test 4 (follow binding with migration history does not pin the old revision) |
| remove --revision deletes only a safe owned target; remove without revision refuses when any relevant target is referenced rather than partially deleting arbitrarily | Tests 1-3 for the targeted form; test 5 asserts wholesale refusal with every directory still present |
| release drops an explicit retention reference without deleting transcript or silently changing strict mode; strict binding changes must be deliberate before removal | Test 3 asserts the transcript file survives release, strict mode is unchanged, and removal succeeds only after release; re-binding is the only way a strict pin moves (ticket 09) |
| Native package cleanup operates only in the selected owned revision root; identical sources in other revision directories and personal resources/settings/auth remain intact | Test 6 asserts sibling revision directories, personal settings, sentinels and install-script marker events are intact |
| Missing paths, stale leases, escaping symlinks or ambiguous ownership are diagnosed/refused, not used to delete arbitrary directories. Script external effects are not claimed reversed | Tests 2, 7, 10: stale lease diagnosed (not silently honoured), escaping symlinks refused (outside staging and into a sibling), missing paths diagnosed, corrupt records refused as ambiguous ownership, `assertSafeId` rejects traversal; removal reports `scriptExternalEffectsReversed: false` |
| An intact remaining revision can launch/resume after removal, and returning to the user's original environment preserves observed preferences/sentinels | Test 8 launches the surviving revision through `wardrobe run`; test 6 asserts the personal environment is byte-intact |

## Behaviour changes this ticket makes on purpose

- **`/wardrobe retain` exists though the spec names only `release`.** Explicit
  retain references presuppose a creation path; retain is the minimal honest
  one. Disclosed here rather than hidden.
- **Removing a revision deletes the transcripts stored inside its root** (they
  are the revision's own runtime data and are not among the criteria's
  blockers) — but never silently: the removal result names count and paths.
- **A bare `--revision` without a value is an argument error**, never a silent
  fallback to wholesale deletion.

## Findings the review forced

Pass 1 (both axes, parallel reviewer subagents), all fixed: confinement checked
only the latest attempt while deletion removed every attempt; the boundary
check admitted sibling revision roots inside staging; store deletes took
identifiers without traversal validation; deletion was not re-verified at
execution time (TOCTOU); `--revision` matched only literal plan ids while the
README promised selector resolution; removal destroyed in-root transcripts
silently; the resolve/validate block was triplicated.

Pass 2 (both axes, parallel reviewer subagents), verified pass 1 against source
and found, all fixed: a bare `--revision` flag fell through to wholesale
deletion; `StagingStore.delete` destroyed the metadata record before
confinement was verified; wholesale removal ignored unreadable staging records;
a corrupt staging record surfaced as an unhandled SyntaxError instead of an
ambiguous-ownership refusal; a misnamed variable, triplicated confinement logic
and inline retain listing in the command handler.

## Scope and limits

Remote ticket #19 was not edited, labelled, assigned or closed. Nothing was
pushed and no PR was created; the caller owns branches and merging.

No automatic garbage collection: nothing is deleted except on an explicit
remove. Deliberately deferred: the startup selector and `--wardrobe`
forwarding (12), the reference presets (13, 14), and the integrated V1 path
(15).
