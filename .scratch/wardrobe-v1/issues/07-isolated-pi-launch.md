# 07: Launch a verified preset in a real isolated Pi process

Remote: https://github.com/CheeseFox259/pi-wardrobe/issues/15
Acceptance source: remote
Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8

Triage: ready-for-agent
Execution: complete
Claimed by: none
Branch: none
Blocked by: 06
Verified commit: fe95880
Last attempt: none

## What to build

Read the authoritative remote ticket body at https://github.com/CheeseFox259/pi-wardrobe/issues/15.

## Acceptance criteria

Read the remote ticket body and relevant comments; the local ledger is not a second editable set of acceptance criteria.

## Delivered

`wardrobe run <revision>` starts a verified revision in a real Pi process.
`/wardrobe use <revision>` and `wardrobe use <revision>` emit the launch plan and
start nothing. Reading state stays with `/wardrobe status` and `/wardrobe
doctor`; the launcher was not given a second implementation of them.

New: `bin/wardrobe.mjs` (the standalone command), `launch.mjs` (activation,
preflight, probe and process lifecycle), `lease.mjs` (revision ownership) and
`probe.mjs` (observing a real Pi's loaded state over RPC). `commands.mjs` gained
`/wardrobe use`; `package.json` declares the `bin`.

Usage is in `packages/wardrobe/README.md`, under "Launching a revision".

## Commands and results

| Command | Result |
| --- | --- |
| `npm test` | 110 tests, 110 pass, 0 fail, exit 0, ~365 s (98 prior, 12 new) |
| `test/isolated-pi-launch.test.mjs` alone | 12 tests, 12 pass, 0 fail, ~164 s |
| working-tree review vs baseline `bc23ba1` | Two passes on both axes. Pass 1: 2 parallel reviewer subagents, 14 findings, all fixed. Pass 2: run in the parent after the subagent transport failed twice on ticket 06; every pass-1 finding verified against the current source, plus three more defects found and fixed |

Baseline: Pi 1.1.0, Node v26.5.0, npm 11.17.0, macOS arm64.

## Acceptance evidence

| Remote criterion | Covered by |
| --- | --- |
| Launch uses its dedicated revision agentDir and explicit session directory, retains user/CLI selection precedence and independently provisioned auth; no personal auth/MCP files are silently copied/symlinked | `runRevision` spawns Pi with `PI_CODING_AGENT_DIR` set to the revision's directory and injects `--session-dir` unless the caller named one; tool selection is written as `+name`/`-name` entries so Pi's `--tools` still wins. Tests "a launch is isolated…" (the user's directory is byte-identical afterwards, no `.npmrc`/`.netrc`/credentials appear, and the one `auth.json` is Pi's own empty store) and "the child is told which session directory to use" (the spawned argv carries the revision's session dir, and the shared session store is untouched) |
| Actual selected Extensions/Skills/Prompts/Themes and tools load through native resource mechanisms; command/registration collisions and unmet tool/resource requirements are diagnosed, not hidden | `observeSelection` starts a real Pi in RPC mode against the activated revision and compares `get_commands` with the plan. Test "a launch makes the approved selection load through Pi's own mechanisms" asserts the extension's command and the skill's command both registered and that `sourceInfo.path` points inside the revision. `reconcileSelection` names missing resources and collisions; a missing observable resource or a collision refuses the launch, and what cannot be observed is reported as unverified |
| A second writer/run to the same revision is refused; independent revisions may have separate processes. Release owned leases on orderly exit and diagnose stale ownership without stealing live work | `LeaseStore`. Tests "a second run of one revision is refused…" (the refusal names the holding pid; a different revision runs concurrently), "stale ownership is diagnosed and replaced…" (a dead pid's lease is replaced and reported; a live lease held by this very process is refused and left untouched), "a lease that cannot be read is treated as held, not absent", and "an unusable session directory…" (a refused launch takes no lease) |
| `/wardrobe use` emits a new-process launch plan for resource/code/package differences, refuses while busy, and never embeds another TUI or claims to clean arbitrary old Extension effects | `launchPlanOf` and `renderUse`. Test "use emits a launch plan, starts nothing, and refuses while a revision is busy" asserts the resource, package and tool differences, the exact command, `inProcess: false`, that no run record was written, that the rendered plan says nothing was started, and that a busy revision is refused by both forms |
| Child cwd/arguments/signals/exit status are handled correctly; closing a controlled process ends its own interval/global state, without claims about detached descendants or external writes | `runRevision` forwards SIGINT/SIGTERM and records them. Test "child working directory, arguments and exit status are the child's" asserts a failing child produces a non-zero exit and a recorded exit code, that argv after `--` reach Pi unchanged, and — by asking the launched process itself over RPC — that it ran in the directory the launcher was started in; a signalled run records the forwarded signal, ends, and releases its lease |
| Failed startup/preflight preserves prior revision availability and diagnostics; no false healthy/active transition or personal baseline mutation | Tests "a refused launch leaves the revision exactly as it was" (drift refuses, no lease, no run record, the drifted bytes and the staged settings unchanged, and `status` still reports `drifted` beside the recorded `available`), "an unusable session directory is refused before anything starts", and "resource roots Pi discovers outside the revision are named, not hidden" |

## Behaviour changes this ticket makes on purpose

- **A launch activates the revision and leaves it activated.** That is the only
  thing it writes, and it is outside the locked code roots, so it never
  invalidates the lock. Anything that does not complete puts the settings back.
- **`wardrobe` requires an explicit agent directory.** `PI_CODING_AGENT_DIR` is
  inherited by every process Pi starts, so honouring it would mean launching into
  a caller's personal environment whenever the launcher ran from inside a
  session.
- **A selected resource that does not load, or a command two resources register,
  refuses the launch.** The user approved one selection; handing them a different
  one is not a launch.
- **The launcher only has `run` and `use`.** `status`, `doctor` and `list` are
  slash commands; duplicating them was scope this ticket did not ask for.

## Findings the review forced

Pass 1 (Standards and Spec, working-tree mode, baseline `bc23ba1`, parallel
reviewer subagents). Both reviewers independently found the first two.

- **The spawned Pi was never told which session directory to use.** The record
  claimed one, Pi used whatever its environment said, and in the fixture that
  was a shared store — the exact isolation failure the criterion forbids. Fixed
  by injecting `--session-dir` unless the caller named one, and the run record
  now reports the argv Pi was actually started with.
- **A child that failed to spawn reported "the revision is unchanged" while the
  settings were still activated.** The spawn error resolved the promise rather
  than rejecting, so the restore path was skipped.
- **A lease and the signal handlers leaked when anything between them and the
  child threw** — including the session directory that could not be created.
- **`use` treated an unreadable lease as absent**, because `leaseViewOf` reported
  `alive: null` while `acquire` treated the same lease as held. One answer now:
  `isStale`.
- **The module header claimed collisions and missing resources refuse the
  launch** when the code only reported them. The behaviour was changed to match
  the claim, and the header now says what is and is not observable.
- `wardrobe status`, `doctor` and `list` were scope creep; removed.
- `LeaseStore.list()` was dead code; removed. `main` gained the reason it exists.
- A duplicated JSDoc block above `diagnoseAll`; removed.

Pass 2 (in the parent, after two failed `subagent` dispatches — disclosed below):
every pass-1 finding was verified against the current source rather than assumed
fixed, which surfaced three more:

- `use` refused an unreadable lease with "unknown pid null on undefined" instead
  of naming the real problem. Both refusal sites now share `leaseReason`.
- `prepareSessionDir` was still outside the `try`, so a launch that could not
  create its session directory kept its lease. Found by the test that asserts no
  lease is left behind.
- `isStale` had been un-exported while two modules imported it; `node --check`
  does not catch a missing export, so a whole suite run failed on it. Every
  module is now imported as a smoke check before the suite runs.

## Scope and limits

Remote ticket #15 was not edited, labelled, assigned or closed. Nothing was
pushed and no PR was created; the caller owns branches and merging.

Not done here, and why: an interactive TUI launch was exercised through Pi's RPC
mode rather than a terminal. Every assertion about loading, isolation, leases,
signals and exit status comes from real Pi processes; what was not exercised is a
human typing at a full-screen session, which the acceptance criteria do not ask
for and which no assertion here could decide.

Deliberately deferred: idle session overrides (08), follow/strict resume (09),
binding reconciliation (10), owned revision removal (11), the startup selector
and `--wardrobe` forwarding (12), the reference presets (13, 14), and the
integrated V1 path (15).

## Review disclosure

Pass 1 ran as two parallel `subagent` reviewer tasks and reported 14 findings
across both axes. The pass-2 dispatch failed twice with a transport connection
error, so both axes were performed in the parent against the same immutable
packet, and each first-pass finding was verified against the current source
rather than assumed fixed. That pass found three more defects, all fixed. No
independent second-pass review was obtained for this ticket either.
