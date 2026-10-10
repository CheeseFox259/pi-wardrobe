# 01: V1 prerequisite: prepare local Bare Git and controlled npm fixtures

Remote: https://github.com/CheeseFox259/pi-wardrobe/issues/9
Acceptance source: remote
Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8

Triage: ready-for-agent
Execution: complete
Claimed by: none
Branch: none
Blocked by: none
Verified commit: 8fe1bf592681715efa608f446ecc7327353a5c0b
Last attempt: none

## What to build

Read the authoritative remote ticket body at https://github.com/CheeseFox259/pi-wardrobe/issues/9.

## Acceptance criteria

Read the remote ticket body and relevant comments; the local ledger is not a second editable set of acceptance criteria.

## Delivered

Reusable fixture harness under `fixtures/`, checks under `test/`, one documented
command `npm run fixtures:verify`, and a merged evidence report at
`.scratch/wardrobe-v1/evidence/native-fixture-report.md`. Usage and layout are in
`fixtures/README.md`. The prior experiments in `experiments/` are preserved and
were not promoted into the harness.

All eight remote acceptance criteria are addressed; see the check table below
for the code or check that covers each.

## Commands and results

| Command | Result |
| --- | --- |
| `npm run fixtures:verify` | 20 tests, 20 pass, 0 fail, exit 0, ~13 s |
| working-tree review against baseline `3c17a1ec0a8159e849f573b1d0f50023e3370f6b` | Standards axis: no documented-standard violations; Spec axis: all 8 criteria satisfied, no scope creep |

Baseline recorded in the report: Pi 1.1.0, Node v26.5.0, npm 11.17.0, macOS arm64.

## Acceptance evidence

| Remote criterion | Covered by |
| --- | --- |
| One documented command, cleanup on success and failure | `fixtures/README.md`, `package.json`, `fixtures/harness.mjs`, `test/cleanup.test.mjs` |
| Both commits addressable at a full SHA through a Pi Git URL | `fixtures/lib/git-source.mjs`, `test/git-lifecycle.test.mjs` |
| Controlled registry with exact versions, integrity and script metadata | `fixtures/lib/npm-registry.mjs`, `test/npm-lifecycle.test.mjs` |
| Seven fixture scenarios (success, inactive filtering, failure, repair, ref collision, two-agentDir, removal) | `test/git-lifecycle.test.mjs`, `test/npm-lifecycle.test.mjs`, `test/agent-isolation.test.mjs`, `test/rpc-observation.test.mjs` |
| Unchanged settings distinguished from residual files; preferences and sentinels intact | `test/npm-lifecycle.test.mjs`, `test/agent-isolation.test.mjs`, `fixtures/lib/sandbox.mjs` |
| RPC observes command/tool/event registration and shutdown without a model request | `fixtures/lib/pi-runner.mjs`, `test/rpc-observation.test.mjs` |
| Report records versions, commands, evidence, and states what it does not claim | `fixtures/lib/evidence.mjs`, `fixtures/report.mjs` |
| No GitHub push, npm publish, personal auth store, secret env or live provider request | `fixtures/lib/sandbox.mjs` environment allowlist; every source, marker and path lives in one temporary root |

## Findings that later tickets depend on

- An **unfiltered** install loads its extension when a process starts. Keeping a
  package inactive requires declaring explicit empty resource filters, and those
  filters survive native install unchanged. Review must filter before install.
- A failed install is refused but is not transactional: settings are untouched
  while the installed directory and the failing script's external marker remain.
- Two agent directories hold two commits of one Git source concurrently; the
  persistent checkout path is per agent directory.
- Removing a package deletes owned installs but not install-script side effects.

## Scope and limits

Remote ticket #9 was not edited, labelled, assigned or closed; no remote
publication was authorized or performed. Nothing was pushed and no PR was
created. The evidence explicitly does not claim live GitHub validation, code
sandboxing, arbitrary rollback or detached-descendant reclamation.

The claim was not committed as a separate pre-implementation commit; this run
implemented in-session on branch `ticket/01-local-native-fixtures` and recorded
the result in one ledger update.
