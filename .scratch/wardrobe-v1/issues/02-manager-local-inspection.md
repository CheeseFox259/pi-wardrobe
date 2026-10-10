# 02: Install the manager and inspect a local preset

Remote: https://github.com/CheeseFox259/pi-wardrobe/issues/10
Acceptance source: remote
Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8

Triage: ready-for-agent
Execution: complete
Claimed by: none
Branch: none
Blocked by: none
Verified commit: 5b1013638edebb61224b6f20d7fe74765f60fe3f
Last attempt: none

## What to build

Read the authoritative remote ticket body at https://github.com/CheeseFox259/pi-wardrobe/issues/10.

## Acceptance criteria

Read the remote ticket body and relevant comments; the local ledger is not a second editable set of acceptance criteria.

## Delivered

`packages/wardrobe` — a real native Pi package registering exactly one command,
`/wardrobe`, with no dependencies, install scripts, MCP servers, skills,
prompts or themes. `list`, `show` and `explain` are delivered; `install`, `use`,
`status`, `doctor`, `remove` and `release` belong to later tickets and are
absent rather than stubbed. Usage and the declaration contract are in
`packages/wardrobe/README.md`.

`fixtures/lib/pi-runner.mjs` gained a `get_state` handshake, `extraEnv` for RPC
children, and a `fixture-entries` driver command so structured command results
can be read back from a live session.

## Commands and results

| Command | Result |
| --- | --- |
| `npm test` | 45 tests, 45 pass, 0 fail, exit 0, ~19 s (20 fixture, 16 schema, 9 manager) |
| working-tree review vs baseline `95f3132`, three rounds | Round 1 and 2 found real spec-fidelity defects; all were fixed. Round 3 found dead code and a prototype-pollution bypass; all were fixed. Final round reported no hard violations |

Baseline: Pi 1.1.0, Node v26.5.0, npm 11.17.0, macOS arm64.

## Acceptance evidence

| Remote criterion | Covered by |
| --- | --- |
| Manager registers /wardrobe with no engineering/MCP/browser dependencies or side effects | `packages/wardrobe/package.json`, `extensions/wardrobe.mjs`, `test/manager-inspection.test.mjs` (diffs the live command list against a session without the manager: exactly `["wardrobe"]`) |
| Local declaration snapshotted and inspected without claiming installed/active | `src/store.mjs`, `src/commands.mjs`, `test/manager-inspection.test.mjs` (every result reports `installed: false, active: false`; the captured `definition.json` is asserted equal to what was inspected) |
| Explain identifies declared fields and origins | `src/commands.mjs` `explainFields`, asserted for nested leaves such as `/runtime/thinking` and `/packages/@scope/tools/source` |
| Strict schema rejects unknown/credential/private/MCP/script-hook fields and malformed metadata with actionable diagnostics | `src/schema.mjs`, `src/diagnostics.mjs`, `test/schema-strict.test.mjs` (14 checks) |
| Short IDs never silently resolve ambiguous sources | `src/identity.mjs` `resolveSelector`, `test/manager-inspection.test.mjs` (refuses with both candidates; qualified form resolves) |
| Model/Thinking and tool preferences remain proposals until applied | `src/commands.mjs` `proposals`, asserted `applied: false` on every preference field |
| No personal settings/auth copied or overwritten | `test/manager-inspection.test.mjs` (auth.json, unrelated.txt, theme and thinking preferences unchanged after a full inspection run) |

## Findings that later tickets depend on

- **An unfiltered package install loads its extension at process start.** Keeping
  a preset's resources inactive requires declaring explicit empty filters; those
  filters survive native install unchanged.
- **Git sources must already carry a full 40-character commit SHA.** A branch or
  tag is refused at validation, so discovery cannot rely on resolving a ref later.
- **Resource selectors are package-relative**, e.g. `skills/review/SKILL.md`. They
  cannot be materialised before the declared package is installed, so the
  snapshot captures the definition only. Ticket 03/05 owns materialisation.
- **`#` is the only source qualifier**, because sources contain `/` and `:` while
  preset ids may themselves be namespaced with `/`.
- **Snapshotting happens on inspection, not on list.** `list` is read-only.

## Scope and limits

Remote ticket #10 was not edited, labelled, assigned or closed. Nothing was
pushed and no PR was created; the caller owns branches and merging.

Deliberately deferred: remote source discovery and the review plan (03),
inheritance provenance (04), install and activation (05), the Minimal Coding
reference preset (14).
