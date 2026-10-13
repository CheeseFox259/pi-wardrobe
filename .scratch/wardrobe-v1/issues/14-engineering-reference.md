# 14: Deliver the optional curated Engineering reference preset

Remote: https://github.com/CheeseFox259/pi-wardrobe/issues/22
Acceptance source: remote
Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8

Triage: ready-for-agent
Execution: complete
Claimed by: run-20261013T125432Z
Branch: ticket/14-engineering-reference
Blocked by: 07
Verified commit: 521303f
Last attempt: none

## What to build

Read the authoritative remote ticket body at https://github.com/CheeseFox259/pi-wardrobe/issues/22.

## Acceptance criteria

Read the remote ticket body and relevant comments; the local ledger is not a second editable set of acceptance criteria.

## Delivered

`presets/engineering/` — the approved declaration exactly (a test extracts the
spec block and deep-equals it), a self package whose native `pi` manifest
matches the explicit resource selection, the curated 12 skill families with
their supporting references, `question`/`questionnaire` extensions built only
on public Pi APIs, and LICENSE/NOTICE recording the pinned lineage
(`@aliou/pi-guardrails@0.19.0`, `@narumitw/pi-lsp@0.49.9`) with the visible
limits: LSP needs external language servers that are never auto-installed, a
loaded guardrails package does not enforce undeclared policy, no
SoL-Pi/browser/web/subagent/full toolchain by default. Fixture registry gained
scoped-package routes; fixture packages gained custom manifest support.

## Commands and results

| Command | Result |
| --- | --- |
| `npm test` (final tree) | 161 tests, 161 pass, 0 fail, exit 0, ~386 s (158 prior, 3 new) |
| `test/engineering-reference.test.mjs` alone | 3 tests, 3 pass, 0 fail |
| working-tree review vs baseline `b4da79f` | Two passes on both axes, parallel reviewer subagents. Pass 1: Spec clean, Standards clean except one duplication judgement call (accepted: self-contained extensions); one shipped-probe finding, fixed. Pass 2: verified against source |

Baseline: Pi 1.1.0, Node v26.5.0, npm 11.17.0, macOS arm64.

## Acceptance evidence

| Remote criterion | Covered by |
| --- | --- |
| Exact curated 12 Skill families + supporting references, question/questionnaire resources, pinned guardrails 0.19.0 and LSP 0.49.9 with approved explicit entry paths; no default SoL-Pi/browser/web/subagent/full toolchain | Exactness test against the spec block; all 12 SKILL.md files plus supporting references on disk; declaration contains nothing else |
| Audit and record fixed source lineage and required license/NOTICE data; missing prerequisites report unavailable, never silently installed; unsupported workflows do not break available tools | NOTICE records lineage, entry paths and policy boundaries; the runtime test drives an LSP workflow with no language server present: reported unavailable while question/questionnaire keep working |
| Native manifests match explicit resource selection; relative self imports resolve to captured pinned native sources; runtime observations show question tools/selected Skills/LSP registration and guardrails entry with no privileged manager APIs | Manifest exactness assertion; launched-process observations (active tools, all 12 skills, guardrails and LSP entries) sourced from the revision root, proven via toolSources paths inside the revision dir |
| LSP route/server and private guardrails policy limits visible; no automatic server installation/private config override or claim that a merely loaded package enforces an undeclared policy | README + NOTICE state the limits; skill content instructs unavailable-reporting; nothing auto-installs |
| Reference optional; live Perfect Pi environment unmodified; source/package roots and credentials independent of personal installs | Personal agent dir snapshot byte-identical before/after; cancelled review writes nothing |

Honesty note: the pinned third-party packages are served as simulated tarballs
by the loopback registry in tests; no claim is made that real upstream
packages were fetched or executed. Cross-preset integrated switching is ticket
15, as the ticket itself states.

## Findings the review forced

The shipped question/questionnaire extensions carried test probe commands
writing into the agent dir — instrumentation bundled into a shipped preset.
Removed; tests now observe loading through ordinary surfaces (active/registered
tool lists, tool source paths, the model request's tool section).

## Scope and limits

Remote ticket #22 was not edited, labelled, assigned or closed. Nothing was
pushed and no PR was created; the caller owns branches and merging.
Deliberately deferred: the integrated V1 path (15).
