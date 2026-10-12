# 09: Persist bindings and resume follow or strict sessions

Remote: https://github.com/CheeseFox259/pi-wardrobe/issues/17
Acceptance source: remote
Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8

Triage: ready-for-agent
Execution: complete
Claimed by: none
Branch: none
Blocked by: 07
Verified commit: b69a89f2a50cefbba3f0a61fbde9118995972ec0
Last attempt: none

## What to build

Read the authoritative remote ticket body at https://github.com/CheeseFox259/pi-wardrobe/issues/17.

## Acceptance criteria

Read the remote ticket body and relevant comments; the local ledger is not a second editable set of acceptance criteria.

## Delivered

`/wardrobe bind` records what a preset is meant to run and reports it.
`/wardrobe use` and `wardrobe run` resolve it: follow takes the newest approved
available revision of that preset, strict takes the pinned one or refuses.
`wardrobe run --resume <path>` continues a conversation Pi already persisted.

New: `binding.mjs` (the binding store, follow/strict resolution, migrations and
the per-process launch records) and the `bind` command. `identity.mjs` gained
`repositoryKeyOf`/`repositoryOf`; `launch.mjs` resolves a binding and refuses
unmet requirements before anything is started; `status`, `doctor` and `explain`
report bindings, migrations and restrictions.

Usage is in `packages/wardrobe/README.md`, under "Bindings, follow and strict".

## Commands and results

| Command | Result |
| --- | --- |
| `npm test` | 122 tests, 122 pass, 0 fail, exit 0, ~341 s (116 prior, 6 new) |
| `test/bindings-resume.test.mjs` alone | 6 tests, 6 pass, 0 fail, ~64 s |
| working-tree review vs baseline `8e74068` | Two passes on both axes. Pass 1: 2 parallel reviewer subagents, 13 findings, all fixed. Pass 2: run in the parent after both subagent dispatches failed with a transport error |

Baseline: Pi 1.1.0, Node v26.5.0, npm 11.17.0, macOS arm64.

## Acceptance evidence

| Remote criterion | Covered by |
| --- | --- |
| Binding records identity, mode, effective revision/config hash, soft override data and migration evidence; custom-entry-only startup is transient, with owned launch coordination separate from a durable conversation | `bindRequest` records preset, mode, pin, `configurationDigest`, soft data and append-only migrations; `LaunchRecords` is the separate per-process coordination store. Test "follow runs the newest approved revision and records the migration" asserts the binding is keyed canonically, records its mode, resolves to the third approval, and that `bind` reports the last launch |
| Follow resume automatically preflights the newest approved available same-source/same-ID revision and records old/new migration without repeated manual approval; explicit restrictions or unavailable requirements still refuse | `resolveBinding`. Test "follow runs the newest…" uses versions 1.0.0, 2.0.0, 0.9.0 in that approval order and asserts the 0.9.0 revision wins — approval order, not a label. Test "a follow migration records both revisions and changes nothing retroactively" asserts both revisions are recorded, the earlier revision is untouched and still `available`. Tests "a binding that cannot be satisfied is reported, never as healthy" and "a declared requirement the session cannot meet refuses the launch" cover restrictions and unmet requirements |
| Strict resume restores the intact exact revision or refuses missing/drifting resources, with explicit recovery/mode-change choices and no silent substitution | `resolveBinding` strict branch. Test "strict refuses a missing revision and never substitutes a newer one" asserts strict mode cannot be recorded without a revision, a newer approval does not move it, and a pin that has gone refuses with the way out named and no other revision mentioned |
| UI exposes deliberate follow/strict/target change; approved credentials/runtime/data are not included in code fingerprints | `/wardrobe bind --mode` and `--revision` are the only way either changes; `writeLaunchSession` records the revision's declared persona and tools in its own runtime data, outside the locked code roots |
| Old messages and loaded Skill text remain unchanged; concurrent revision leases and real session-directory behavior are respected | Test "a conversation persists in one process and resumes in another" asserts the first process persisted the conversation, a second process recovered the same messages, the resumed session file starts with the first process's history as an unchanged prefix, and the run record names the session it resumed. Leases are unchanged from ticket 07 |
| A controlled real Pi subprocess persists a conversation via a local provider and resumes it in another process without live model credentials | The fixtures' local provider answers both processes; no credential exists in either. Asserted in the same test, with the recovered message count recorded |
| status/doctor/explain show active versus desired follow/strict mode and revision, mismatch/unavailability/drift, migration provenance and restrictions; failed recovery never reports healthy | `bindingsDesiredBy` and `bindingAwareSummary`. Test "a binding that cannot be satisfied is reported, never as healthy" asserts both `status` and `doctor` report `unmet-binding` rather than `available`, and that the text names the restriction |

## Behaviour changes this ticket makes on purpose

- **A preset's identity is its repository, not its pin.** `repositoryKeyOf`
  strips a commit or version from a locator. This changes how every caller
  compares presets: previously three revisions of one preset were three
  presets, and a follow binding could not see its own siblings.
- **An unmet requirement now refuses a launch** instead of being noted and
  ignored. A review approved an environment that wanted it; running without it
  is a different environment.
- **`/wardrobe install` honours `--disable-tool`** the way `explain` already
  did, so a plan can be approved knowing which requirements the session will
  not be allowed to meet.
- **A binding that cannot be satisfied counts against health**, so a failed
  recovery cannot read as healthy.

## Findings the review forced

Pass 1 (Standards and Spec, working-tree mode, baseline `8e74068`, parallel
reviewer subagents), all fixed:

- **A bad `--resume` path leaked the lease and the signal handlers**, because it
  was checked after the lease was taken. It is now decided before anything is
  acquired.
- **Re-binding by a short id read no previous binding** and so silently reset
  its migration history and creation time. It now reads by the canonical key.
- **`show` and `explain` compared a pinned preset key against unpinned ones**,
  so their revision lists could never match.
- **Strict recorded no migration for its first launch**, unlike follow.
- **`resolvePresetKey` did not strip pins from the key it was given**, so a key
  printed by another command would not resolve.
- **Restrictions were accepted and then ignored.** A resolution now refuses when
  a requirement cannot be met or a restriction is in force.
- **A binding recorded no configuration hash**, no effective revision and no
  soft override data.
- **`explain` reported no bindings at all**, and `status`/`doctor` listed them
  without comparing them with what was running.
- **`doctor` reported `available` while a strict binding was unmet** — a failed
  recovery reading as healthy.
- Missing WHY comments on the new exported classes and methods, a redundant
  ternary, a field nothing read, and a duplicated report line.

## Scope and limits

Remote ticket #17 was not edited, labelled, assigned or closed. Nothing was
pushed and no PR was created; the caller owns branches and merging.

Not done here, and why: tree navigation and fork semantics belong to ticket 10
and are untouched. A binding is consulted at launch; nothing in this ticket
swaps an executable revision inside a running process, and that is deliberate
rather than missing.

Deliberately deferred: binding reconciliation on tree navigation (10), owned
revision removal and release (11), the startup selector and `--wardrobe`
forwarding (12), the reference presets (13, 14), and the integrated V1 path
(15).

## Review disclosure

Pass 1 ran as two parallel `subagent` reviewer tasks. The pass-2 dispatch failed
twice with a transport connection error, so both axes were performed in the
parent against the same immutable packet, with each first-pass finding verified
against the current source rather than assumed fixed. No independent second-pass
review was obtained for this ticket.
