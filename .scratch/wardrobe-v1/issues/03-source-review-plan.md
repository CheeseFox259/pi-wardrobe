# 03: Discover source presets and approve an immutable review plan

Remote: https://github.com/CheeseFox259/pi-wardrobe/issues/11
Acceptance source: remote
Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8

Triage: ready-for-agent
Execution: complete
Claimed by: none
Branch: none
Blocked by: 01, 02
Verified commit: d631c0e878978d2407895400fe775ee76cb97300
Last attempt: none

## What to build

Read the authoritative remote ticket body at https://github.com/CheeseFox259/pi-wardrobe/issues/11.

## Acceptance criteria

Read the remote ticket body and relevant comments; the local ledger is not a second editable set of acceptance criteria.

## Delivered

`/wardrobe install <source>` captures a source and produces an immutable review
plan. It installs nothing; installation integration is ticket 05.

New manager modules: `github.mjs`, `git-source.mjs`, `npm-source.mjs`,
`npm-import.mjs`, `discover.mjs`, `review.mjs`, `plan.mjs`, `approval.mjs`,
`proc.mjs`, `presets.mjs`. Usage is in `packages/wardrobe/README.md`.

Harness: `fixtures/lib/git-repo.mjs`, a reusable controlled-repository builder
used by both the shipped fixture and by these checks.

## Commands and results

| Command | Result |
| --- | --- |
| `npm test` | 57 tests, 57 pass, 0 fail, exit 0, ~31 s (45 prior, 12 new) |
| working-tree review vs baseline `79d5d1b` | Both axes found real defects, all fixed — see below |

Baseline: Pi 1.1.0, Node v26.5.0, npm 11.17.0, macOS arm64.

## Acceptance evidence

| Remote criterion | Covered by |
| --- | --- |
| Bare Git exercises real retrieval at full commits | `src/git-source.mjs`, `test/discovery-review-plan.test.mjs` "a Git source is really fetched at a full commit" |
| GitHub normalization with controlled responses, not live verification | `src/github.mjs` (pure, no network), test "GitHub references normalize to one canonical source" |
| Exact npm source, integrity and version captured without lifecycle execution | `src/npm-source.mjs`, `src/npm-import.mjs`, test "an npm source is captured with integrity and runs no install script" |
| Discovery does not delegate to a native install before approval | every result reports `installed: false, active: false`; no `pi install` is invoked anywhere in the manager |
| Self resources use the captured root; missing/escaping/symlink paths fail before install | `resolvePackagePath` + `checkSelfContainedResources`, tests "a resource path that escapes or is missing is refused before a plan" and "a symlinked resource path is refused" |
| Self source `.` resolves to the captured package's pinned native source | `src/review.mjs`, test "a self source '.' resolves to the captured package's pinned source" |
| Multi-preset repositories require selection; equal ids stay distinct | `src/commands.mjs`, tests "a multi-preset repository requires explicit selection" and "equal ids in two repositories stay distinct" |
| Preview names all surfaces and exact artifacts; cancellation mutates nothing | `src/plan.mjs`, `src/render.mjs`, tests "the preview names every install and load surface and exact artifact" and "cancelling leaves no managed install or configuration change" |
| Noninteractive approval tied to a displayed digest, invalidated by changes; no blanket consent | `src/approval.mjs`, test "approval is bound to the displayed digest and invalidated by changes" |

## Findings the review forced

- The resource-path guard was exported but **never called**, so escaping and
  missing paths reached sealed plans. It is now called, with its own coverage.
- `resolvePackagePath` failed open on a package root with a trailing separator.
- `runCommand` returned an async promise from inside `try`, so discovery failures
  escaped as unhandled errors instead of reported refusals.
- Load surfaces were double-counted; manifest surfaces were looked up in the
  wrong directory for nested presets.
- Recapturing the same source failed with "remote origin already exists".
- Git dependencies were missing from the plan's artifact list.
- Preset discovery probed one level deep, hiding `presets/<name>/preset.json`.

## Scope and limits

Remote ticket #11 was not edited, labelled, assigned or closed. Nothing was
pushed and no PR was created; the caller owns branches and merging.

Deliberately deferred: installation and activation (05), revision locks and
drift (06), inheritance provenance (04), the Minimal Coding reference preset (14).
