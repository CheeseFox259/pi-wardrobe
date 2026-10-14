# 15: Exercise and document the complete V1 user path

Remote: https://github.com/CheeseFox259/pi-wardrobe/issues/23
Acceptance source: remote
Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8

Triage: ready-for-agent
Execution: complete
Claimed by: run-20261013T135634Z
Branch: ticket/15-integrated-v1-acceptance
Blocked by: 10, 11, 12, 13, 14
Verified commit: 5eafd83
Last attempt: none

## What to build

Read the authoritative remote ticket body at https://github.com/CheeseFox259/pi-wardrobe/issues/23.

## Acceptance criteria

Read the remote ticket body and relevant comments; the local ledger is not a second editable set of acceptance criteria.

## Delivered

`test/integrated-v1-acceptance.test.mjs` — one controlled run, twelve stages:
manager install → Bare Git/npm discovery and review (GitHub URLs normalized
offline, digests tamper-refused) → cancellation → approved install with every
resource inactive → isolated launch with competing-writer refusal → in-session
soft change and a full-switch launch plan → follow resume by approval order and
strict pin/refusal → tree navigation blocking a turn (zero provider requests,
zero transcript entries) with a relaunch plan → induced drift refused by
doctor and a failed install retained as failed → retain/strict guards, release,
removal → baseline byte-identical → integrate enable/disable. The run writes
`.scratch/wardrobe-v1/evidence/integrated-v1-acceptance.{md,json}`: baseline,
commands, the 14 parent outcomes each mapped to observed checks (vertical-slice
suites cited where they own the proof) and the explicit limits. New
`docs/usage-and-authoring.md` covers commands, authoring, source-qualified
identity, follow/strict tradeoffs, lock/rebuild limits, forwarding removal and
the no-sandbox / no-script-rollback boundaries; unknown platforms stated
unverified. No production code changed.

## Commands and results

| Command | Result |
| --- | --- |
| `npm test` (final tree) | 174 tests, 174 pass, 0 fail, exit 0, ~417 s (161 prior, 13 new) |
| `test/integrated-v1-acceptance.test.mjs` alone | 13 tests, 13 pass, 0 fail, ~25 s |
| `npm run fixtures:report` | 50 evidence checks, 0 failures |
| working-tree review vs baseline `15a9a52` | Two passes on both axes, parallel reviewer subagents. Pass 1: 9 findings, all fixed. Pass 2: verified all against source; zero new findings |

Baseline: Pi 1.1.0, Node v26.5.0, npm 11.17.0, macOS arm64.

## Acceptance evidence

| Remote criterion | Covered by |
| --- | --- |
| One controlled run covers the whole path | The 12-stage single-lifecycle test, each stage asserting observed state (leases, digests, provider request logs, transcript entry counts, byte-identical personal env) |
| GitHub normalization with controlled responses, not described as live verification | Stage 2 normalizes GitHub URLs offline; README and the evidence state the loopback boundary explicitly |
| Reproducible evidence records the baseline, commands/assertions, failure cleanup; no credentials or external publication | The evidence md/json record the verified baseline and stage results; the suite uses only loopback fixtures and the local provider |
| Pre-install code-surface approval, integrity changes, no-UI approval, stale/competing writer refusal, failed-start recovery — without weakening checks | Stage 2 (code surfaces, tampered digest), stage 4 (digest-bound noninteractive approval), stage 5 (live competing writer refused; stale-writer outcomes mapped to isolated-pi-launch and owned-revision-removal), stage 9 (failed install retained, drift refused) |
| Documentation covers the listed topics; unknown platforms unverified | docs/usage-and-authoring.md + READMEs; darwin-arm64 stated as the only verified baseline |
| All 14 parent outcomes map to observed checks or explicit not-run limitations | The mapping table in the evidence record; pass-2 review verified every row |

## Findings the review forced

Pass 1 (both axes, parallel reviewer subagents), all fixed: the docs showed a
standalone `wardrobe status` the CLI does not have and omitted the mandatory
agent directory; the README read as live-GitHub-verified and hardcoded a stale
test count; the integrated test carried a dead helper, seven unused imports and
a stage-8 assertion that would pass on an empty request log; the outcome
matrix cited stages under names that did not match the recorded evidence keys
and under-cited the declaration-rejection and stale-writer suites; duplicated
fixture JSON extracted, fixed sleeps replaced with leaf polling.

Pass 2 (both axes, parallel reviewer subagents): every pass-1 fix verified
against source; further doc spot-checks (integrate/retain/release/schema)
match the code; zero new findings.

## Scope and limits

Remote ticket #23 was not edited, labelled, assigned or closed. Nothing was
pushed and no PR was created; the caller owns branches and merging. The parent
spec was not amended.

Not verified and said so: live public-GitHub transport (loopback only),
platforms beyond macOS arm64, bit-identical frozen transitive rebuilds,
sandboxing of install scripts, reclamation of detached processes.

## Post-delivery whole-range review (external, committed mode, merge-base 3c17a1ec → fae6c0b)

An independent two-axis review of the whole V1 range (128 files) ran after
ticket 15. Findings and their resolution (fix commit 175d8ed, 176/176 tests):

- **`github:` import could not execute at all** — discovery decomposed the
  normalized identity string instead of the locator, so every github: source
  threw before resolution, and no test had ever driven one. Fixed: locator
  decomposition, SHA from `git ls-remote` resolution, a documented
  `WARDROBE_GITHUB_HOST` loopback seam, and end-to-end tests through discovery
  → review → install. Docs and evidence state the loopback boundary.
- **The evidence matrix's Status column was a hardcoded "Verified"** and the
  report was written unconditionally mid-run. Now derived from run records
  (missing stage → Not Run, failure → Failed) and emitted only on completion;
  regenerated from a real passing run.
- **`approve()` carried an unused `requireDisplayed` parameter** that bypassed
  digest verification, contradicting the module's own invariant. Deleted; the
  digest check is unconditional.
- Doc platform format (`darwin-arm64`), "installed preset" → "installed
  revision" per CONTEXT.md, and `launchEnv`/`sessionState`/`latestRequest`
  hoisted into test/support/harness.mjs from 8 copies.
- **Local snapshot concern investigated and disproved with a test**: a local
  preset's definition is digest-covered by the plan; mutating it after
  approval invalidates the digest and refuses install.

Fixes verified by a read-only reviewer against current source; one doc
numbering typo found and fixed. Judgement calls accepted as-is: commands.mjs
monolith (divergent change), deliberate parseArgs divergence between CLI and
in-session dispatch (now documented with WHY comments).
