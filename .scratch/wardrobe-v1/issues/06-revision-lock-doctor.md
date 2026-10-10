# 06: Verify immutable revisions and diagnose drift

Remote: https://github.com/CheeseFox259/pi-wardrobe/issues/14
Acceptance source: remote
Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8

Triage: ready-for-agent
Execution: complete
Claimed by: none
Branch: none
Blocked by: 05
Verified commit: 55ad4e5b0794f04b1b189b3f1b96741ef3e0365b
Last attempt: none

## What to build

Read the authoritative remote ticket body at https://github.com/CheeseFox259/pi-wardrobe/issues/14.

## Acceptance criteria

Read the remote ticket body and relevant comments; the local ledger is not a second editable set of acceptance criteria.

## Delivered

An installed revision is measured, not trusted. The install path derives a lock
from the files that are actually on disk, and an install is only reported
`available` when that measurement is complete.

New manager modules: `lock.mjs` (the four measurements and their exclusions),
`doctor.mjs` (re-measurement and diagnosis) and `revisions.mjs` (reading
records and their plans back out of owned storage). `staging.mjs` gained
`list()`; `install.mjs` records the lock and re-verifies one before reuse;
`semver.mjs` gained range resolution.

`/wardrobe status [revision]` and `/wardrobe doctor [revision]` are new, and
`list`, `show` and `explain` now report installed revisions too. Usage is in
`packages/wardrobe/README.md`, under "Revision locks and drift".

The four measurements: a canonical digest of the approved effective
configuration; one SHA-256 per selected resource, resolved through Pi's own
inventory; a fingerprint of every installed package tree under `npm/` and
`git/`, with a digest per package and per installer-metadata root; and the
Pi/Node/npm/platform baseline. Declared runtime data (`sessions/`,
`wardrobe/`) sits outside the locked code roots and is listed, never hashed.

Five states, none of them a softer version of "fine": `available`, `drifted`,
`unverified`, `failed`, `missing`.

## Commands and results

| Command | Result |
| --- | --- |
| `npm test` | 98 tests, 98 pass, 0 fail, exit 0, ~190 s (88 prior, 10 new) |
| working-tree review vs baseline `a1a9f98` | Two passes, Standards and Spec axes. Pass 1 ran on parallel reviewer subagents: 11 findings, all fixed. Pass 2's subagent dispatch failed with a connection error, so both axes were re-run in the parent against the same packet and every finding verified against the current source; one further defect found that way and fixed |

Baseline: Pi 1.1.0, Node v26.5.0, npm 11.17.0, macOS arm64.

## Acceptance evidence

| Remote criterion | Covered by |
| --- | --- |
| Availability requires approved exact sources/integrity, deterministic effective configuration hash, selected resource/code and installed dependency fingerprints, and runtime/toolchain/platform baseline | `measureRevision` returns `problems` for an absent code root when packages are installed, an unreadable npm version, an unidentified Pi build, and any selected resource that cannot be hashed; `installApprovedPlan` sets `available` only when that list is empty. Test "an installed revision publishes a complete lock" asserts all four parts and then re-measures to `available` |
| Fingerprints exclude credentials, Git internals and approved mutable runtime data; runtime data is outside locked code roots | `EXCLUSIONS` in `lock.mjs`: `.git` directories are skipped during the walk and recorded as skipped, credential file names are filtered, `runtimeDataRoots()` are declared outside `CODE_ROOTS` and never hashed. Test "git internals and credentials are excluded; installed code is not" plants an `auth.json`, an `.npmrc` and a `.git` tree inside the installed package, asserts the lock digest is unmoved and that the secret value appears nowhere in the report, then edits installed code and asserts drift naming the package. `hashResource` applies the same exclusions to a selected directory |
| Unexpected code/dependency/config drift is identified and refuses healthy/available launch state, rather than silently accepting it as an update | `diagnoseRevision` returns `drifted` and never `available`; `drift` entries name the component and path. Re-running an approved install calls `diagnoseRevision` first and replaces a drifted revision with a fresh attempt instead of handing it back. Tests "a changed selected resource is drift, never an accepted update", "a changed selected resource … removed" and "a drifted revision is replaced by a fresh attempt, never handed back" |
| Separate approved revisions preserve independently owned storage; native same-repo refs never mutate an existing revision | Each revision gets its own attempt directory and its own lock. Test "separate approved revisions keep independently owned storage" installs two revisions, then installs a second commit from the *same* repository and asserts the first revision's directory, lock digest and `available` state are unchanged |
| Missing or different reconstruction is not reported as the original exact revision; no unconditional frozen-transitive-rebuild promise | `diagnoseRevision` returns `missing` for an absent directory and keeps the recorded state visible beside it; `installApprovedPlan` only reuses a record whose directory exists *and* re-measures as available. There is no rebuild path in the module. Test "a missing revision is not reported as the original exact revision" deletes the directory, asserts `missing` with the record still saying `available`, asserts nothing was rebuilt, and asserts the retry lands in a new attempt |
| Status/doctor distinguish intended configuration from observed available state and unsupported/unverified environments without exposing secrets | `oneLine()` carries `recorded` and `state` side by side and no derived `healthy` boolean; `renderDiagnosis` prints both. `environmentUnverified` reports an unresolved range, an unidentified Pi build and an undeclared platform as unanswerable rather than satisfied. Test "status and doctor report intended configuration beside observed state" asserts the rendered `(recorded available)` marker and `drift [code]` lines; the exclusion test asserts no secret reaches a fingerprint or diagnosis |

## Behaviour changes this ticket makes on purpose

- **`plan.declaration` now carries `compatibility`.** The declared range says
  which Pi builds an approved environment may run on, so it is part of the
  configuration the lock covers. This changes the plan digest; both sides of
  every review-then-approve flow recompute it, so nothing needed migrating.
- **An install re-measures before reusing a revision.** Re-approving an
  unchanged plan now costs one extra measurement and returns the same revision
  with `alreadyAvailable: true`.
- **A record whose attempt directory has disappeared is installed again.** The
  record says what an install once did, not what is there now.
- **`previousAttemptsRetained` lists only attempts whose files still exist**, so
  the text that says "retained on disk" stays true.
- **The controlled npm fixture now ships the skill it advertises.**
  `fixtures/lib/payloads.mjs` writes `skills/review/SKILL.md` and declares it in
  the package manifest. Ticket 05's presets selected that path; until now the
  package did not carry it, which a content-hashing lock correctly refuses.

## Findings the review forced

Pass 1 (Standards and Spec, working-tree mode, baseline `a1a9f98`, parallel
reviewer subagents):

- `oneLine()` exported a derived `healthy` boolean, re-introducing exactly the
  binary health spectrum the state model exists to avoid.
- A configuration digest was compared against the whole lock rather than the
  lock's configuration, so every revision reported drift in every field.
- `measure()` never returned `drift`, but two branches set `drift: measured.drift`,
  leaving the field `undefined`.
- A null Pi baseline and the declared `platforms` list were never checked, so an
  unidentified toolchain could still support an available claim.
- Re-approving an install handed back any record that said `available` whose
  directory existed, without re-verifying the lock.
- `hashResource()` hashed a selected resource directory with no exclusions
  filter, so a credential inside it entered a reported fingerprint.
- `return doctor(...)` without `await` inside a `try`, so a refused selector
  escaped as an unhandled rejection instead of a reported refusal.
- `StagingStore.find()` was dead code with a JSDoc describing a match it never
  performed; `resolveRevision()` was dead ticket-07 code; `presetKeyOf()`
  duplicated `identityKey()`; `piCliOf()` duplicated install's `piCli()`.
- The README documented only three commands reporting revisions; `explain` did
  too, and the documentation was what was wrong.

## Scope and limits

Remote ticket #14 was not edited, labelled, assigned or closed. Nothing was
pushed and no PR was created; the caller owns branches and merging.

Not done here, and why: launching a verified revision is ticket 07. `launchable`
is reported as `false` throughout, and a revision that measures as `available`
is still a revision nothing has ever started.

Deliberately deferred: launching a verified revision (07), session overrides
(08), follow/strict resume (09), owned revision removal (11).

## Review disclosure

Pass 1 ran as two parallel `subagent` reviewer tasks and reported 11 findings
across both axes. The pass-2 dispatch failed twice with a transport connection
error, so both axes were performed in the parent against the same immutable
packet, and each first-pass finding was verified against the current source
rather than assumed fixed. That pass found one further defect — a
`drift: measured.drift` left over in the failed-attempt branch — which is
fixed. No independent second-pass review was obtained.
