# 13: Deliver an independently installable Minimal Coding preset

Remote: https://github.com/CheeseFox259/pi-wardrobe/issues/21
Acceptance source: remote
Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8

Triage: ready-for-agent
Execution: complete
Claimed by: run-20261013T112705Z
Branch: ticket/13-minimal-reference
Blocked by: 07
Verified commit: 993e63b
Last attempt: none

## What to build

Read the authoritative remote ticket body at https://github.com/CheeseFox259/pi-wardrobe/issues/21.

## Acceptance criteria

Read the remote ticket body and relevant comments; the local ledger is not a second editable set of acceptance criteria.

## Delivered

`presets/minimal-coding/` — the approved example byte-for-byte (the test
extracts the JSON block from docs/specs/wardrobe-v1.md and deep-equals it, so
spec drift fails loudly) plus an author-facing README. It ships no packages,
no resources, no Perfect Pi / Skill-framework / subagent / MCP /
provider-specific anything: native tools, thinking and an appended instruction
only. It goes through the public discovery → review → approve → install →
launch path with no manager special case. A latent defect this surfaced:
launch baselines record tools in Pi's `+name`/`-name` modifier form, and
reconciliation compared them literally — startup restore classified every
native tool as unrequested. `reconcile.mjs` now normalizes tool selections
through one `normalizeToolSelection` helper at every consumption boundary
(restore planning, in-effect reporting, restriction matching; removals-only
resolves against the baseline).

## Commands and results

| Command | Result |
| --- | --- |
| `npm test` (final tree) | 158 tests, 158 pass, 0 fail, exit 0, ~462 s (152 prior, 6 new) |
| `test/minimal-reference.test.mjs` alone | 6 tests, 6 pass, 0 fail, ~84 s |
| working-tree review vs baseline `3f34d99` | Two passes on both axes. Pass 1: parallel reviewer subagents; Spec clean, Standards 2 findings, fixed. Pass 2: verified against source, 2 judgement residuals, fixed |

Baseline: Pi 1.1.0, Node v26.5.0, npm 11.17.0, macOS arm64.

## Acceptance evidence

| Remote criterion | Covered by |
| --- | --- |
| Only native tools/Thinking/append instructions; no Perfect Pi, Skill framework, subagent, MCP or provider-specific model dependencies | The declaration itself: `packages: {}`, `resources: []`, no model route. Strict schema parse proves no undeclared fields |
| Identity/version/compatibility and exact resource declaration match the approved example; no private manager hook | Exactness test extracts the spec's approved block and deep-equals the shipped file; install path is the community path unchanged |
| Local captured definition and pinned Git fixture import both review/install/launch; runtime observations show native tools and appended instructions effective without changing personal choices or credentials | Two end-to-end tests (local dir, `git:<url>@<sha>`): real launched Pi processes against the local provider; fixture-request.jsonl shows `reasoning: "medium"`, the appended instruction verbatim in the system prompt, and exactly read/edit/write/bash active; personal auth/settings/sentinels byte-identical before and after |
| Manager installation independent of reference selection; cancelling reference review installs nothing | Manager operates with the presets directory absent; review without `--confirm` writes no staging record and no revision |

## Findings the review forced

Pass 1: the tool-modifier fix had been applied only in the restore planner —
in-effect reporting and restriction matching still compared modifiers
literally, and a removals-only selection would have disabled every tool; all
three consumers now share one normalization helper. The exactness test
redeclared the expected JSON inline and could not detect spec drift; it now
extracts the approved block from the spec itself. Pass 2 (verified pass 1
against source): unnormalized whitespace could bypass exact restriction
matching (`"+ bash"`); the spec-fence search was scoped to the Minimal Coding
section heading.

## Scope and limits

Remote ticket #21 was not edited, labelled, assigned or closed. Nothing was
pushed and no PR was created; the caller owns branches and merging.

The preset declares `compatibility.platforms: ["darwin-arm64"]`; other
platforms are unverified, as specified. Deliberately deferred: the Engineering
reference (14) and the integrated V1 path (15).
