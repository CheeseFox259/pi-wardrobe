# Standard preset repositories

Wardrobe imports Pi packages with a `preset.json` declaration (schema version 1). A repository may provide one preset at its root or index several presets. Existing unindexed repositories retain discovery compatibility; new collections should use an explicit index.

## One preset

```text
package.json
preset.json
extensions/main.mjs
skills/review/SKILL.md
prompts/review.md
themes/example.json
```

`package.json` declares native Pi resources. Explicit extension paths may end in `.mjs`:

```json
{
  "name": "my-pi-preset",
  "version": "1.0.0",
  "type": "module",
  "pi": {
    "extensions": ["extensions/main.mjs"],
    "skills": ["skills"],
    "prompts": ["prompts"],
    "themes": ["themes"]
  }
}
```

`preset.json` declares identity, Pi compatibility and the subset to enable. Every selected resource must exist and be available through the package’s native resource declarations:

```json
{
  "schemaVersion": 1,
  "id": "my-team/coding",
  "name": "Team Coding",
  "version": "1.0.0",
  "compatibility": { "pi": ">=1.1.0" },
  "packages": { "self": { "source": "." } },
  "resources": [
    { "package": "self", "kind": "extensions", "include": ["extensions/main.mjs"] },
    { "package": "self", "kind": "skills", "include": ["skills/**"] },
    { "package": "self", "kind": "prompts", "include": ["prompts/**"] },
    { "package": "self", "kind": "themes", "include": ["themes/**"] }
  ],
  "runtime": { "tools": { "enable": ["read", "edit", "write", "bash"] } },
  "persona": { "append": ["Inspect relevant code before changing it."] }
}
```

Declare the minimum tested Pi version with `>=`; newer Pi versions can load the preset. An optional `compatibility.platforms` array may restrict platforms, for example `["darwin-arm64"]`. Resource paths are package-relative; reject absolute paths, parent traversal and escaping symlinks. A missing selector enables no resources of that kind; `include: []` explicitly selects none. Unknown declaration fields are errors.

Additional aliases use exact native sources:

```json
{
  "packages": {
    "self": { "source": "." },
    "addon": { "source": "npm:some-pi-package@1.2.3" },
    "git-addon": { "source": "git:https://github.com/owner/addon.git@0123456789abcdef0123456789abcdef01234567" }
  }
}
```

This is a declaration fragment; substitute real packages and commits. Dependencies in the declaration remain exact. Users can import a branch or tag; Wardrobe resolves that entry to an exact commit before showing its installation plan. The stored update location/ref is separate from the installed lock.

## A collection

```text
package.json
presets/work/package.json
presets/work/preset.json
presets/work/extensions/main.mjs
presets/minimal/package.json
presets/minimal/preset.json
```

At the repository root:

```json
{
  "name": "my-pi-collection",
  "version": "1.0.0",
  "pi": { "extensions": [], "skills": [], "prompts": [], "themes": [] },
  "wardrobe": {
    "presets": [
      "presets/work/preset.json",
      "presets/minimal/preset.json"
    ]
  }
}
```

The index contains unique relative paths ending in `preset.json`; indexed files must exist inside the repository. Each nested preset has its package resources declared relative to its own `package.json`. The collection’s root Pi declaration does not silently enable all nested resources. Unindexed example declarations are ignored when an index is present.

## Import from Pi

Enter `/wardrobe`, choose **导入** and paste the repository URL. Multi-preset collections show a selector. Command equivalents:

```text
/wardrobe import owner/repository
/wardrobe import https://github.com/owner/repository --ref main
/wardrobe import owner/repository --preset presets/work/preset.json
/wardrobe import npm:my-pi-collection
/wardrobe import git:https://example.org/team/preset.git --ref release/v1
```

Review exact packages and install scripts, resources and compatibility. Confirmation applies to that plan; installation stays inactive until **使用 · 新对话**. IDs and digests are available for diagnosis but are not required for normal panel use.

## Keep portable repositories portable

Do not put authentication, models, model defaults, private MCP configuration, machine-absolute paths or temporary localhost sources in declarations. Models/auth stay native Pi. The first-use original profile is deliberately local-only and records machine dependencies; copying that directory is not a supported export.

Package source changes belong in a reviewed revision. Whole-preset updates preserve the old revision and history. Pi and extensions use native `pi update`. Wardrobe source maintenance creates local revisions while preserving the old source and runtime. Existing package overrides are materialized into maintenance source; locally maintained revisions return to reconciliation on update.

`presets/minimal-coding`, `presets/engineering` and `presets/perfect-pi` in this repository are indexed examples. Full presets may also use reviewed package-owned agent files; that extended contract and its seed/immutable distinction are documented in [ADR-0005](adr/0005-complete-presets-with-reviewed-agent-files.md) and the [authoring reference](usage-and-authoring.md).

## Skill maintenance

The manager supplies `wardrobe-update` and `wardrobe-maintain` as shared skills. `update` handles upstream/runtime capability adoption. `maintain` handles only a concrete user-requested fix or addition.

Put product principles, feature tradeoffs, and preservation constraints in `skills/preset-policy/SKILL.md`. When either workflow starts, its result includes `skills.shared` and `skills.preset` together. The private policy is read from the frozen input, so edits to the candidate cannot erase the starting constraints. It need not be selected as an interactive Pi skill. If it is absent, Wardrobe preserves existing behavior and declared local enhancements and uses the preset README for product context; it does not impose another preset’s philosophy.

Optional `skills/update/SKILL.md` and `skills/maintain/SKILL.md` entries should call `wardrobe_workflow` and follow the returned two layers. Execution instructions belong to the manager. The `guidance` action writes these thin entries and preserves previous skill text in a companion archive for historical context. Explicit user requirements take precedence over preset preferences; unresolved required work prevents installation.

`components.json` records resource lineage: an override has its upstream repository, exact `baseRef`, local path, upstream path and preserved features. Register custom skills with `type: "custom"` and `localPath`. Source-wide reviewed targets are receipts, not substitutes for the actual per-resource integration base. A deferred or retired resource keeps its older base. Exact Git objects persist in the native upstream cache; subsequent runs fetch missing targets, not previous baseline objects.

Wardrobe returns NO_UPDATE without dispatching a model when tracked inputs are unchanged. New workflows expose the complete capability change list with exact differences and release channels. The model chooses dependency order and uses `save` for partial decisions; final `verify` requires complete coverage. Session binding supplies workflow coordinates automatically. The model submits adopt/adapt/defer decisions, resource changes, file migrations and affected checks directly through `wardrobe_workflow verify`. The program compiles resource declarations, materializes actual dependencies, verifies and preserves progress. `READY_TO_INSTALL` permits promotion of that same artifact to an inactive revision. `REVIEWED` saves an all-deferred review without an empty version. Only installed, verified integration advances resource bases; deferred skills retain their old base and are reconsidered if local content or relevant runtime changes. Source edits never occur inside an installed revision. Models/auth and native program upgrades stay with Pi.

The handoff's `releaseNotes` points to the exact Pi version interval, cached Git commit/path ranges and exact target npm package documents. Commit subjects are distinguished from published release notes. Missing package changelogs include available metadata and repository channels; optional downloads time out rather than block model handoff. Documents are read without executing package scripts and cached separately from the editable candidate.

Declare a minimum Pi runtime, for example `"compatibility": {"pi": ">=1.0.4"}`. Legacy exact/caret/tilde/wildcard shorthand also denotes a floor; explicit comparator constraints remain explicit. Higher Pi versions may load unchanged older presets. This does not certify arbitrary future API changes: native extension loading and focused verification report concrete failures.
