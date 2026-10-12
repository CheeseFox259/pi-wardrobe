# 08: Apply idle session overrides without changing code

Remote: https://github.com/CheeseFox259/pi-wardrobe/issues/16
Acceptance source: remote
Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8

Triage: ready-for-agent
Execution: complete
Claimed by: none
Branch: none
Blocked by: 07
Verified commit: 60f8cd7
Last attempt: none

## What to build

Read the authoritative remote ticket body at https://github.com/CheeseFox259/pi-wardrobe/issues/16.

## Acceptance criteria

Read the remote ticket body and relevant comments; the local ledger is not a second editable set of acceptance criteria.

## Delivered

`/wardrobe use` applies what a running process can adopt and returns a launch
plan for what it cannot. Tools, model preference, thinking level and appended
instructions are applied in place; packages, resources and code are not.

New: `apply.mjs` (the pure decision: what is executable, what a soft change
would do, why a session is not idle) and `session.mjs` (the session's own state,
the revision a process is running, and applied-beside-intended). The extension
gained a session capability so the command layer stays a plain module with no Pi
types in it, and contributes adopted instructions as prompt guidelines.

Usage is in `packages/wardrobe/README.md`, under "Changing a running session".

## Commands and results

| Command | Result |
| --- | --- |
| `npm test` | 116 tests, 116 pass, 0 fail, exit 0, ~283 s (110 prior, 6 new) |
| `test/idle-session-overrides.test.mjs` alone | 6 tests, 6 pass, 0 fail, ~63 s |
| working-tree review vs baseline `efaf89a` | Two passes on both axes. Pass 1: 2 parallel reviewer subagents, 13 findings, all fixed. Pass 2: run in the parent after both subagent dispatches failed with a transport error; every finding verified against current source |

Baseline: Pi 1.1.0, Node v26.5.0, npm 11.17.0, macOS arm64.

## Acceptance evidence

| Remote criterion | Covered by |
| --- | --- |
| Soft changes leave PID, package/resource fingerprints and installed revision unchanged; code/MCP/loaded-resource differences instead return the full-switch plan | `executableDifference` compares packages, selected resources and per-package code digests. Test "a soft use changes tools, thinking and instructions in the running session" asserts the PID is unchanged, the revision's settings are byte-identical and the recorded lock is unchanged; test "a difference in code or resources is a launch plan…" installs a revision that stops selecting a skill and asserts `kind: full-switch`, "nothing was started", and no change to tools, settings or lock |
| Busy/compacting states refuse or wait according to the approved idle boundary without mutating preferences halfway through an active turn | `idleRefusal`. Test "a tool nothing provides is reported, and a busy session refuses" asserts a mid-turn and a compacting session are each refused with their own reason and that neither the tool selection nor the thinking level moved |
| CLI exclusions and explicit user model choices remain authoritative; unavailable model preferences are diagnosed rather than reported applied | `planTools` refuses every name in the plan's restriction list with the reason; `planModel` refuses when the plan records a user winner or when the session carries a model its revision does not declare. Test "a CLI exclusion and a session's own model are not overridden" asserts the model's effective value is the session's own and the refusal is diagnosed; test "an unavailable model preference is diagnosed…" asserts `intended` and `effective` differ, the status is `different`, and the absent model is named in a diagnostic while the session's model stays put |
| Applied vs intended tool/Thinking/model/prompt state is shown by status/explain. Session changes do not write retained revision code or personal settings | `appliedAgainst` and `sessionNow`, rendered by `renderSessionState` and `renderSoftUse`. Test "status reports the running revision's state…" asserts status run from inside the revision names the running revision, the revision its preferences came from, the thinking in effect and the instructions adopted; test "a soft use changes…" asserts the lock, the revision settings and the personal agent directory are unchanged, and that what the model actually received carries the appended instruction and the revision's selected skill |
| Controlled real Pi/faux-local-provider observations demonstrate effective prompt/tool state without network model calls | `fixtures/lib/pi-runner.mjs` registers a local provider that streams a fixed reply and records the system prompt, the declared tools and the requested reasoning level. Test "a soft use changes…" reads that record and asserts the instruction, the enabled tool, the revision's skill path and reasoning `high` |

## Behaviour changes this ticket makes on purpose

- **A launched revision now has `/wardrobe`.** The launcher loads its own
  extension into the process it starts and points it at the manager's directory
  with `WARDROBE_AGENT_DIR`, alongside `PI_CODING_AGENT_DIR` for the revision.
  Without this there is no same-runtime `use` at all, because a revision has no
  manager of its own.
- **A revision carries its declared thinking level**, and telemetry stays off in
  a managed revision directory. The second is not a preference: Pi 1.1.0 reads
  `enableInstallTelemetry` unguarded, and a revision whose settings omit it or
  `defaultThinkingLevel` cannot complete a model turn
  ("Cannot read properties of undefined (reading 'includes')"). Both were found
  by trying to observe a real turn and are recorded here as observed Pi
  limitations.
- **A revision launches carrying its declared instructions**, written to the
  revision's own runtime data so the session can contribute them. Instructions
  are contributed as prompt guidelines, never as a replaced prompt.

## Findings the review forced

Pass 1 (Standards and Spec, working-tree mode, baseline `efaf89a`, parallel
reviewer subagents), all fixed:

- **`planPersona` dropped instructions the target did not declare**, while its
  comment claimed appending never deletes. The spec is right and the code was
  wrong: a revision's instructions and a user's stay.
- **The compaction listeners were registered per `/wardrobe` invocation**, which
  leaked a handler each time and missed a compaction that began before the
  command arrived. Both listeners now exist once per session.
- **Adopted instructions were lost on resume or fork**, because they lived in a
  process-lifetime variable. They are now re-read from the branch on session
  start, seeded by what the revision declared.
- **`status` and `explain` reported no session state at all**, which the ticket
  names explicitly. Both now report the running revision, the revision
  preferences were adopted from, and what is in effect.
- **A tool the user or CLI excluded could be re-enabled** by a preset asking for
  it. The plan's restriction list is now honoured and the refusal is named.
- **A model the user chose in this process could be overridden** by a declared
  preference. A session's model that its own revision does not declare is now
  treated as the user's choice.
- **`intended` was built from what took**, so a tool that could not be provided
  disappeared from the comparison and the row reported `in-effect`. Intended is
  now the declared selection, so an unmet name shows as not applied.
- A dead accumulator, an unused parameter, an undocumented exported function, a
  duplicated assertion, and a membership test implemented as a substring search
  over JSON.

The review also flagged the launcher changes as scope creep. They are not:
without them a launched revision has no `/wardrobe`, and ticket 08 has no
subject. They are disclosed above rather than folded in silently.

## Scope and limits

Remote ticket #16 was not edited, labelled, assigned or closed. Nothing was
pushed and no PR was created; the caller owns branches and merging.

Not done here, and why: an interactive full-screen session was not typed at.
Every check drives real Pi over its own RPC protocol, and a turn is completed
against a local provider, so what a session *does* is observed; what a human
*sees* on a terminal is not.

A busy turn and a compaction are exercised through the command layer with a
runtime that reports those states, because producing a real mid-turn state needs
a model call this environment deliberately does not make. The apply path itself
is exercised against real Pi sessions.

Deliberately deferred: bindings and follow/strict resume (09), binding
reconciliation (10), owned revision removal (11), the startup selector (12),
the reference presets (13, 14), and the integrated V1 path (15).

## Review disclosure

Pass 1 ran as two parallel `subagent` reviewer tasks. The pass-2 dispatch failed
twice with a transport connection error, so both axes were performed in the
parent against the same immutable packet, with each first-pass finding verified
against the current source rather than assumed fixed. No independent second-pass
review was obtained for this ticket.
