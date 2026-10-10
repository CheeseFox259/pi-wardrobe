# @pi-wardrobe/manager

The Wardrobe preset manager for Pi. It registers exactly one command,
`/wardrobe`, and nothing else.

## Command surface

| Command | Behaviour |
| --- | --- |
| `/wardrobe list` | Discovers `preset.json` declarations in the configured source directories, validates each strictly, and lists them with their snapshot state. Read-only: it never copies resources |
| `/wardrobe show <preset>` | One preset's identity, version, source, composed layers, packages and selected resources. Captures a snapshot as it inspects |
| `/wardrobe explain <preset>` | Every composed value with the layer and revision it came from, the resources that load and the ones that do not with their reasons, and the preferences that are only proposals |
| `/wardrobe explain <preset> --overlay <path>` | Composes one session overlay over the preset. Soft preferences only |
| `/wardrobe explain <preset> --disable-tool <a,b>` | Applies a CLI exclusion: no layer can re-enable those tools, and the request is reported as unmet |
| `/wardrobe explain <preset> --model <provider/id>` | Records an explicit model choice, which wins over any declared preference |
| `/wardrobe install <source>` | Discovers the source and produces an immutable review plan. Installs nothing |
| `/wardrobe install <source> --preset <path>` | Explicit selection when a source declares more than one preset |
| `/wardrobe install <source> --confirm <digest>` | Approves the plan by quoting the digest it printed, then installs it into owned staging with every resource filtered inactive, and measures its lock. A different digest is refused and installs nothing |
| `/wardrobe status [revision]` | Every installed revision, one line each: the state the install recorded beside the state measured now. No selector means the whole store |
| `/wardrobe doctor [revision]` | The full diagnosis per revision: configuration, selected-resource content, installed code, baseline and declared runtime data, with every difference named |

`list`, `show`, `explain` and `status` also report installed revisions, so the
declared shape of a preset and the state of any revision built from it are
never merged into one claim. `show` and `explain` match on the source-qualified
identity of the declaration they were asked about: a local declaration that
shares an id with an installed revision reports no revision of its own rather
than borrowing another source's state. A revision addresses by its revision id, its source-qualified
identity (`git:…@<sha>#<id>`), or its preset name; an ambiguous name is
refused with the ids that do exist rather than resolved to a guess.

## Composition and provenance

A declaration is rarely the whole environment. Composition folds layers in one
order — **Base → Preset → User → Session** — and every effective value keeps the
layer it came from, so `explain` reports provenance instead of a merged blob.

- **Parents** resolve from their own pinned source: the parent is captured, not
  trusted, so an inherited declaration is read at a full commit or an exact npm
  version like any other. A parent that declares several presets must be named
  with `presetPath`, and a chain that repeats an identity is refused with the
  whole chain rather than resolved arbitrarily.
- **Aliases are stable.** An inherited alias cannot be rebound to another
  package, and two layers that require different versions of one canonical
  package fail with both origins instead of a winner being picked.
- **Resource selectors** fold per package and kind. A supplied `include`
  replaces the candidate set and re-includes the paths it names; an omitted
  `include` inherits. A supplied
  `exclude` removes paths afterwards, so a same-layer exclusion wins over a
  same-layer inclusion. A lower exclusion survives until a higher layer names
  that path again. `include: []` chooses none, and a package and kind with no
  selector anywhere loads nothing.
- **Tools** fold the same way: same-layer disable wins, a higher layer may
  re-enable, and nothing re-enables a tool the user or the CLI excluded. An
  unmet request keeps its reason.
- **Instructions** append in layer order; nothing is removed or replaced. A
  **model preference** yields to an explicit user or CLI choice, which is
  reported as such rather than as an effective value.
- **Overlays are soft.** A user overlay (`<agentDir>/wardrobe/user.json`) or a
  session overlay may set tools, thinking, model and appended instructions, and
  nothing else. Declaring a package or a resource is refused: loaded resources
  belong to a reviewed revision, and changing them requires a new one.

Only executable identity — the packages and the resources that would load —
decides whether a change needs a new reviewed revision. Preferences do not
appear in it, so a soft change is classified as one.

## Installing an approved plan

`--confirm <digest>` is the only path that installs anything. It re-checks that
the plan still hashes to the digest that was approved, re-verifies each named
artifact against the registry, and then installs through Pi's own package
manager into `<agentDir>/wardrobe/staging/<revision>/attempt-<n>/` — a fresh
agent directory this manager owns, with no auth, no user files and no shared
package roots.

- **Nothing loads.** The staged `settings.json` declares every package with
  each resource type filtered to `[]`, before the install runs and again after
  it. A staged revision can be inspected, and a process can start against it,
  without a single resource becoming active. Activation is a separate, explicit
  step this manager does not take.
- **A revision is not reinstalled in place.** An available revision for the
  same plan is reported as already available. A different resolution of the same
  preset is a different revision and is staged beside the first one.
- **A failure stays visible.** Pi's install runs package scripts, so a failed
  attempt is retained as explicitly failed/unavailable with its residual files
  listed and `rolledBack: false`. A retry is a new attempt directory; the
  earlier one is reported as retained, never described as undone.
- **The inventory is not launch availability.** A staged revision reports
  `verifiedLaunchable: false`; whether a real process can start against it is
  verified later.
- A `.` self source installs as the pinned native source of the package that
  ships the declaration. A local snapshot with no pinned native source is
  refused, because Pi does not install a local package's dependencies and the
  approved artifacts would otherwise not be what is installed.

## Revision locks and drift

An installed revision is measured, not trusted. Immediately after installation
the manager derives a lock from the files that are actually on disk, and an
install is only reported `available` when that measurement is complete.

| Part of the lock | What it covers |
| --- | --- |
| `configuration` | A canonical digest of the approved effective configuration: identity, exact sources, resource selection, runtime and persona. No timestamps, no machine paths, no secrets |
| `resources` | One SHA-256 per selected resource file, resolved through Pi's own inventory |
| `code` | A fingerprint of every installed package tree under `npm/` and `git/`, plus a digest per package and per installer-metadata root |
| `baseline` | The Pi, Node, npm and platform the revision was measured on. An unidentified Pi build or an unreadable npm version is a measurement problem, so the install is not reported available |
| `runtimeData` | The declared mutable roots (`sessions/`, `wardrobe/`). Listed, never hashed, and always outside the locked code roots |

Fingerprints deliberately omit Git's own directories — they move on their own
and say nothing about installed code — and credential files, which are not code
and must never reach a reported fingerprint. A directory that is never read is
reported as skipped rather than silently dropped.

`/wardrobe doctor` re-measures and reports one of five states, none of which is
a softer version of "fine":

| State | Meaning |
| --- | --- |
| `available` | Every measurement still matches the lock |
| `drifted` | Measured, and no longer matching. Refused |
| `unverified` | This host cannot vouch for it: a different toolchain or platform, an unsupported declared range, or a measurement that could not be completed |
| `failed` | The install attempt failed and was retained as failed, with its residual files |
| `missing` | The revision's directory is gone |

Re-running an approved install re-measures the revision it would reuse. One
that still matches its lock is handed back untouched; one that has drifted is
replaced by a fresh attempt in a new directory, and the record says which
attempt it replaced and why. The drifted directory is left exactly as it was.

A drifted or missing revision is never quietly re-labelled as the approved one.
There is no path that rebuilds the tree and calls the result the same revision:
a different tree is a different tree, and adopting it means approving a new
plan. A record whose directory has disappeared is installed again into a new
attempt rather than handed back as the revision it no longer is.

A declaration's `compatibility.pi` range and its optional `platforms` list are
checked against the observed baseline. A range that cannot be resolved and a
Pi build that cannot be identified are both reported as unanswerable, never as
satisfied.

Intended configuration and observed state are always reported side by side, so
a record that still says `available` after the installed tree changed appears
as exactly that. The state is the whole claim — there is no separate health
boolean to soften it. `launchable` is reported as `false` throughout: whether a
process can start against a revision is a separate, verified step.

## Discovery and the review plan

`/wardrobe install` captures a source and describes it. Only an explicitly
approved plan is installed.

- **Git** sources are fetched with real Git at a full 40-character commit SHA.
  A branch or tag is refused: a plan is only immutable when it names what it
  read. Capture is repeatable — the same source can be reviewed again.
- **npm** sources resolve an exact version, read the registry packument, verify
  the tarball against its own integrity hash, and extract it. No install runs
  and no lifecycle script executes.
- **GitHub** references (`owner/repo`, `github.com/…`, `https://…`, `git@…`, with
  or without `.git`) normalize to `github:<owner>/<repo>`. A preset path is
  written `#presets/<name>`, not as a tree URL, because a ref may contain
  slashes.

The plan names every installation surface with its exact artifact and integrity,
every resource selector, every load surface, and a digest over all of it.
`--confirm` is valid only for that digest; if the source or its artifacts
change, the recomputed digest differs and the approval is refused. There is no
flag that approves without showing a digest.

Resources of a **self source** (`.`) are the ones shipped alongside the
declaration, so their paths are resolved during review: absolute paths,
traversal, missing files and symlinks are refused before any plan is sealed.
Resources of external packages cannot be resolved until that package is
installed, and are checked there.

`$WARDROBE_REGISTRY` selects the registry Wardrobe reads. Wardrobe reads only a
registry it was pointed at explicitly.

A preset id on its own resolves only when it is unique. Two sources declaring
the same id make the short form ambiguous, and `/wardrobe show <id>` refuses
with both candidates rather than guessing.

## What this package deliberately does not do

- No dependencies, no install scripts, no MCP servers, no browser tooling, no
  skills, prompts or themes. Installing the manager must not pull in a preset.
- No credentials. A preset cannot declare one, and the manager never reads or
  writes the user's auth store.
- No claim of activation. `list`, `show` and `explain` report
  `installed: false, active: false`; `install` reports a staged revision whose
  resources are filtered inactive, explicitly not verified launchable.
- Declared `runtime.model`, `runtime.thinking` and `runtime.tools` are reported
  as proposals until a preset is applied.
- No rollback. A failed install leaves its files and its package script effects
  in place and reports them; a retry is a new attempt beside it.

## Declaration contract

A preset definition is a `preset.json` with `schemaVersion: 1`. Required:
`schemaVersion`, `id`, `name`, `version`, `compatibility.pi`. Optional:
`description`, `author`, `compatibility.platforms`, `extends`, `packages`,
`resources`, `runtime`, `persona`.

A preset `id` may be namespaced, e.g. `wardrobe/minimal-coding`. A package
source is `npm:<name>@<exact-version>`, `git:<url>@<full-commit-sha>`, or `.`
for the package that contains the definition itself. A branch or tag is
refused: a preset always pins what it resolved to. `extends` names one parent,
`{ source, presetPath? }`, captured from its own pinned source.

Each entry in `resources` selects paths *inside* a declared package:
`package` names an alias from `packages` — its own or an inherited one —
`kind` is `extensions`, `skills`, `prompts` or `themes`, and both `include` and
`exclude` are optional package-relative path lists such as
`skills/review/SKILL.md`. An empty `include` is valid and means "load none of
this"; an omitted one inherits the lower layer's selection. Omitting `kind`
applies the selector to the package as a whole; the exact type a path loads as
is Pi's own per-type filtering, so the plan does not guess one.

Validation is strict. Unknown fields, malformed versions or ranges, and
excluded concepts — credentials, MCP server definitions, script hooks, plugin
private configuration — are refused with the exact path that caused them. An
alias a resource names but no layer declares is refused when the layers are
composed, which is the first point where the whole chain is known.

```json
{
  "schemaVersion": 1,
  "id": "minimal-coding",
  "name": "Minimal Coding",
  "version": "1.0.0",
  "compatibility": { "pi": ">=1.1.0 <2.0.0" },
  "runtime": { "thinking": "medium" },
  "persona": { "append": ["Prefer small diffs."] }
}
```

## Where presets are read from

`$WARDROBE_PRESET_DIRS` (comma-separated absolute paths), otherwise
`<agentDir>/presets`. Declarations are found at a source root or one level
below it.

Snapshots this manager writes live under `<agentDir>/wardrobe/snapshots/` and
capture the declaration. Resource paths are not materialised there: they are
package-relative, so they can only be resolved once the declared package is
installed. Installed revisions and their records live under
`<agentDir>/wardrobe/staging/`.

## Checks

```sh
npm test
```

- `test/schema-strict.test.mjs` — declaration and overlay validation
- `test/manager-inspection.test.mjs` — the manager installed and driven inside a
  real isolated Pi session
- `test/composition-provenance.test.mjs` — layer folding, and inherited presets
  reviewed through real Git and npm sources
- `test/staged-inactive-install.test.mjs` — approving a plan and installing it
  through Pi into owned staging, with every resource inactive
- `test/revision-lock-doctor.test.mjs` — measuring installed revisions, the
  exclusions a fingerprint makes, and drift, baseline, compatibility and
  missing-revision diagnoses

Tracked by
[issue #14](https://github.com/CheeseFox259/pi-wardrobe/issues/14).
