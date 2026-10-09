# Issue tracker: GitHub

Issues and specs live in GitHub Issues. Use `gh` for configured repository operations, and read issue bodies, comments, labels, and (for PRs) diffs before acting.

**PRs as a request surface: no.** Set this to `yes` only when external PRs are intentionally triaged as requests.

When publishing tickets, create the parent/spec and child issues in dependency order, apply the configured `ready-for-agent` label, and use native sub-issues/dependencies where available. If native relationships are unavailable, record `Blocked by` in each remote body.

For every published implementation ticket, create a local ledger at `.scratch/<feature>/issues/<NN>-<slug>.md` with `Remote: <URL>`, `Acceptance source: remote`, and the shared execution fields. The remote body remains authoritative for acceptance. Claims, verified commits, and failed-attempt records are local Git state; mirror assignees, comments, labels, and closure only after explicit authorization.

## Wayfinding operations

- Maps are GitHub issues labelled `wayfinder:map`. Decision children carry exactly one `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task` label. Maps and children carry no triage labels. The label determines the workflow; remote bodies do not repeat `Type`.
- Create all child issues before wiring relationships using their actual IDs and URLs. Prefer native sub-issues and issue dependencies. If the API is unavailable, record linked children in the map and `Blocked by` with real issue URLs in each child body; disclose the fallback.
- Keep a map pointer at `.scratch/<effort>/map.md` and numbered decision ledgers at `.scratch/<effort>/issues/<NN>-<slug>.md`. Each ledger records `Remote`, `Acceptance source: remote`, `Map`, and `Blocked by` local numbers mapped one-to-one to remote issues. Remote questions and answers are authoritative. These are decision ledgers, not implementation tickets.
- An open GitHub decision issue without `Status: claimed` or `Status: resolved` is unclaimed. Its frontier prerequisites are resolved in-scope decision issues; an implementation `Execution` field is irrelevant. Use `gh issue list/view` and current bodies to compute the frontier; do not treat an out-of-scope closure as a resolved route decision.
- Re-read the remote issue and ledger before claiming. Stop on a competing claim. Write `Status: claimed` and a run identifier locally first, then mirror the claim remotely only when authorized. Never claim more than one non-research child per session. A local uncommitted claim is not a cross-session lock; concurrent workers need a shared coordinator or a versioned baseline.
- Resolve by recording an answer and evidence pointer, setting `Status: resolved`, and appending a gist plus child link to the map's Decisions so far. Close remotely only when authorized. Keep the decision state separate from implementation `Triage` and `Execution`.
- Charting creates and wires the map, starts independent background research, and stops without resolving a child. Save findings under `.scratch/<effort>/research/`. A research branch, if created, is throwaway, never merged, and pushed only with explicit push authorization; open no PR from it. Findings written on the current working tree are not a research branch or completed decision.


## Execution ledger

## Storage and authority

- Local tracker: `.scratch/<feature>/spec.md` holds the spec; `.scratch/<feature>/issues/<NN>-<slug>.md` holds each implementation ticket and its acceptance criteria.
- Remote tracker: the remote spec and ticket bodies are authoritative for behavior and acceptance. `.scratch/<feature>/spec.md` contains `Remote: <spec-URL>` and `Acceptance source: remote`; each `.scratch/<feature>/issues/<NN>-<slug>.md` is a local execution ledger with the same pointer fields for its remote ticket. Include a spec pointer in each ticket. Fetch full bodies and relevant comments before planning or dispatch. A read-only fetched snapshot may support a child without network access, but record URL and fetched time/revision and do not edit it as the authority.
- Number local ledger files from `01` in dependency order. Maintain a one-to-one remote URL to local number mapping. `Blocked by` uses those local numbers, including for remote tickets; preserve corresponding native remote relationships when supported and authorized. Reject missing references, duplicate mappings, cycles, or disagreement with the approved remote graph before execution.
- `to-spec` writes the spec or remote spec pointer; `to-tickets` writes approved tickets or remote ticket ledgers. `implement-spec` may materialize missing pointers for an already approved remote graph using this same contract before dispatch; it must not invent or amend remote acceptance.
- Version configuration, spec/pointer, and approved tickets/ledgers in local Git before creating worktrees. If `.scratch/` is ignored, disclose it and arrange authorized tracking of these particular artifacts; do not pretend ignored files are versioned or add the entire directory blindly. A no-commit instruction means preparation may continue but worktree dispatch requiring those artifacts is blocked until the caller supplies a versioned baseline.

## Ticket template

Plain `Key: value` lines, not bold keys or YAML frontmatter:

```markdown
# <NN>: <Title>

Remote: <ticket-URL>
Acceptance source: remote
Spec: ../spec.md

Triage: ready-for-agent
Execution: open
Claimed by: none
Branch: none
Blocked by: none
Verified commit: none
Last attempt: none

## What to build

<pointer to the remote authoritative body>

## Acceptance criteria

Read the remote ticket body at <URL>
```

A remote ledger additionally has `Remote: <ticket-URL>` and `Acceptance source: remote` near the top. It contains operational metadata and pointers, not a second editable set of acceptance criteria. A stale fetched body cannot silently supersede a changed remote requirement: compare before dispatch and final verification and resolve material changes before completing work.

## State machine

`Triage` records readiness; `Execution: open|claimed|complete` records implementation. A ready ticket starts `open`. Wayfinder decision-ticket `Status` is a separate machine and must never unlock implementation merely because a decision was resolved.

Only open, unclaimed tickets with all blockers complete are on the frontier. `complete` requires a reachable verified integration commit and recorded passing checks; a closed remote issue alone is not evidence. `Claimed by` and `Branch` are `none` when open or complete. Before dispatch, the coordinator writes `Execution: claimed`, `Claimed by: <run-id>`, and `Branch: <ticket-branch>` on the integration branch and commits. Create the worktree from this claim commit. Children never edit ledger state.

Only one coordinator writes a feature's integration ledger at a time. Re-read current state before claiming, and stop on competing claims; a commit in an independent clone is not a distributed lock. Separate sessions must share the coordinator or explicitly transfer ownership. Remote assignment can mirror a claim but is not the local execution source of truth.

After merge and successful integration checks, set `Execution: complete`, clear claim/branch, and set `Verified commit: <merged-code-sha>`. Append commands, results, and acceptance evidence, then commit the ledger update. The verified SHA refers to code, not the later metadata commit. Reverify changed acceptance or dependent code before replacing that evidence.

If worktree creation, implementation, or validation fails, preserve recoverable work; return to `Execution: open`, clear claim/branch, and write `Last attempt: <run-id>, <branch>, <worktree>, <reason>`. Resolve or abort any in-progress merge before updating state. On resume inspect that attempt before starting another branch. Inspect live or stale claims before releasing them; never steal active work.

Claims, failed attempts, and completion are local Git operations under the session's commit authorization. Remote assignees, labels, comments, issue closure, pushes, and PR state are optional external mirrors and require explicit authorization for those operations. Do not repeat authorization already given. If remote publication is not authorized, prepare local drafts and the proposed mapping, report publication pending, and do not fabricate remote URLs or label draft acceptance as authoritative remote content.
