# 04: Review inherited and overridden environments with provenance

Remote: https://github.com/CheeseFox259/pi-wardrobe/issues/12
Acceptance source: remote
Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8

Triage: ready-for-agent
Execution: complete
Claimed by: none
Branch: none
Blocked by: 03
Verified commit: 69a3412ca6fe01186b4dcc6eb0a96e3adc2efb49
Last attempt: none

## What to build

Read the authoritative remote ticket body at https://github.com/CheeseFox259/pi-wardrobe/issues/12.

## Acceptance criteria

Read the remote ticket body and relevant comments; the local ledger is not a second editable set of acceptance criteria.

## Delivered

`show` and `explain` now describe a composed environment — Base -> Preset ->
User -> Session — and `/wardrobe install` seals a plan built from that
composition. Nothing installs and nothing loads; ticket 05 owns installation.

New manager modules: `compose.mjs` (layer folding, alias stability, change
classification), `inherit.mjs` (parent chain resolution from pinned sources),
`overlay.mjs` (user and session overlays). Harness: `npmPackage()` builds an
additional controlled npm package, needed to tell two canonical packages apart
from two versions of one.

Usage is in `packages/wardrobe/README.md`, under "Composition and provenance".

## Commands and results

| Command | Result |
| --- | --- |
| `npm test` | 76 tests, 76 pass, 0 fail, exit 0, ~38 s (57 prior, 19 new) |
| working-tree review vs baseline `11afe94` | Two passes, Standards and Spec axes, both ran; every finding fixed or verified — see below |

Baseline: Pi 1.1.0, Node v26.5.0, npm 11.17.0, macOS arm64.

## Acceptance evidence

| Remote criterion | Covered by |
| --- | --- |
| Parents resolve to reviewed exact sources/snapshots | `src/inherit.mjs`, `src/review.mjs#composeFor`; test "a preset inherits from a reviewed parent source and the plan names both revisions" asserts both layer commits and the inherited package's resolved integrity |
| Cycles rejected with both origins | `resolveChain`; test "an inheritance cycle is refused with the whole chain" asserts every chain node appears in the refusal |
| Alias rebinding rejected with both origins | `foldPackages`; test "an alias cannot be rebound and two versions of one package cannot both be required" |
| Conflicting versions of one canonical package rejected with both origins | same test; refusal names the base and child identities |
| Inheritance, empty includes, higher-layer re-inclusion, same-layer exclusion precedence, absent selectors load none | tests "an omitted include inherits…", "a lower exclusion persists…", "same-layer exclusion wins…", "a plan names no load surface when no effective selector selects one"; the first of these writes both declarations to a real repository and composes them |
| Tools obey enable/disable precedence and preserve CLI/user restrictions | `foldTools`; tests "tools fold by layer…", "a CLI exclusion survives every layer…" |
| Instructions append in order; explicit user/CLI model choice wins | `foldPersona`, `foldModel`; tests "instructions append in layer order…", "an explicit model choice beats a declared preference…" |
| explain traces values and disabled reasons to layers and resource identities, no secrets | `src/commands.mjs#composedFields`; test "explain traces composed values to their layer and never exposes secrets" asserts origins, reasons, and that the agent directory's credential-store contents appear nowhere in the result |
| Loaded-resource changes require a new reviewed revision | `classifyChange`, reported by `explain` as `revision`; test "only an executable change requires a new reviewed revision" |
| Session overlays limited to soft fields, cannot add executable dependencies | `validateOverlay`, `assertSoftOverlay`; test "a user overlay changes preferences and a session overlay may not add executable code" |

## Behaviour changes this ticket makes on purpose

- An empty `include: []` is accepted: it is how a layer chooses to load none.
- An omitted `include` is accepted and inherits the lower layer's selection.
- Whether a resource's package alias resolves moved from single-declaration
  validation to composition, because an inherited parent may declare the alias.
  A declaration that names an unresolvable alias is now refused when it is
  composed rather than when it is listed.
- Two versions of one canonical package are refused, so the ticket-03 preview
  check now uses two distinct fixture packages.

## Findings the review forced

First pass (Standards and Spec, working-tree mode, baseline `11afe94`):

- An overlay's layer identity was read from a field that never existed, so the
  overlay path was dropped from provenance.
- Package-conflict diagnostics rendered as `//packages/…`.
- An unused export, duplicated show/explain dispatch, and a `/resources`
  container whose origin had a different shape from every other origin.
- An omitted `include` was rejected by the schema, so "an omitted include
  inherits" could not happen for a real declaration.
- `explain` attributed a loaded path to the layer that first named it rather
  than the layer that selected it last.
- `classifyChange` existed but nothing reported it.

Second pass verified those fixes and found three more, all fixed: an overlay
schema duplicated the declaration's own runtime/persona spec; plan layers
rendered without their pinned revision; a tool that was both CLI-excluded and
disabled by a layer appeared twice in `disabled`.

## Scope and limits

Remote ticket #12 was not edited, labelled, assigned or closed. Nothing was
pushed and no PR was created; the caller owns branches and merging.

Disclosed, not implemented here because the remote ticket does not ask for it:
the local spec mirror also lists follow/strict resume migration and "refuse
activation if it is a declared required resource", which belong to tickets 09
and 07. The local mirror's "user overlays affecting loaded resources are
materialized as a new resolved revision" is unreachable in V1 as specified,
because an overlay may not carry loaded resources at all; here such an overlay is
refused with the reason and the user reviews a new preset revision.

Deliberately deferred: installation and activation (05), revision locks and
drift (06), session override application (08).
