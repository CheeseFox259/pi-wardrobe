# 05: Approve and install a preset with resources inactive

Remote: https://github.com/CheeseFox259/pi-wardrobe/issues/13
Acceptance source: remote
Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8

Triage: ready-for-agent
Execution: complete
Claimed by: none
Branch: none
Blocked by: 04
Verified commit: ad2a09eacb1efb535622870c608ae6dc46010967
Last attempt: none

## What to build

Read the authoritative remote ticket body at https://github.com/CheeseFox259/pi-wardrobe/issues/13.

## Acceptance criteria

Read the remote ticket body and relevant comments; the local ledger is not a second editable set of acceptance criteria.

## Delivered

`/wardrobe install <source> --confirm <digest>` approves the exact plan that was
displayed and installs it. `/wardrobe install <source>` alone still only
reviews. Nothing is activated: a staged revision's resources stay filtered out.

New manager modules: `install.mjs` (approval gate, artifact verification, the
install attempt, inventory and failure recording) and `staging.mjs` (owned
staging directories, revision records, residual reporting, the projection a
result reports).

Usage is in `packages/wardrobe/README.md`, under "Installing an approved plan".

## Commands and results

| Command | Result |
| --- | --- |
| `npm test` | 88 tests, 88 pass, 0 fail, exit 0, ~58 s (76 prior, 12 new) |
| working-tree review vs baseline `e889b0a` | Two passes, Standards and Spec axes, both ran; every finding fixed or verified — see below |

Baseline: Pi 1.1.0, Node v26.5.0, npm 11.17.0, macOS arm64.

## Acceptance evidence

| Remote criterion | Covered by |
| --- | --- |
| An approved plan installs real npm/Git sources through Pi into owned staging | `src/install.mjs`, `src/staging.mjs`; tests "an approved plan installs through Pi with every resource filtered inactive" and "a git package is installed at the approved commit" both assert `pi list` in the staging directory and the installed version or commit |
| The plan still matches approved artifacts before and during installation | pre-install `verifyArtifacts` re-resolves every npm artifact against the registry and checks each git artifact against its own pinned source; post-install the inventory compares the installed version or commit. Tests "an artifact that no longer matches the approved plan installs nothing" and "an identity that cannot be read is a mismatch, not a pass" |
| Git/npm self source `.` uses its pinned native source | `installSourceOf`; tests "a git package is installed at the approved commit" and "an npm self source installs as its own pinned npm source" |
| Dependency-bearing local snapshots do not silently skip installation requirements | a self source with no pinned native source is refused before any directory is created; test "a self source with no pinned native source refuses to install" |
| All package resources remain filtered inactive; Extension markers prove no pre-activation load | `inactiveSettings` before the install and `assertInactive` after it; tests "an approved plan installs through Pi…" (asserts the staged `settings.json` and `pi list`'s `(filtered)`) and "a staged revision loads nothing in a real Pi process" (starts a real Pi against the staging directory: the fixture command is not registered, its tool is not active, and the extension load count does not move) |
| Cancellation/no approval/invalidated digest runs no installer; settings and user files stay intact | tests "an unapproved plan runs no installer and leaves no staging", "an invalidated digest runs no installer" (both assert no staging directory and no install-script marker), and "installing never touches the user's own agent directory" |
| Failure leaves an explicitly failed/unavailable record with residual files and script effects, claiming no rollback; existing available revisions survive | `src/install.mjs`; test "a failed install is retained as failed, keeps its residual files, and a retry starts clean" and "an available revision is never reinstalled in place" |
| A retry is possible without treating retained failed effects as undone | the same failure test: attempt 2 is a new directory, attempt 1's files still exist, and the refusal states the earlier attempt is retained |
| Preliminary inventory is distinct from verified launch availability | `stagingViewOf` reports `verifiedLaunchable: false` and the text says launch availability is not verified; asserted in the install test |

## Behaviour changes this ticket makes on purpose

- `digestMatches` ignores the `approved` record. Recording an approval adds a
  field to the stored plan, and the digest covers what was approved, not that it
  was approved; otherwise no approved plan could ever be installed.
- `--confirm` now installs. The ticket-03 approval check asserts the new state
  and that the staged revision has nothing in it for a package-free preset.
- `/wardrobe explain` and `show` still never install; only `install --confirm`
  does.

## Findings the review forced

First pass (Standards and Spec, working-tree mode, baseline `e889b0a`):

- An installed identity that could not be read passed verification as a match.
- A verification failure reported zero residual files.
- A bare alias was used as a diagnostic path instead of a JSON pointer.
- An unused multi-revision listing helper; duplicated npm source parsing;
  a confusing `installed`/`inventory` split in the record; and the command
  layer navigating record internals.
- The integrity mismatch path and the filter-degradation path had no check.

Second pass verified those fixes and found three more, all fixed:

- **An npm self source was verified against `"."`** and would have failed every
  self-source install. Both reviewers found this independently; it is now
  pinned by a real npm self-source install.
- A git checkout with no readable path fell through verification as "unknown"
  instead of failing.
- `assertInactive` only re-asserted the plan's own packages, so a declaration
  the installer added on its own would have been left unfiltered.

## Scope and limits

Remote ticket #13 was not edited, labelled, assigned or closed. Nothing was
pushed and no PR was created; the caller owns branches and merging.

Not done here, and why: the revision lock — canonical configuration hash,
selected-resource content hashes, dependency/code fingerprint and the
Pi/Node/npm/platform baseline — belongs to ticket 06, which owns drift
diagnosis. Post-install verification here is the installed identity (exact npm
version, exact Git commit) plus the artifact re-check against the registry
before the install; npm does not record the tarball integrity in the installed
manifest, so a content-level fingerprint of the installed tree is ticket 06's
lock, not this one. Nothing here verifies that a process can start against a
staged revision; the record says so explicitly.

Deliberately deferred: revision locks and drift (06), launching a verified
revision (07), session overrides (08), removal of owned revisions (11).
