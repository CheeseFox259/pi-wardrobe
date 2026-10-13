# 10: Reconcile forked and tree-navigated bindings before a turn

Remote: https://github.com/CheeseFox259/pi-wardrobe/issues/18
Acceptance source: remote
Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8

Triage: ready-for-agent
Execution: complete
Claimed by: run-20261013T030409Z
Branch: ticket/10-branch-reconciliation
Blocked by: 08, 09
Verified commit: 727881e
Last attempt: none

## What to build

Read the authoritative remote ticket body at https://github.com/CheeseFox259/pi-wardrobe/issues/18.

## Acceptance criteria

Read the remote ticket body and relevant comments; the local ledger is not a second editable set of acceptance criteria.

## Delivered

Tree navigation and forks now reconcile the branch's recorded binding against
the running process before a model turn. `wardrobe.session` entries carry the
preset identity and mode; `writeLaunchSession` records both in the revision's
baseline. New: `reconcile.mjs` (pure decision: in-effect / follow-kept /
blocked, with a relaunch plan). The extension reconciles on `session_tree`,
`session_start` (startup/resume/fork) and blocks turns through the `input`
event (`{action: "handled"}` + notify) — `before_agent_start` provably cannot
abort a turn in Pi 1.1.0. Follow branches keep the running newer approved
revision with migration evidence in the durable binding record and the session
entry. `/wardrobe status` shows active PID, code state, user restrictions and
any block with its relaunch plan.

## Commands and results

| Command | Result |
| --- | --- |
| `npm test` (final tree) | 128 tests, 128 pass, 0 fail, exit 0, ~419 s (122 prior, 6 new) |
| `test/branch-reconciliation.test.mjs` alone | 6 tests, 6 pass, 0 fail, ~80 s |
| working-tree review vs baseline `ddff931` | Two passes on both axes, all as parallel reviewer subagents. Pass 1: 9 findings, all fixed. Pass 2: verified all 9 against source; 6 residual findings, all fixed and re-verified |

Baseline: Pi 1.1.0, Node v26.5.0, npm 11.17.0, macOS arm64.

## Acceptance evidence

| Remote criterion | Covered by |
| --- | --- |
| Fork inherits the selected branch's binding and soft overrides; a persisted fork resumes with those records | Pi copies custom entries into forked session files verbatim (verified in SessionManager source); startup reconciliation restores soft overrides at runtime. Test 1 asserts the forked file carries the records and the resumed process actually runs with the inherited thinking level and tools, not merely that entries exist |
| Tree navigation restores desired soft fields only if compatible with the active runtime; a follow branch may remain on its current newer approved revision with migration evidence rather than chasing installed newest mid-process | `reconcile.mjs` in-effect / follow-kept outcomes; restore goes through the ticket-08 planners. Test 2 restores thinking/tools across branches; test 3 asserts follow-kept with a durable migration record and `keptFrom`/`keptTo` session entry, without chasing the newest install |
| Another preset, strict revision mismatch or missing required resource blocks the next model turn and supplies a relaunch plan; it never loads different executable resources in-process | Blocked state + `input` handler returning handled; relaunch plan names `wardrobe run <preset> --resume <file>`. Tests 4 (other preset), 5 (strict mismatch) and 6 (drifted resource) assert handled disposition, zero provider requests and an unchanged transcript prefix |
| Bound history is not overwritten or rewritten; active PID/code state and user restrictions are observable throughout navigation | All writes are appends; status exposes PID, code state, restrictions and the block. Test 4 asserts restrictions are visible in status while blocked |

## Behaviour changes this ticket makes on purpose

- **`/wardrobe use` accepts the session's own lease** (`held.childPid === session.pid`): after navigation, re-applying the running revision's preferences in-session is the owner re-entering, not contention. Any other holder is still refused as busy.
- **Follow reconciliation mutates the durable binding record** when it keeps the running revision: migration evidence has lived in binding records since ticket 09, and the criterion requires migration evidence. The session entry also records keptFrom/keptTo.

## Findings the review forced

Pass 1 (both axes, parallel reviewer subagents), all fixed: status revision had
no baseline fallback and restrictions were never exposed through the session
capability; strict reconciliation ignored drifted/missing reports; a follow
mismatch with unreadable approval order fell through to in-effect (now fails
closed); the restriction check read a nonexistent `enable` field and matched by
substring; startup reconciliation skipped soft restoration, so resumed forks
kept launch defaults; no test covered the missing-resource block; duplicated
helpers, dead code and a cryptic variable removed.

Pass 2 (both axes, parallel reviewer subagents), verified pass 1 against source
and found, all fixed: `sessionNow()` lacked the same baseline fallback; a
missing desired report still fell through to in-effect; the `before_agent_start`
soft sync ignored blocks and user restrictions (now guarded, and justified in a
WHY comment: Pi clamps thinking until a reasoning model is bound); two
duplicated payload builders extracted; an unused re-export and a duplicated pid
field removed.

## Scope and limits

Remote ticket #18 was not edited, labelled, assigned or closed. Nothing was
pushed and no PR was created; the caller owns branches and merging.

Navigation never cancels: the user may browse any branch; only the next model
turn is refused when the branch is incompatible. Deliberately deferred: owned
revision removal and release (11), the startup selector and `--wardrobe`
forwarding (12), the reference presets (13, 14), and the integrated V1 path
(15).
