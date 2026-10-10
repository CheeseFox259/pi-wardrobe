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
| `/wardrobe install <source> --confirm <digest>` | Approves a plan by quoting the digest it printed. A different digest is refused |

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

## Discovery and the review plan

`/wardrobe install` captures a source and describes it; it never installs.

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
- No claim of installation or activation. Every result reports
  `installed: false, active: false`; a snapshot is data this manager wrote.
- Declared `runtime.model`, `runtime.thinking` and `runtime.tools` are reported
  as proposals until a preset is applied.

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
installed.

## Checks

```sh
npm test
```

- `test/schema-strict.test.mjs` — declaration and overlay validation
- `test/manager-inspection.test.mjs` — the manager installed and driven inside a
  real isolated Pi session
- `test/composition-provenance.test.mjs` — layer folding, and inherited presets
  reviewed through real Git and npm sources

Tracked by
[issue #12](https://github.com/CheeseFox259/pi-wardrobe/issues/12).
