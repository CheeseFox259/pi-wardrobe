# Pi Wardrobe V1 Public Contract

Status: accepted

Review baseline: approved by the human after the public-contract interview and final document review.
Decision: https://github.com/CheeseFox259/pi-wardrobe/issues/6
Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8

This is the human-approved behavioral contract, not implemented runtime behavior. CONTEXT.md supplies domain vocabulary. ADRs 0001-0004 supply architecture and update/resume boundaries. The remote decision and spec are authoritative; this local document is the review/publication artifact, not an independent acceptance authority.

## Definition and Identity

A repository may contain several definitions at explicit paths such as presets/minimal/preset.json. GitHub import resolves a source to a full commit and offers a selection; it never installs every discovered preset implicitly. Local import snapshots the definition and referenced owned resources before approval so mutable working files do not become an installed revision's authority.

A preset identity is its canonical source repository plus declared id; equal ids from distinct repositories are not interchangeable. Short ids may be used only when unambiguous; otherwise commands require the source-qualified candidate. Version is a semantic version label, not an installed revision identity. installedRevisionId identifies the actual resolved configuration/resources and recorded platform/runtime baseline.

preset.json is data. Unknown fields, malformed semantic versions/compatibility expressions, missing selected resources, unresolved aliases, cycles, and ambiguous identities fail with a path-specific diagnostic before installation. No executable callbacks, arbitrary settings overlay, plugin-private config, credential values, or MCP server definition is accepted in V1.

## Public Fields

- schemaVersion: exactly 1.
- id, name, version: required. description and author: optional display metadata, not trust signals.
- compatibility.pi: required semantic-version range; optional platforms narrows supported OS/architecture. A declaration does not certify an untested runtime.
- extends: optional single parent, with source and presetPath. Source is an exact npm version, full Git commit, or an owned local snapshot reference. Every parent is resolved, locked, and reviewed; cycles and unresolvable references fail.
- packages: object keyed by stable author-chosen aliases. Each value has source. npm sources require exact versions; Git sources require full commit SHAs. Relative local package directories are rooted at the definition's captured repository root. A package containing the definition may be referenced as source '.': this alias resolves to the captured definition repository/package root, not an arbitrary working directory. For a Git/npm import, resolve it to that same pinned native Git/npm package source so Pi installs it normally. For a local snapshot, it is permitted only for self-contained resources with no non-host dependency installation required; Pi does not install local dependencies. Any such dependencies require a reviewed pinned native npm/Git source instead.
- resources: selectors keyed logically by (package alias, kind), where kind is extensions, skills, prompts, or themes. Each selector supplies include and optional exclude lists of explicit normalized package-relative resource paths. V1 has no author glob syntax. Paths must match resources allowed by the native package declaration; selecting skills/<name>/SKILL.md selects that skill with its supporting files. Traversal, escaping symlinks, ambiguous duplicate skill/command names, and conflicting registrations fail. Package filters cannot make undeclared resources available.
- runtime.tools: optional enable and disable arrays of registered tool names. Names must resolve in the resulting runtime; duplicate/conflicting providers fail. Tool selection is not OS authorization or extension teardown.
- runtime.model: optional provider/id preference. It never overrides an explicit user/CLI model choice or introduces authentication. Unavailable preferred models produce a diagnostic and retain the user's effective selection, rather than silently claiming the preference applied.
- runtime.thinking: optional supported Pi thinking level, bounded by the effective model and explicit user choices.
- persona.append: optional ordered literal instruction strings. They append to, never replace, prior higher-authority instructions. Native prompt templates are separate resources, not automatic system-instruction append.

A nonstandard package/resource origin is not a special Perfect Pi path. Pi package installation, dependency handling, and filtering remain native responsibilities.

## Composition and Overrides

Order: Base -> Preset -> User Override -> Session Override. Omitted fields inherit; explicit values use the field's rule rather than generic JSON deep merge.

- Aliases are stable: an inherited alias cannot be rebound to another canonical package. Versions resolve exactly; any two declarations requiring different versions of one canonical package fail rather than selecting a winner. User/session overrides cannot add unreviewed executable dependencies.
- Missing resource selectors inherit when a lower layer supplies one; only a package/type with no selector anywhere defaults to loading none. Explicit include [] chooses none. For each selector process layers in order: a supplied include replaces the candidate include set and explicitly re-includes its listed reviewed paths; an omitted include inherits. A supplied exclude removes its listed paths after that layer's include processing; same-layer exclude wins. Lower exclusions persist unless a higher layer explicitly re-includes those paths. This only changes reviewed resources; adding code outside the reviewed revision requires a new install/review.
- Tools: apply each layer's enable/disable changes; same-layer disable wins. Higher layers may change lower selections but never bypass CLI exclusions or the user's authorization boundary.
- persona.append concatenates in layer order. No implicit deletion or replacement of earlier instructions. Model preferences yield to explicit user/CLI choice.
- explain reports the effective value, source layer, source revision/resource identity, disabled reasons, and conflicts without exposing secrets. An accepted preference must be distinguished from effective runtime state.
- User overlays affecting loaded resources are materialized as a new resolved revision with the same install/verification process. Session-only overrides are limited to idle soft-switchable tools/model/thinking/append preferences; they do not edit retained revision resources.

## Revision Lock and Verification

Record schema version, source-qualified preset identity and definition version, full definition/parent commits or snapshot hashes, exact package sources, npm tarball integrity, canonical resolved configuration hash, selected resource identity/content hashes, dependency tree/code fingerprint, and Pi/Node/npm/platform baseline. A deterministic SHA-256 canonical configuration digest excludes display/session timestamps, secrets, user credentials, and runtime caches. Dependency fingerprints cover installed code/manifests and dependency resolution, not .git internals or declared non-code runtime data. Runtime data must live outside locked code roots; unexpected locked-code changes are drift.

Compatibility metadata, source pinning, and install-time authorization are separate. Verify the downloaded artifact matches its reviewed source/approved integrity before considering a revision available. Pi-native install may execute scripts, so review must precede invoking it. Failed staging is retained as explicitly failed/unavailable diagnostic state, never active. No in-place update of an available revision; no shared writable package roots.

Exact transitive rebuild after deleting an old installation is not promised. Prefer retained verified revisions. If rebuilding yields a different dependency/resource fingerprint, report drift, create no false equivalent revision, and require a new approval for that new resolution. Different OS/toolchain fingerprints are not silently equivalent.

## Session Resume and Update Modes

Default mode is follow. Follow selects the newest approved, available revision by approval order for the same source-qualified preset identity, not the newest network version or arbitrary other-source id. Updates are reviewed at installation once. A new approved revision does not invalidate old conversations and requires no repeated manual review solely because hashes changed. No positive author compatibleFrom declaration is mandatory. Explicit Pi/platform incompatibility, missing required resources, tool requirements that cannot be met, or a changed user restriction refuse or require a deliberate migration choice. A changed restriction means an explicitly disabled tool/resource, denied project trust, CLI exclusion, or withdrawn revision approval prevents the proposed state. New code and install surfaces must already have been covered by that revision's installation approval; follow mode never extends that approval to other artifacts or credentials. Version/semver labels alone never grant execution permission.

Strict mode pins an exact installedRevisionId and resolved configuration. Missing or drifting pinned code refuses and presents recovery options; it does not substitute a newer revision. Resume verification is automatic and no new approval dialog is needed for an intact retained revision. Neither mode means arbitrary code is sandboxed.

Persist binding records containing preset identity, mode, effective revision/hash, session soft overrides, and old/new revision migration evidence. Existing skill text in historical messages is not rewritten. A custom entry alone may not flush a new Pi session, so before Pi persists a conversation the binding is transient; use an owned launch record for startup coordination without claiming the session is durably bound.

Fork inherits the branch's binding and soft overrides. In-session tree navigation never changes executable/package revisions. It restores desired binding and soft settings only if compatible with the active process; a follow branch can stay on the current newer approved revision with a recorded migration, without seeking the newest installed revision mid-process. A strict mismatch, another preset identity, or an unavailable required resource blocks the next model request and presents a new-process launch plan. A later launcher resume applies follow's newest-approved policy. This is not a promise of restoring old operating-system side effects.

Removal refuses active revisions and strict/explicit retained references. Follow history can record prior revisions without pinning every one forever. release <id> --revision <revision> explicitly drops a retention reference without deleting session history or converting strict bindings silently; any still-strict binding prevents deleting that revision. The user must change that binding mode/target or explicitly leave it unavailable. Ordinary remove never forces this. No automatic garbage collection or baseline resource deletion in V1.

## Commands and Startup

Native management commands under /wardrobe: list, show <id>, install <source>, use <id>, status, doctor, explain [id], remove <id> [--revision <revision>], and release <id> --revision <revision> for explicit retained-reference management. remove with --revision deletes only that unreferenced owned revision; remove without it deletes the preset's unreferenced revisions and refuses the operation if any relevant active/retained reference remains. Startup selector offers resume mode and a revision choice; strict pin selection is explicit. The UI must expose how to change a session binding between follow and strict. Detailed argument grammar may be finalized in implementation without changing these behaviors.

install imports/reviews/selects, installs and verifies, but never activates. Cancellation leaves no approved installation/configuration mutation; disposable discovery data may remain. Noninteractive install must supply unambiguous selection plus an explicit approval tied to the displayed immutable review-plan digest. If sources/artifacts change, that digest is invalid and installation must stop; there is no blanket approve-all option. The human may decline all executable installation/load surfaces. UI absence and cancellation are never consent.

use only applies idle soft differences when loaded resources and package revisions remain the same. Otherwise it displays the real new-process startup plan; it does not spawn a second interactive TUI inside the existing one. status/doctor compare intended and actual state. install failures, unknown code drift, mismatched strict bindings, and unresolved conflicts must never be reported healthy.

Standalone wardrobe opens the interactive startup selector; wardrobe run <id> starts an explicitly selected available revision through real Pi. Optional shell/PATH forwarding supports pi --wardrobe before Pi starts. No-flag invocations forward unchanged to a resolved executable, preserving cwd/arguments/exit code/signal intent and avoiding recursion. The integration is explicit, reversible, and never silently replaces the Pi binary. A selector cancellation starts no preset process.

## Reference Definitions

These examples define author-facing shapes and content, not published packages. Relative self resources must be backed by a Pi package manifest. The future public GitHub fixture and packaged reference source are pinned to actual full commits at publication; no placeholder URL is authoritative acceptance evidence.

### Minimal Coding

```json
{
  "schemaVersion": 1,
  "id": "wardrobe/minimal-coding",
  "name": "Minimal Coding",
  "version": "1.0.0",
  "compatibility": { "pi": "1.1.0", "platforms": ["darwin-arm64"] },
  "packages": {},
  "resources": [],
  "runtime": {
    "tools": { "enable": ["read", "edit", "write", "bash"], "disable": [] },
    "thinking": "medium"
  },
  "persona": { "append": ["Inspect relevant code before changing it. Keep changes scoped and report checks actually run."] }
}
```

No Perfect Pi dependencies, subagents, MCP, external Skill frameworks, or provider-specific model routes. Pi's own default runtime/built-ins remain separate from preset-provided resources.

### Simplified Perfect Pi Engineering

```json
{
  "schemaVersion": 1,
  "id": "perfect-pi/engineering",
  "name": "Perfect Pi Engineering",
  "version": "1.0.0",
  "compatibility": { "pi": "1.1.0", "platforms": ["darwin-arm64"] },
  "packages": {
    "self": { "source": "." },
    "guardrails": { "source": "npm:@aliou/pi-guardrails@0.19.0" },
    "lsp": { "source": "npm:@narumitw/pi-lsp@0.49.9" }
  },
  "resources": [
    { "package": "guardrails", "kind": "extensions", "include": ["extensions/guardrails/index.ts"], "exclude": [] },
    { "package": "lsp", "kind": "extensions", "include": ["dist/index.ts"], "exclude": [] },
    { "package": "self", "kind": "extensions", "include": ["extensions/question.ts", "extensions/questionnaire.ts"], "exclude": [] },
    { "package": "self", "kind": "skills", "include": ["skills/route/SKILL.md", "skills/grilling/SKILL.md", "skills/domain-modeling/SKILL.md", "skills/project-architecture/SKILL.md", "skills/to-spec/SKILL.md", "skills/to-tickets/SKILL.md", "skills/implement/SKILL.md", "skills/tdd/SKILL.md", "skills/code-review/SKILL.md", "skills/verify-product/SKILL.md", "skills/research/SKILL.md", "skills/setup-matt-pocock-skills/SKILL.md"], "exclude": [] }
  ],
  "runtime": {
    "tools": { "enable": ["question", "questionnaire", "lsp_diagnostics", "lsp_fix"], "disable": [] },
    "thinking": "high"
  },
  "persona": { "append": ["Use the project's domain language and architecture decisions. Preserve unrelated changes and report observed verification evidence."] }
}
```

The question extensions use Pi's host-provided TUI/typebox APIs; their bundled helper imports, if any, must be captured, not replaced by a private manager API. Selected third-party entry paths were checked against installed @aliou/pi-guardrails@0.19.0 and @narumitw/pi-lsp@0.49.9 manifests: guardrails includes only extensions/guardrails/index.ts, not path-access/permission-gate/herdr; LSP includes dist/index.ts. Enabling the package does not guarantee a particular private guardrails policy, installed language server, or configured LSP route: those must be reported accurately, with no automatic server installation or private-config override.

Skills/adapter provenance uses pinned Perfect Pi and upstream commits and required notices at packaging time. Audit selected skills' dependencies: missing browser/research/subagent/other skills must be reported as unavailable before starting that workflow, never claimed present. Bundle the support references those skills use; if an optional unavailable capability is required, direct the user to an explicit reviewed addition rather than installing it silently. Full Perfect Pi toolchain, SoL-Pi, private compaction storage, credential management and tmux orchestrator are not default dependencies.

## Examples of Required Refusals

- A child rebinds alias lsp to another package, or two aliases select different versions of one native package identity: reject with both declaration origins.
- An include selects ../../credentials, an escaping symlink, a missing resource, or a resource outside the package declaration: reject.
- A runtime attempts to enable a CLI-excluded tool: retain the CLI restriction and explain the unmet preference; refuse activation if it is a declared required resource.
- A follow resume selects an intact approved newer revision: automatically record migration and proceed without repeating update approval. A strict resume for the old missing revision: refuse, offer explicit recovery/mode change.
- Updating an available revision by changing its files: report drift. Do not reinterpret it as an approved new revision.

## Verification and Publication Baseline

Release acceptance guarantee: Pi 1.1.0, Node 26.5.0, npm 11.17.0, macOS arm64. Pi requires Node >=22.19.0, but other combinations are explicitly unverified and not presented as certified. Use node:test plus real Pi subprocesses; node-pty drives the real interactive terminal. node-pty is a reviewed test dependency, not a preset's implicit executable dependency.

Use node:test plus real Pi subprocesses in isolated temporary environments; prepare tests/fixtures as an implementation prerequisite, prioritizing a local Bare Git repository with immutable full commits. Expose that repository over loopback HTTP (or another Pi-supported Git transport) to exercise native Git parsing, clone, ref reconciliation and dependency installation; pi install ./path is not an equivalent lifecycle test. A loopback npm registry serves self-authored tarballs through real native npm sources. These fixtures need no public repository push, registry publication or personal credentials.

GitHub URL import remains a V1 product requirement. Test its source normalization and discovery with controlled responses separately from native Git transport. A live public-GitHub smoke check may be added after concrete publication authorization; it is not a prerequisite for spec readiness, and local fixtures must not be reported as live GitHub verification. Prototype #7 was accepted by the human and captured on local throwaway commit 3fc14a8; runtime environment, launcher handoff and end-to-end validation are implementation acceptance work, not unresolved design decisions.
