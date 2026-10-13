# Pi Wardrobe Exploration Context

## Agreed destination

Produce an agreed implementation plan for a lightweight, general Pi preset manager distributed primarily as a native Pi package with `/wardrobe`. The first usable release must demonstrate a clean Pi 1.1.0 environment importing a GitHub preset, reviewing it, installing it without activating its resources, activating and switching it, binding a session, removing it, and restoring the prior environment without overwriting personal model preferences or unrelated resources.

Include a controlled executable extension fixture, not only persona data. A preset's declared permissions and a separate agent directory are not a security sandbox. Unknown executable dependencies require explicit review and execution authorization; unsupported safe switching must fail clearly and require a new process when necessary.

## Settled constraints

- Pi Wardrobe is the product. Perfect Pi is an optional reference preset, with no privileged API or mandatory engineering dependency.
- Pi owns package lifecycle. Wardrobe must not reimplement Git/npm installation; pre-install discovery and review are separate concerns.
- Native extension entry is preferred. An optional launcher is permitted if research and a throwaway prototype justify isolation or version coexistence needs.
- A simplified Perfect Pi preset and an independent Minimal Coding preset are sufficient initial references. Record compatibility gaps instead of silently importing all existing behavior.
- Preserve `/Users/superhacker/perfect-pi` and the user's current agent directory during exploration. Permission to refactor is not a reason to mutate the live environment before a design is agreed.
- Local planning documents and GitHub map/child issues, `wayfinder:` labels, and dependency relationships are authorized in this session. No software release, credential changes, PR, push, or production mutation is included.

## Current evidence, not completed research

- Perfect Pi's actual local baseline is Pi 1.1.0, not the draft's 1.0.4: `/Users/superhacker/perfect-pi/manifest.json:3`.
- Its manifest separates managed settings, default settings, package pins, SoL-Pi policy, MCP defaults/allowlists, Skill sources and local overrides. These are requirements to classify, not a proposed Wardrobe schema: `manifest.json:5-95`.
- Setup protects unowned resources and tracks previously managed resources: `/Users/superhacker/perfect-pi/setup.mjs:345-390`. It uses locked settings writes: `setup.mjs:168`. Preset activation must define ownership and reversible updates before adapting this behavior.
- Pi package identity drops refs and versions: installed Pi `dist/core/package-manager.js:1392`. Persistent Git checkouts are keyed by repository, whereas temporary Git scope includes refs: `dist/core/package-manager.js:1795`. Version coexistence and old-session restoration require a deliberate strategy.
- Pi Git install invokes dependency installation when `package.json` exists: `dist/core/package-manager.js:1548-1574`. npm arguments do not include `--ignore-scripts`: `dist/core/package-manager.js:1483-1530`. Resource exclusion is not installation-execution isolation; behavior also depends on the chosen package manager.
- Command context exposes `waitForIdle`, session replacement, and resource `reload`: installed Pi `dist/core/extensions/types.d.ts:286-321`. These are not a package-lifecycle extension API.
- Reload emits shutdown and invalidates the old runner before constructing the new runtime: installed Pi `dist/core/agent-session.js:2936-2974`. This does not establish cleanup of arbitrary extension side effects, transactional rollback, or sandboxing.
- Existing Perfect Pi test results are historical evidence reported in `docs/experiments/pi-1.1.0-assessment.md`; this exploration did not rerun them and does not claim runtime validation.

The installed runtime root above is `/Users/superhacker/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent`. These local citations describe that installation, not an unverified future Pi API.

## Sharp questions for the initial map

1. Native lifecycle: what reviewed install, resource-filter, reload, rollback, and version-recovery guarantees are possible on Pi 1.1.0 without bypassing its package manager?
2. Reuse: what can pi-profile-switch and pi-config-manager actually supply, at fixed source revisions and with license and runtime compatibility checked?
3. Migration: which Perfect Pi requirements fit a public preset contract, which need public package adapters, and which remain explicit compatibility gaps?
4. Execution boundary: after lifecycle and reuse facts, choose review/authorization, ownership, switching, and recovery behavior.
5. Declaration: after lifecycle and migration facts, settle stable resource identity, minimal schema, single inheritance, overrides, locks, and explanation provenance.
6. Prototype: after the two design decisions, test the agreed activation/recovery state model through a throwaway logic artifact and controlled isolated Pi fixtures. The HTML decision artifact cannot establish runtime safety; actual fixture observations must be reported separately.

## Fog

Do not pre-slice implementation modules or tickets yet. Packaging/launcher choice, transitive dependency reproducibility, schema field details, public adapter lifecycle, migration mechanism, session fork/tree semantics, ownership/reference counting, and exact recovery acceptance become sharper only after the initial research and decisions. Platforms beyond the initial local environment need a later explicit support decision.

Community search, curated registry, publishing/export UX, complex multiple inheritance, unreviewed third-party code sandboxing, and full Perfect Pi parity are not first-release promises.

## Workflow boundary

This is planning, not implementation. Chart the map, wire actual issue IDs, start independent background research, and stop without resolving children. Findings completion is not ticket resolution. Wayfinder is an upstream planning skill that has not been end-to-end runtime validated for Pi; this work does not claim unattended readiness.
