# Pi Wardrobe V1: Reproducible Preset Lifecycle

Status: ready-for-agent

## Problem and goal

Pi users need to discover, review, compose, activate and share working-environment presets without replacing Pi's package manager or overwriting their personal environment. Pi Wardrobe is the general manager; Perfect Pi is an optional reference preset using the same public contract as community authors.

V1 supports GitHub source import, installation with resources inactive, explicit activation, idle soft changes or new-process full changes, follow/strict session resume, owned revision removal and return to the user's baseline. It includes a controlled executable Extension path, not just prompt data.

Design decisions and the prototype verdict are settled. Runtime validation and controlled fixture preparation are implementation work; absence of those completed checks does not make this specification needs-info.

## Agreed decisions

### Architecture and authorization

- Native /wardrobe manages discovery, review, inspection and declarative soft changes. A thin launcher starts real Pi with a dedicated resolved-revision PI_CODING_AGENT_DIR for full resource/package/Extension/MCP lifecycle changes. Do not replace the Agent Loop.
- Provide a standalone wardrobe selector/run command and optional, explicitly enabled pi --wardrobe shell/PATH forwarding. It selects before Pi starts, passes ordinary invocations unchanged to a resolved real executable, avoids recursion and never overwrites Pi automatically. Do not spawn nested interactive TUIs from use.
- Pi owns native package install/update/remove. Review precedes executing installation code. Install into new staging storage, verify before publishing availability, retain failures as diagnostic state and never upgrade an available revision in place.
- No writable package-root sharing across presets/personal installs; reject competing writers/runs for one revision environment. Do not automatically copy/symlink personal credentials or expand authorization. Use Pi native authentication or deliberate user configuration.
- Soft changes are idle-only and do not change loaded code, resources or package versions. Full changes use a new process; failure must not claim arbitrary side effects or detached processes reversed. Preserve baseline settings, personal model choice and unrelated resources.
- CONTEXT.md supplies domain language. ADRs 0001-0004 record manager/reference separation, native package ownership, hybrid launcher and follow-by-default/strict reproduction.

### Definition and Identity

A repository may contain several definitions at explicit paths such as presets/minimal/preset.json. GitHub import resolves a source to a full commit and offers a selection; it never installs every discovered preset implicitly. Local import snapshots the definition and referenced owned resources before approval so mutable working files do not become an installed revision's authority.

A preset identity is its canonical source repository plus declared id; equal ids from distinct repositories are not interchangeable. Short ids may be used only when unambiguous; otherwise commands require the source-qualified candidate. Version is a semantic version label, not an installed revision identity. installedRevisionId identifies the actual resolved configuration/resources and recorded platform/runtime baseline.

preset.json is data. Unknown fields, malformed semantic versions/compatibility expressions, missing selected resources, unresolved aliases, cycles, and ambiguous identities fail with a path-specific diagnostic before installation. No executable callbacks, arbitrary settings overlay, plugin-private config, credential values, or MCP server definition is accepted in V1.

### Public Fields

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

### Composition and Overrides

Order: Base -> Preset -> User Override -> Session Override. Omitted fields inherit; explicit values use the field's rule rather than generic JSON deep merge.

- Aliases are stable: an inherited alias cannot be rebound to another canonical package. Versions resolve exactly; any two declarations requiring different versions of one canonical package fail rather than selecting a winner. User/session overrides cannot add unreviewed executable dependencies.
- Missing resource selectors inherit when a lower layer supplies one; only a package/type with no selector anywhere defaults to loading none. Explicit include [] chooses none. For each selector process layers in order: a supplied include replaces the candidate include set and explicitly re-includes its listed reviewed paths; an omitted include inherits. A supplied exclude removes its listed paths after that layer's include processing; same-layer exclude wins. Lower exclusions persist unless a higher layer explicitly re-includes those paths. This only changes reviewed resources; adding code outside the reviewed revision requires a new install/review.
- Tools: apply each layer's enable/disable changes; same-layer disable wins. Higher layers may change lower selections but never bypass CLI exclusions or the user's authorization boundary.
- persona.append concatenates in layer order. No implicit deletion or replacement of earlier instructions. Model preferences yield to explicit user/CLI choice.
- explain reports the effective value, source layer, source revision/resource identity, disabled reasons, and conflicts without exposing secrets. An accepted preference must be distinguished from effective runtime state.
- User overlays affecting loaded resources are materialized as a new resolved revision with the same install/verification process. Session-only overrides are limited to idle soft-switchable tools/model/thinking/append preferences; they do not edit retained revision resources.

### Revision Lock and Verification

Record schema version, source-qualified preset identity and definition version, full definition/parent commits or snapshot hashes, exact package sources, npm tarball integrity, canonical resolved configuration hash, selected resource identity/content hashes, dependency tree/code fingerprint, and Pi/Node/npm/platform baseline. A deterministic SHA-256 canonical configuration digest excludes display/session timestamps, secrets, user credentials, and runtime caches. Dependency fingerprints cover installed code/manifests and dependency resolution, not .git internals or declared non-code runtime data. Runtime data must live outside locked code roots; unexpected locked-code changes are drift.

Compatibility metadata, source pinning, and install-time authorization are separate. Verify the downloaded artifact matches its reviewed source/approved integrity before considering a revision available. Pi-native install may execute scripts, so review must precede invoking it. Failed staging is retained as explicitly failed/unavailable diagnostic state, never active. No in-place update of an available revision; no shared writable package roots.

Exact transitive rebuild after deleting an old installation is not promised. Prefer retained verified revisions. If rebuilding yields a different dependency/resource fingerprint, report drift, create no false equivalent revision, and require a new approval for that new resolution. Different OS/toolchain fingerprints are not silently equivalent.

### Session Resume and Update Modes

Default mode is follow. Follow selects the newest approved, available revision by approval order for the same source-qualified preset identity, not the newest network version or arbitrary other-source id. Updates are reviewed at installation once. A new approved revision does not invalidate old conversations and requires no repeated manual review solely because hashes changed. No positive author compatibleFrom declaration is mandatory. Explicit Pi/platform incompatibility, missing required resources, tool requirements that cannot be met, or a changed user restriction refuse or require a deliberate migration choice. A changed restriction means an explicitly disabled tool/resource, denied project trust, CLI exclusion, or withdrawn revision approval prevents the proposed state. New code and install surfaces must already have been covered by that revision's installation approval; follow mode never extends that approval to other artifacts or credentials. Version/semver labels alone never grant execution permission.

Strict mode pins an exact installedRevisionId and resolved configuration. Missing or drifting pinned code refuses and presents recovery options; it does not substitute a newer revision. Resume verification is automatic and no new approval dialog is needed for an intact retained revision. Neither mode means arbitrary code is sandboxed.

Persist binding records containing preset identity, mode, effective revision/hash, session soft overrides, and old/new revision migration evidence. Existing skill text in historical messages is not rewritten. A custom entry alone may not flush a new Pi session, so before Pi persists a conversation the binding is transient; use an owned launch record for startup coordination without claiming the session is durably bound.

Fork inherits the branch's binding and soft overrides. In-session tree navigation never changes executable/package revisions. It restores desired binding and soft settings only if compatible with the active process; a follow branch can stay on the current newer approved revision with a recorded migration, without seeking the newest installed revision mid-process. A strict mismatch, another preset identity, or an unavailable required resource blocks the next model request and presents a new-process launch plan. A later launcher resume applies follow's newest-approved policy. This is not a promise of restoring old operating-system side effects.

Removal refuses active revisions and strict/explicit retained references. Follow history can record prior revisions without pinning every one forever. release <id> --revision <revision> explicitly drops a retention reference without deleting session history or converting strict bindings silently; any still-strict binding prevents deleting that revision. The user must change that binding mode/target or explicitly leave it unavailable. Ordinary remove never forces this. No automatic garbage collection or baseline resource deletion in V1.

### Commands and Startup

Native management commands under /wardrobe: list, show <id>, install <source>, use <id>, status, doctor, explain [id], remove <id> [--revision <revision>], and release <id> --revision <revision> for explicit retained-reference management. remove with --revision deletes only that unreferenced owned revision; remove without it deletes the preset's unreferenced revisions and refuses the operation if any relevant active/retained reference remains. Startup selector offers resume mode and a revision choice; strict pin selection is explicit. The UI must expose how to change a session binding between follow and strict. Detailed argument grammar may be finalized in implementation without changing these behaviors.

install imports/reviews/selects, installs and verifies, but never activates. Cancellation leaves no approved installation/configuration mutation; disposable discovery data may remain. Noninteractive install must supply unambiguous selection plus an explicit approval tied to the displayed immutable review-plan digest. If sources/artifacts change, that digest is invalid and installation must stop; there is no blanket approve-all option. The human may decline all executable installation/load surfaces. UI absence and cancellation are never consent.

use only applies idle soft differences when loaded resources and package revisions remain the same. Otherwise it displays the real new-process startup plan; it does not spawn a second interactive TUI inside the existing one. status/doctor compare intended and actual state. install failures, unknown code drift, mismatched strict bindings, and unresolved conflicts must never be reported healthy.

Standalone wardrobe opens the interactive startup selector; wardrobe run <id> starts an explicitly selected available revision through real Pi. Optional shell/PATH forwarding supports pi --wardrobe before Pi starts. No-flag invocations forward unchanged to a resolved executable, preserving cwd/arguments/exit code/signal intent and avoiding recursion. The integration is explicit, reversible, and never silently replaces the Pi binary. A selector cancellation starts no preset process.

### Reference Definitions

These examples define author-facing shapes and content, not published packages. Relative self resources must be backed by a Pi package manifest. The future public GitHub fixture and packaged reference source are pinned to actual full commits at publication; no placeholder URL is authoritative acceptance evidence.

#### Minimal Coding

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

#### Simplified Perfect Pi Engineering

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

### Examples of Required Refusals

- A child rebinds alias lsp to another package, or two aliases select different versions of one native package identity: reject with both declaration origins.
- An include selects ../../credentials, an escaping symlink, a missing resource, or a resource outside the package declaration: reject.
- A runtime attempts to enable a CLI-excluded tool: retain the CLI restriction and explain the unmet preference; refuse activation if it is a declared required resource.
- A follow resume selects an intact approved newer revision: automatically record migration and proceed without repeating update approval. A strict resume for the old missing revision: refuse, offer explicit recovery/mode change.
- Updating an available revision by changing its files: report drift. Do not reinterpret it as an approved new revision.

## Acceptance criteria

- [ ] Install Wardrobe in a clean Pi environment and access /wardrobe without automatically installing either reference preset, Matt Skills, SoL-Pi, browser or MCP dependencies.
- [ ] Discover/select a preset from a GitHub source or controlled Git source, normalize its identity, resolve full commits and exact package versions, and preview resources, installation execution surfaces, compatibility, conflicts and review-plan digest before execution. A multi-preset source requires explicit selection.
- [ ] Reject unknown declaration fields, missing/escaping/undeclared resources, ambiguous identities, inheritance cycles, alias rebinding and conflicting native package versions, with actionable origin-specific errors and no managed installation.
- [ ] Cancelling review starts no installation or activation and changes no managed configuration; disposable discovery data may remain. Noninteractive operation needs explicit selection and approval bound to an unchanged review plan.
- [ ] Native package installation creates a verified available revision with selected Extension tools/handlers inactive until explicit launch. Failed staging is unavailable, prior revisions remain usable, and residual files/script effects are reported instead of being called rolled back.
- [ ] Activation exposes actually loaded resources and tool/provider state, not merely intended configuration. Preserve explicit user/CLI model choices, CLI tool restrictions and independent credentials. Missing LSP servers or Skill dependencies are clearly reported, not auto-installed.
- [ ] Switch between native-only Minimal Coding and the selected simplified Perfect Pi reference without a privileged Perfect Pi API. Soft changes preserve code/package revision and process; full changes produce an idle new-process launch plan. Busy operations and unsafe mismatches refuse.
- [ ] Record locks covering exact approved sources, integrity, effective configuration, selected code/resources, installed dependency resolution and execution baseline. Unapproved drift refuses; a changed reconstruction is not falsely labelled the original revision. Do not promise unconditional frozen transitive rebuild.
- [ ] Follow resume automatically selects the newest approved available same-source/same-id revision at launch, checks requirements/restrictions and records migration without repeated update approval. Strict resume restores only the exact intact pinned revision or refuses with explicit recovery options. No positive author compatibility declaration is required for follow.
- [ ] Preserve old messages and Skill text. Fork inherits binding/overrides. Tree navigation never swaps executable revisions in-process; incompatible desired state blocks model execution and provides relaunch instructions. Binding-only sessions are transient until Pi persists a conversation.
- [ ] Removal affects only owned unreferenced state. Active/strict/explicit retained references block removal; follow history alone does not retain every old revision indefinitely. release does not delete transcripts or silently convert strict bindings. Other revisions' independent package roots and baseline resources remain intact.
- [ ] Status, doctor and explain report effective versus intended state, revision/mode, provenance, unmet requirements and drift without exposing secrets. Failed recovery is never reported healthy.
- [ ] The optional pi --wardrobe selector handles cancellation, selection and explicit disable/uninstall, forwards ordinary Pi arguments/cwd/signals/exit status without recursion, and leaves the real Pi binary and unrelated shell configuration intact.
- [ ] Complete process-level and PTY acceptance through import/review -> installed inactive -> launch -> soft/full change -> follow/strict resume -> failure/refusal -> removal/return to baseline using controlled native transports. Record observed evidence and limitations; simulations alone do not satisfy runtime acceptance.

## Testing decision

The user confirmed a real Pi process as the highest practical acceptance boundary. Use node:test to orchestrate isolated HOME, agentDir, project, npm/cache/config and Git config; real CLI/RPC processes verify tools, events, session entries, settings and markers. Use node-pty for actual interactive selector and command/handoff behavior. Do not replace the installer or resource loader with mocks in native successful-path acceptance. Controlled failure injection is allowed for failure scenarios. No personal credentials or paid/live model requests are required.

### Front-loaded fixture implementation ticket

The first implementation ticket is [#9: prepare local Bare Git and controlled npm fixtures](https://github.com/CheeseFox259/pi-wardrobe/issues/9), local implementation ledger 01. It prepares repeatable controlled fixtures. Prioritize a local Bare Git repository containing two immutable full commits; serve it through loopback HTTP or another Pi-supported Git transport. Exercise actual Git URL parsing, clone/ref reconciliation and dependency installation. Loading ./local-path is not an equivalent lifecycle test. Add a loopback npm registry with self-authored tarballs, accurate script/integrity metadata, success/failure scripts and bounded markers. The fixture must expose commands/evidence and reliably clean its owned resources on success and failure.

Tickets that exercise installation/staging/runtime recovery depend on the fixture ticket; independent pure declaration work need not. Fixture completion, native runtime checks and full end-to-end acceptance are implementation/release criteria, not unresolved planning questions. Do not require publishing a remote fixture to begin implementing.

### GitHub scope and evidence

GitHub URL import remains a product requirement. Test URL normalization, preset discovery and source selection with controlled responses separately from real native Git transport using the Bare Git fixture. Local sources must not be described as live GitHub verification. A live public-GitHub smoke run is optional supplementary evidence and needs concrete publication authorization if it requires an external write; public fixture publication is not a V1 planning or acceptance prerequisite under the user's local-first decision.

### Baseline and prior evidence

Initial verified-support target: Pi 1.1.0, Node 26.5.0, npm 11.17.0, macOS arm64. Pi engines accepts Node >=22.19.0, but other combinations remain explicitly unverified, not certified. Installed preference/configuration compatibility must be diagnosed instead of silently assumed.

Controlled native experiments already observed installation scripts, installed-inactive filtering, in-process timer/global persistence, failed-install residue, explicit repair, persistent Git ref collision, two-agentDir separation, removal preference preservation and custom session-entry persistence. Seven browser prototype scenarios were accepted by the user; the throwaway artifact is on local branch prototype/wardrobe-activation-20261008, commit 3fc14a8, not merged/pushed. Those are prior inputs, not evidence that the Wardrobe implementation passes acceptance. Runtime checks must be run against the delivered behavior during implementation.

## Out of scope

- Full Perfect Pi parity/migration, privileged adapters or mutation of the current live Perfect Pi environment.
- Default full engineering toolchain, SoL-Pi/compaction internal storage bridge, tmux orchestration, automatic credential sharing, arbitrary plugin settings or MCP definition schema.
- Central registry/community search, export/publishing UX, multiple inheritance or another package manager/Agent Loop.
- Arbitrary-code sandboxing, reversal of all script effects, guaranteed detached-descendant reclamation or automatic terminal takeover.
- Unconditional bit-identical transitive rebuild after deletion, automatic garbage collection, baseline-resource deletion or untested platform/version support guarantees.
- Runtime acceptance claims based only on the HTML prototype, and mandatory public fixture publication before implementation.

## Open questions

None that block implementation. Design decisions #2-#7 are resolved; fixture preparation, dependency/framework choices within this contract and runtime verification are implementation tasks. Spec readiness does not mean software delivery, test success, publication approval or permission to modify personal credentials. The approved work is ready for implementation ticket slicing, beginning with the local controlled-fixture ticket.
