# @pi-wardrobe/manager

The Wardrobe preset manager for Pi. It registers exactly one command,
`/wardrobe`, and nothing else.

## Command surface (ticket 02)

| Command | Behaviour |
| --- | --- |
| `/wardrobe list` | Discovers `preset.json` declarations in the configured source directories, validates each strictly, and lists them with their snapshot state. Read-only: it never copies resources |
| `/wardrobe show <preset>` | One preset's identity, version, source, declared packages and resources. Captures a snapshot as it inspects |
| `/wardrobe explain [preset]` | Every declared field with its origin, including nested leaves, plus the preferences that are proposals. Captures a snapshot as it inspects |

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
