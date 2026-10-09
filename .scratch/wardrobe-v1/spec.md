# Pi Wardrobe V1: Reproducible Preset Lifecycle

Remote: https://github.com/CheeseFox259/pi-wardrobe/issues/8
Acceptance source: remote
Status: ready-for-agent
Map: https://github.com/CheeseFox259/pi-wardrobe/issues/1

## Authority

The remote issue body and relevant comments are authoritative for behavior and acceptance. Fetch them in full before planning or dispatch. Local publication input and journals are not an editable second specification.

## Resolved Decisions

- Execution, ownership and recovery policy: https://github.com/CheeseFox259/pi-wardrobe/issues/5 (human-approved hybrid launcher; research and controlled native evidence recorded remotely).

- Public preset and lock contract: https://github.com/CheeseFox259/pi-wardrobe/issues/6 (approved bounded schema, reference examples, commands, locks and follow/strict resume modes).

- Activation/recovery prototype verdict: https://github.com/CheeseFox259/pi-wardrobe/issues/7 (accepted; local throwaway commit 3fc14a8, browser simulation only).

## Implementation Preparation

- No unresolved planning question blocks implementation. Fixture preparation and runtime verification are implementation acceptance tasks, not spec-readiness conditions.
- First implementation ticket: https://github.com/CheeseFox259/pi-wardrobe/issues/9; local ledger issues/01-local-native-fixtures.md. Prioritize a local Bare Git repository and loopback npm registry; public publication is not required.
- Full finalized specification: [docs/specs/wardrobe-v1.md](../../docs/specs/wardrobe-v1.md). The remote #8 body remains authoritative; that document is its full local mirror.
- Baseline: Pi 1.1.0, Node 26.5.0, npm 11.17.0, macOS arm64; node:test, real Pi processes, node-pty. Full ticket slicing and an authorized versioned execution baseline remain execution preparation.

This is a spec pointer, not a decision ticket or implementation ticket. Spec readiness does not mean implementation completion, passing runtime acceptance, or authorization to push or modify credentials.
