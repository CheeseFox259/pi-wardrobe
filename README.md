# pi-wardrobe

Reproducible preset lifecycle for the Pi CLI agent (v1.1.0).

Pi Wardrobe allows Pi users to discover, review, compose, activate, and share environment presets without replacing Pi's package manager, corrupting personal settings, or running unreviewed code.

The approved V1 specification is in [`docs/specs/wardrobe-v1.md`](docs/specs/wardrobe-v1.md). Domain glossary is in [`CONTEXT.md`](CONTEXT.md) and architectural decisions are recorded in [`docs/adr/`](docs/adr/).

---

## Key Capabilities

- **Zero-Dependency Manager:** `@pi-wardrobe/manager` installs cleanly with zero runtime dependencies, zero MCP servers, and zero auto-installed presets.
- **Review Before Execution:** Sources (Bare Git fixtures, loopback npm, and offline-normalized GitHub references) produce immutable review plans with SHA-256 digests, naming installation surfaces, code-execution scripts, and load surfaces.
- **Inactive Staging:** Approved packages are staged with resources filtered inactive until explicit launch.
- **Process Isolation:** Runs execute against dedicated staging directories with exclusive leases; one revision is one writer.
- **Idle Soft Changes:** In-session preference updates apply in place without changing the process; executable differences return a new-process launch plan.
- **Follow & Strict Resume:** Follow mode tracks newest approved revisions by approval order; strict mode pins exact revisions with actionable refusal recovery.
- **Branch Reconciliation:** Tree navigation across branches blocks model turns on incompatible presets/revisions and provides relaunch plans.
- **Revision Locks & Drift:** Four-dimension locks (configuration, resources, code, baseline) detect tampering and refuse drifted launches.
- **Guarded Removal:** Revisions protected by active leases, strict bindings, or explicit retains refuse deletion; releasing drops retains cleanly.
- **Shell / PATH Forwarding:** Standalone TTY selector and optional `pi --wardrobe` forwarding wrapper with clean, reversible removal.

---

## Documentation

- **[Usage and Preset Authoring Guide](docs/usage-and-authoring.md):** Comprehensive reference covering commands, reference presets, `preset.json` schema, identity rules, follow/strict tradeoffs, and drift diagnosis.
- **[Package Reference (`@pi-wardrobe/manager`)](packages/wardrobe/README.md):** Technical design, command tables, composition rules, and storage layouts.
- **[Controlled Fixtures Documentation](fixtures/README.md):** Reproducible local Bare Git and npm registry fixtures.

---

## Shipped Reference Presets

- **Minimal Coding (`presets/minimal-coding/`):** Native-only baseline declaring built-in tools (`read`, `edit`, `write`, `bash`), medium thinking, and concise persona guidelines. Zero external dependencies.
- **Perfect Pi Engineering (`presets/engineering/`):** Curated engineering reference declaring 12 skill families, question/questionnaire extensions, pinned Guardrails and LSP packages, and truthful reporting of unmet host prerequisites.

---

## Verified Baseline & Boundaries

- **Verified Platform:** macOS arm64 (`darwin arm64`)
- **Verified Runtime:** Pi 1.1.0, Node v26.5.0, npm 11.17.0
- **Unknown Platforms:** Linux, Windows, x86_64, and untested Node/Pi versions remain **explicitly unverified, not certified**.
- **No Arbitrary-Code Sandbox:** Native installation runs package lifecycle scripts via Node/npm with standard user permissions.
- **No Script Rollback:** Failed installs are retained for diagnosis (`rolledBack: false`); external script effects are not claimed reversed.
- **No Frozen Transitive Rebuild Promise:** Locks measure disks, but do not promise unconditional frozen transitive rebuild across time or external network conditions.

---

## Running Checks

```sh
# Run the complete test suite
npm test

# Run tests and generate the native fixture evidence report
npm run fixtures:verify

# Re-generate evidence report from existing payloads
npm run fixtures:report
```
