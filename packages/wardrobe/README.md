# @pi-wardrobe/manager

The Wardrobe preset manager for Pi. It registers exactly one command,
`/wardrobe`, and nothing else.

## Command surface

| Command | Behaviour |
| --- | --- |
| `/wardrobe list` | Discovers `preset.json` declarations in the configured source directories, validates each strictly, and lists them with their snapshot state. Read-only: it never copies resources |
| `/wardrobe show <preset>` | One preset's identity, version, source, declared packages and resources. Captures a snapshot as it inspects |
| `/wardrobe explain [preset]` | Every declared field with its origin, including nested leaves, plus the preferences that are proposals. Captures a snapshot as it inspects |
| `/wardrobe install <source>` | Discovers the source and produces an immutable review plan. Installs nothing |
| `/wardrobe install <source> --preset <path>` | Explicit selection when a source declares more than one preset |
| `/wardrobe install <source> --confirm <digest>` | Approves a plan by quoting the digest it printed. A different digest is refused |

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
refused: a preset always pins what it resolved to.

Each entry in `resources` selects paths *inside* a declared package:
`package` names an alias from `packages`, `kind` is `extensions`, `skills`,
`prompts` or `themes`, `include` is required and `exclude` optional. Both lists
hold package-relative paths such as `skills/review/SKILL.md`.

Validation is strict. Unknown fields, malformed versions or ranges, and
excluded concepts — credentials, MCP server definitions, script hooks, plugin
private configuration — are refused with the exact path that caused them.

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

- `test/schema-strict.test.mjs` — declaration validation
- `test/manager-inspection.test.mjs` — the manager installed and driven inside a
  real isolated Pi session

Tracked by
[issue #10](https://github.com/CheeseFox259/pi-wardrobe/issues/10).
