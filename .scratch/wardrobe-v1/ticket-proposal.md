# Wardrobe V1 Implementation Ticket Proposal

Status: approved
Spec: https://github.com/CheeseFox259/pi-wardrobe/issues/8

Approved by the user in this session for remote publication and an explicitly scoped local execution-baseline commit. Local numbers are implementation dependency IDs. Existing remote #9 maps to 01; do not recreate it. Parent spec remains unchanged.

## 01: Controlled native-install fixtures (existing #9)

Blocked by: none

Deliver the already published local Bare Git and loopback npm workflow in isolated temporary environments, using actual Pi install/update/remove and no personal credentials or provider requests. Retain #9's authoritative criteria: two full Git commits, accurate npm scripts/integrity, installed-inactive resources, failure residue/repair, ref collision/separation, preference protection and reliable owned cleanup.

## 02: Install the manager and inspect a local preset

Blocked by: none

Deliver a real native Pi package entry with /wardrobe, no automatic preset dependencies, and local snapshot inspection through list/show/explain. Accept a minimal valid declaration and report path-specific errors for unknown fields, compatibility/version syntax and source-qualified ambiguity. Establish the repeatable Node test/package checks needed for this path, without introducing framework-only tickets.

Acceptance:
- Installing/loading the manager in an isolated Pi session registers /wardrobe without engineering/MCP/browser dependencies or side effects to unrelated resources.
- A local self-contained Minimal Coding declaration is snapshotted and inspected without claiming installed/active state; explain identifies declared fields and origins.
- Strict schema rejects unknown/credential/private/MCP/script-hook fields and malformed metadata with actionable diagnostics; short IDs never silently resolve ambiguous sources.
- Model/Thinking and tool preferences remain proposals until applied; no personal settings/auth are copied or overwritten.

## 03: Discover source presets and approve an immutable review plan

Blocked by: 01, 02

Deliver Git/GitHub/npm source resolution and multi-preset selection without executing package/Extension code during discovery. /wardrobe install initially produces an immutable review plan/digest and requires exact selection/approval; installation integration arrives in 05.

Acceptance:
- Bare Git transport exercises real source retrieval at full commits; GitHub URL normalization/discovery is checked with controlled responses, without calling those live-GitHub verification.
- Exact npm source, tarball integrity and version metadata are captured without lifecycle execution. Discovery must not delegate to a native install before approval.
- Relative/self resources use the captured source root and native manifest; missing/escaping paths or symlinks, undeclared resources and unresolvable aliases fail before install.
- For Git/npm import, self source '.' resolves to that captured package's pinned native source. Local snapshots are allowed only for self-contained resources with no non-host dependency installation needed; Pi local-path loading is never presented as dependency installation.
- Multi-preset repositories require selection, and equal IDs across repositories remain distinct.
- Preview names all known installation/load surfaces and exact approved artifacts; cancellation leaves no managed install/config mutation.
- Noninteractive approval is tied to a displayed plan digest, invalidated by source/artifact changes; no blanket approve-all or no-UI consent.

## 04: Review inherited and overridden environments with provenance

Blocked by: 03

Deliver composition through the same show/explain/review flow: single-parent resolution, Base -> Preset -> User -> Session rules and executable-change classification. A resolved plan is reviewable rather than an opaque JSON merge.

Acceptance:
- Parents resolve to reviewed exact sources/snapshots; cycles, alias rebinding and conflicting versions of one canonical package are rejected with both origins.
- Explicit resource selector rules handle inheritance, empty includes, higher-layer re-inclusion and same-layer exclusion precedence; absent effective selectors load none.
- Tools obey enable/disable precedence and preserve CLI/user restrictions; instructions append in order, and explicit user/CLI model choice wins.
- explain traces resulting values/disabled reasons to source layers and resource identities; no secrets are included.
- Loaded-resource changes require a new reviewed revision; session overlays stay limited to soft fields and cannot add executable dependencies.

## 05: Approve and install a preset with resources inactive

Blocked by: 04

Deliver the full reviewed native npm/Git install path in fresh staging agentDir storage, with installed-inactive inventory and visible failure diagnostics. It must never upgrade or alter an existing available revision in place.

Acceptance:
- A valid approved plan installs actual controlled npm/Git sources through Pi into owned staging; the plan still matches approved artifacts before and during installation. Git/npm self source '.' uses its pinned native source; dependency-bearing local snapshots must not silently skip installation requirements.
- All package resources remain filtered inactive during installation and subsequent inspection; Extension command/tool/event markers prove no pre-activation load.
- Cancellation/no approval/invalidated digest runs no installer. Settings/user files outside owned staging remain intact.
- Install failure leaves an explicitly failed/unavailable staging record and reports residual files/script effects without claiming rollback; existing available revisions survive.
- A new staging retry is possible without falsely treating retained failed effects as undone. Preliminary installed inventory is clearly distinct from verified launch availability in 06.

## 06: Verify immutable revisions and diagnose drift

Blocked by: 05

Deliver publication of verified available revisions and truthful list/show/status/doctor across installed, failed and drifting states, with locks that support later launcher preflight.

Acceptance:
- Availability requires approved exact sources/integrity, deterministic effective configuration hash, selected resource/code and installed dependency fingerprints, and runtime/toolchain/platform baseline.
- Fingerprints exclude credentials, Git internals and approved mutable runtime data; runtime data is outside locked code roots.
- Unexpected code/dependency/config drift is identified and refuses healthy/available launch state, rather than silently accepting it as an update.
- Separate approved revisions preserve independently owned storage; native same-repo refs never mutate an existing revision.
- Missing or different reconstruction is not reported as the original exact revision; no unconditional frozen-transitive-rebuild promise.
- Status/doctor distinguish intended configuration from observed available state and unsupported/unverified environments without exposing secrets.

## 07: Launch a verified preset in a real isolated Pi process

Blocked by: 06

Deliver standalone wardrobe run <id> with preflight and real Pi process lifecycle, plus /wardrobe use's full-switch launch plan. Use controlled resources to validate loaded state, not only generated settings.

Acceptance:
- Launch uses its dedicated revision agentDir and explicit session directory, retains user/CLI selection precedence and independently provisioned auth; no personal auth/MCP files are silently copied/symlinked.
- Actual selected Extensions/Skills/Prompts/Themes and tools load through native resource mechanisms; command/registration collisions and unmet tool/resource requirements are diagnosed, not hidden.
- A second writer/run to the same revision is refused; independent revisions may have separate processes. Release owned leases on orderly exit and diagnose stale ownership without stealing live work.
- /wardrobe use emits a new-process launch plan for resource/code/package differences, refuses while busy, and never embeds another TUI or claims to clean arbitrary old Extension effects.
- Child cwd/arguments/signals/exit status are handled correctly; closing a controlled process ends its own interval/global state, without claims about detached descendants or external writes.
- Failed startup/preflight preserves prior revision availability and diagnostics; no false healthy/active transition or personal baseline mutation.

## 08: Apply idle session overrides without changing code

Blocked by: 07

Deliver same-runtime /wardrobe use and explicit session preference changes for tools, model preference, Thinking and instruction append, with observable effective state/provenance.

Acceptance:
- Soft changes leave PID, package/resource fingerprints and installed revision unchanged; code/MCP/loaded-resource differences instead return the full-switch plan.
- Busy/compacting states refuse or wait according to the approved idle boundary without mutating preferences halfway through an active turn.
- CLI exclusions and explicit user model choices remain authoritative; unavailable model preferences are diagnosed rather than reported applied.
- Applied vs intended tool/Thinking/model/prompt state is shown by status/explain. Session changes do not write retained revision code or personal settings.
- Controlled real Pi/faux-local-provider observations demonstrate effective prompt/tool state without network model calls.

## 09: Persist bindings and resume follow or strict sessions

Blocked by: 07

Deliver launcher/session UI mode selection and real session persistence/resume, including the empty-session boundary. Follow uses the latest approved available revision by approval order, not network latest or semver alone.

Acceptance:
- Binding records identity, mode, effective revision/config hash, soft override data and migration evidence; custom-entry-only startup is transient, with owned launch coordination separate from a durable conversation.
- Follow resume automatically preflights the newest approved available same-source/same-ID revision and records old/new migration without repeated manual approval; explicit restrictions or unavailable requirements still refuse.
- Strict resume restores the intact exact revision or refuses missing/drifting resources, with explicit recovery/mode-change choices and no silent substitution.
- UI exposes deliberate follow/strict/target change; approved credentials/runtime/data are not included in code fingerprints.
- Old messages and loaded Skill text remain unchanged; concurrent revision leases and real session-directory behavior are respected.
- A controlled real Pi subprocess persists a conversation via a local provider and resumes it in another process without live model credentials.
- status/doctor/explain show active versus desired follow/strict mode and revision, mismatch/unavailability/drift, migration provenance and restrictions; failed recovery never reports healthy.

## 10: Reconcile forked and tree-navigated bindings before a turn

Blocked by: 08, 09

Deliver safe branch-state navigation in the running Pi session, not a speculative new resource reload path.

Acceptance:
- Fork inherits the selected branch's binding and soft overrides; a persisted fork resumes with those records.
- Tree navigation restores desired soft fields only if compatible with the active runtime; a follow branch may remain on its current newer approved revision with migration evidence rather than chasing installed newest mid-process.
- Another preset, strict revision mismatch or missing required resource blocks the next model turn and supplies a relaunch plan; it never loads different executable resources in-process.
- Bound history is not overwritten or rewritten; active PID/code state and user restrictions are observable throughout navigation.

## 11: Release references and remove only unreferenced owned revisions

Blocked by: 09

Deliver remove/release with owned storage and session/activity reference checks, through user commands and real native cleanup.

Acceptance:
- Active revisions, strict bindings and explicit retain references block deletion; follow historical records alone do not pin all old revisions indefinitely.
- remove --revision deletes only a safe owned target; remove without revision refuses when any relevant target is referenced rather than partially deleting arbitrarily.
- release drops an explicit retention reference without deleting transcript or silently changing strict mode; strict binding changes must be deliberate before removal.
- Native package cleanup operates only in the selected owned revision root; identical sources in other revision directories and personal resources/settings/auth remain intact.
- Missing paths, stale leases, escaping symlinks or ambiguous ownership are diagnosed/refused, not used to delete arbitrary directories. Script external effects are not claimed reversed.
- An intact remaining revision can launch/resume after removal, and returning to the user's original environment preserves observed preferences/sentinels.

## 12: Select startup presets and opt into pi --wardrobe forwarding

Blocked by: 09

Deliver the actual interactive standalone selector and optional shell/PATH integration with strict/follow/revision choices, using real PTY evidence.

Acceptance:
- Standalone wardrobe and opted-in pi --wardrobe display a pre-Pi selector; selection validates mode/revision and invokes the existing launcher, while cancellation starts no preset process.
- Ordinary Pi arguments pass unchanged to an explicitly resolved real Pi executable; cwd, exit/signal behavior and --help/--version/noninteractive invocations are preserved without recursion.
- Integration enable/disable is explicit and reversible; no existing Pi binary or unrelated shell config is overwritten automatically.
- Real node-pty paths verify selector navigation, cancellation, run/resume mode choice and basic forwarding. No fake success from a screenshot or pure DOM model.
- Unsupported terminal/runtime conditions fail clearly and leave the baseline usable.

## 13: Deliver an independently installable Minimal Coding preset

Blocked by: 07

Deliver the concrete native-only reference through the same review/install/launch path as community presets, including author-facing declaration and observable runtime behavior.

Acceptance:
- Minimal Coding includes only native tools/Thinking/append instructions and no Perfect Pi, Skill framework, subagent, MCP or provider-specific model dependencies.
- Its identity/version/compatibility and exact resource declaration match the approved example; no private manager hook is used.
- Local captured definition and pinned Git fixture import both review/install/launch successfully. Runtime observations show native tools and appended instructions effective without changing explicit personal choices or credentials.
- Manager installation remains independent of reference selection; cancelling reference review installs nothing.

## 14: Deliver the optional curated Engineering reference preset

Blocked by: 07

Deliver one useful engineering reference through the same public review/install/launch path, audit its selected resources, and report unavailable workflow prerequisites truthfully. Cross-preset integrated switching is acceptance in 15; this ticket still verifies its own installed/launched reference.

Acceptance:
- Include the exact curated 12 Skill families and their supporting references, question/questionnaire resources, pinned guardrails 0.19.0 and LSP 0.49.9 with approved explicit entry paths; no default SoL-Pi/browser/web/subagent/full toolchain.
- Audit and record fixed source lineage and required license/NOTICE data. Missing Skill/tool prerequisites report unavailable before entering that workflow; never silently install them or claim absent capabilities. Unsupported workflows do not make available tools fail.
- Native manifests match explicit resource selection; relative self imports resolve to captured pinned native sources. Installed runtime observations show question tools/selected Skills/LSP registration and guardrails entry with no privileged manager APIs.
- LSP route/server and private guardrails policy limits are visible; no automatic server installation/private config override or claim that a merely loaded package enforces an undeclared policy.
- The reference remains optional and does not modify the live Perfect Pi environment. Its source/package roots and credentials are independent of personal installs.

## 15: Exercise and document the complete V1 user path

Blocked by: 10, 11, 12, 13, 14

Deliver final process/PTY acceptance and usable installation/author/usage documentation on the approved exact baseline. This is not a test-only substitute for earlier vertical slices: each previous ticket verifies its own delivered behavior; this ticket proves the integrated path and fixes integration regressions.

Acceptance:
- One controlled run covers manager installation, Bare Git/npm discovery/review, cancellation, installed-inactive, launch, soft/full transition, follow/strict resume, tree/fork refusal, drift/failure, referenced removal and baseline restoration.
- GitHub source normalization/discovery is exercised with controlled responses separately from real native transport; local evidence is not described as live public-GitHub verification.
- Reproducible evidence records Pi 1.1.0 / Node 26.5.0 / npm 11.17.0 / macOS arm64; commands/assertions and failure cleanup, no personal credentials/provider requests or external publication.
- Include pre-install code-surface approval, integrity changes, no-UI approval, stale/competing writer refusal and failed-start recovery outcomes, without weakening checks to pass.
- Documentation describes commands, reference availability, source-qualified identity, follow/strict tradeoffs, lock/rebuild limits, opt-in forwarding removal and no-sandbox/external-side-effect limits; unknown platforms remain unverified.
- All 14 parent acceptance outcomes map to actual observed checks or explicit not-run limitations; missing mandatory V1 evidence prevents calling the release verified.

## Dependency Summary

01: none
02: none
03: 01, 02
04: 03
05: 04
06: 05
07: 06
08: 07
09: 07
10: 08, 09
11: 09
12: 09
13: 07
14: 07
15: 10, 11, 12, 13, 14

Initial frontier: 01 (#9), 02. After 07, soft overrides and resume may proceed separately; subsequent references, deletion and interactive forwarding can also be isolated. Future sessions must claim before work and version agreed execution artifacts before worktree dispatch. No claim or execution completion is recorded by this proposal.
