# @pi-wardrobe/manager

A native Pi extension registering `/wardrobe`. The root repository is also a Pi-installable package. Neither installation auto-installs a preset or manages model credentials.

## Entry and first use

From the repository root:

```sh
pi install "$PWD/packages/wardrobe"
pi
```

Enter `/wardrobe`. The first confirmation archives global resources and preferences as **我的原始配置**, backs up the original settings privately and keeps models/auth in the original Pi directory. Project resources and trust stay native. Resources outside copied directories remain explicit local dependencies. The recovery archive stays private; the preset supports the same editing, maintenance and public export operations as other presets. Public resources and declared device requirements travel; binding values stay local.

## Native composer commands

The panel is the main interface; names and versions are selectable, so IDs need not be memorized. In commands, `<preset>` can be an installed revision ID, an unambiguous name or an unambiguous declaration ID. Quote names or paths containing spaces.

| Command | Behavior |
| --- | --- |
| `/wardrobe` | Searchable preset roster: Enter uses, right arrow manages; Ctrl+n creates, Ctrl+o imports, Ctrl+d opens drafts, Ctrl+r restores conversations |
| `/wardrobe create --blank --name "Name"` | Create a public draft; omit `--blank` to copy the current global environment |
| `/wardrobe edit <preset>` / `copy <preset>` | Prepare an editable version or independent copy |
| `/wardrobe draft <draft-id>` / `drafts` | Continue editing with resource and preference menus or ask Pi |
| `/wardrobe save <draft-id>` | Review a fixed snapshot and save an inactive revision |
| `/wardrobe export <preset> <new-directory>` | Export a standard public preset directory |
| `/wardrobe bind <preset> <requirement-id> <local-path>` | Bind a declared device requirement locally |
| `/wardrobe current` | Current preset and startup defaults |
| `/wardrobe presets` | Installed native profiles |
| `/wardrobe import <source> [--preset <path>] [--ref <ref>]` | Resolve, review, confirm and install a local directory, ordinary Pi configuration, or GitHub/Git/npm preset; installation stays inactive |
| `/wardrobe use <preset>` | Clean handoff in the same terminal, starting a new conversation; startup defaults stay unchanged |
| `/wardrobe default <preset>` | Set global startup default |
| `/wardrobe default <preset> --project` | Set the current project’s startup override |
| `/wardrobe default --project --clear` | Remove the project override and follow the global default |
| `/wardrobe updates` | Choose an installed upstream preset |
| `/wardrobe update <preset>` | Check cached upstream bases, prepare safe changes, hand unresolved adaptations and new capabilities to the current Pi model |
| `/wardrobe pull <preset>` | Alias for the same incremental update workflow; never replace a revision or startup default directly |
| `/wardrobe maintain [preset] --request "Fix or capability"` | Work only on the requested change; skip unrelated upstream checks |
| `/wardrobe maintain <preset> --prepare` | Prepare the workspace without starting a model turn |
| `/wardrobe maintain <preset> --apply` | Review and install a fixed snapshot after verification; preserve the old revision and defaults |
| `/wardrobe details <preset>` | Source, version and compatibility |
| `/wardrobe resume [session-id]` | Select or restore an indexed conversation with its preset |
| `/wardrobe verify <preset>` | Full lock and approved-resource check, then refresh the startup cache for the current runtime |
| `/wardrobe repair <preset>` | Restore the fixed approved plan in a fresh attempt; original profile rebuilds from its private first-use backup and retained local resources |
| `/wardrobe uninstall <preset>` | Remove an unused installed revision; startup defaults, running processes and transcript references protect versions |
Pi and extensions use native `pi update`. The old `update-pi`, `update-manager` and `upgrade` commands only point to that native command; they perform no update.

The preset name is rendered above the composer. Locally maintained revisions return to source maintenance on update: custom skills, per-skill bases and Pi adaptations are reconciled before another snapshot is installed. Missing or disabled custom skills, unresolved conflicts, failed checks or changed verification inputs block installation. Existing package overrides remain part of the maintenance source.

The commands also accept `--yes` for deliberate automation of native-mode confirmations. It is not needed in normal panel use. Legacy `install --confirm <digest>` retains its separate review protocol.

## Storage and ownership

Under the original native agent directory (`~/.pi/agent` by default):

```text
wardrobe/native.json            profiles and global/project defaults
wardrobe/backups/               private original settings backup
wardrobe/profiles/original/     first-use resource archive
wardrobe/staging/               installed immutable revisions / repair attempts
wardrobe/plans/                 reviewed exact plans
wardrobe/cache/                 prepared-runtime stamps
wardrobe/artifacts/git/         Git objects retained for exact restoration
wardrobe/drafts/                public editable drafts; separate private authoring metadata
wardrobe/bindings.json          device-local requirement values
wardrobe/maintenance/           focused fix/feature candidates and check evidence
wardrobe/updates/               incremental update candidates and model decisions
wardrobe/upstream-cache/        exact Git objects reused as the next baseline
wardrobe/sessions/              conversation-to-profile metadata
wardrobe/native-runs/           live process presence
sessions/                      native conversation files (or Pi’s explicit custom directory)
models.json, auth.json         native Pi stores; never copied into profiles
```

A scoped Pi 1.1.0 compatibility adapter keeps native model/settings storage and approved skill precedence while isolating resources. A Pi upgrade refreshes its runtime stamp after unchanged resource configuration and code metadata are checked. Node/platform changes still require verification; changed code/configuration requires review or repair. Presets declare a minimum Pi version, so an older preset can load in a newer Pi. Normal launches inspect the selected revision’s file metadata, not every retained revision or every file’s content hash.

Native mode shares installed code read-only across terminals and subagents; native Pi owns settings/auth locks. Legacy launchers retain their prior exclusive lease rules. Mutable per-preset extension preferences stay local to that revision. Exact Git objects survive temporary import servers, but restoration can still need registry/network access for npm and dependencies.

## Compatibility and legacy tools

The native fixtures cover Pi 1.3.0 on macOS arm64 with Node 26.5.0. The [live handoff](../../docs/handoffs/pi-wardrobe-native-2026-11-24.zh-CN.md) records a separate Pi 1.6.0 deployment. Clean automatic handoff requires Node 22.19+ and macOS/Linux. Wardrobe uses Pi’s existing package manager and executes extensions with native Pi permissions.

The [legacy reference](../../docs/legacy-manager-reference.md) covers `list`, `show`, `explain`, digest installation, `doctor`, bindings, retained revisions and the external `wardrobe` launcher. These remain for compatibility and diagnosis. Once native adoption is initialized, `/wardrobe use` follows the native clean-handoff behavior above.

See [the repository standard](../../docs/preset-repository-standard.md) and [Chinese guide](../../docs/usage.zh-CN.md).

## Preset presentation adapters

After recording a preset at session start or first adoption, Wardrobe sets its default above-composer `wardrobe` widget, then emits `wardrobe:preset` through Pi's event bus with `{profile: {id, name, version}, ui}`. The event is not replayed. Subscribe during extension initialization, before `session_start`, to receive the initial announcement; `pi.events.on(event, listener)` returns an unsubscribe function. Event subscribers should release subscriptions on shutdown/reload. A preset switch starts a new runtime, whose session start announces the new preset. A preset extension may use this public event to present its identity through native UI APIs. Pi-statusline consumes native extension statuses; its own README/settings define whether those rows are visible.

## Model workflow tool

The native `/wardrobe update` command and generated Update skills start with human review. Direct tool clients can request the same flow with `update` and `review: "human"`. Call `propose` with one row per user-visible outcome, up to six, and a sentence on what will be verified. A single outcome needs only its row and validation. Include material preservation in that row and add a reason for a consequential trade-off. A declined or unavailable native confirmation keeps the report in `WAITING_INPUT`. Resume to see it again. A positive response saves `PLAN_APPROVED` and ends the report turn. A second `/wardrobe update` or `resume` starts implementation. Before implementation, `--revise` or `revise: true` reopens either a pending or an approved report. Installing still requires a separate verified artifact and installation authorization.

`wardrobe_workflow` starts `update` or `maintain` from an installed `profile` or local `source`; maintenance requires a concrete `request`. The returned `skills.shared` method and frozen `skills.preset` policy load together. New tasks expose the complete item list, required decision coverage and `changes` evidence index. `focus(item)` selects any current item and its focused evidence without imposing an order or gating independent saves. Safe incoming files are available together. Runtime release notes retain the original version-interval document, not mandatory page-sized submissions.

Use `save` to merge partial `{summary, decisions, resources, migrations, checks, obligations, work}` submissions without verification. The focused `nextCall` supplies a partial-save template containing that item's decision IDs; replace the placeholder action/reason with the actual decision. Decisions and implementation work are keyed by ID; resource operations retain order. `replace: true` replaces review fields while preserving declared implementation obligations. Item states, saved decisions and blockers form the durable decision ledger. `details` recovers that ledger and candidate work. A blocker names its item, reason and finite `nextStep`; `resolvedBlockers` reopens it. A blocked item leaves independent work available but unresolved required work prevents final verification and installation.

For compound requests, declare bounded `work` with `{id, origins, goal, paths, checks, dependsOn?, missingFact?}`. Origins reference existing requirement or decision IDs; dependencies reference other implementation IDs. Focus `implementation:<id>` for its goal, affected paths, linked evidence, contract pointers and public integration APIs. Save `{id, ready:true}` when implemented; the program binds this claim to affected candidate inputs and invalidates it when those inputs change. New explicit Update requests require implementation coverage even after the request decision is saved. Simple Maintain fixes retain the existing single-item path. Structural validation does not prove natural-language coverage; frozen product acceptance remains necessary.

Action `check` runs the focused implementation's exact checks in actual staged dependencies with disposable HOME/Pi directories. It reports partial evidence and never permits installation. Final verification includes all declared implementation checks and reuses earlier outcomes only when candidate, check, dependencies and runtime still match. When broadening investigation, save a named `missingFact` with `question`, `why` it changes the decision and finite `nextStep`; ordinary related reads and edits require no extra management calls.

Decisions use `adopt`, `adapt`, or `defer` with reasons. Resource changes use `{action: add|replace|enable|disable|retire, package, kind, path, oldPath?, enabled?, upstreamPath?}`. `package` is an alias declared in `preset.json.packages` such as `self` or `addon-7`, not an npm/git source; `path` and `oldPath` are safe relative resource paths. Save validates the merged resource draft before persisting it and returns the failing operation index, field and allowed values. Migrations use `{from: [paths], to: [paths], reason}`. Checks use `{command, args, reason}`. The program restores its own frozen lineage before compiling reviewed declarations, copies adopted skills with companions, materializes exact dependencies, and checks affected behavior. Optional ambiguous features may be deferred with reasons. Call final `verify` after complete coverage and blocker resolution; it merges the saved review and supplied submission, then checks coverage and the actual candidate. `CHECK_FAILED` opens a focused `verification-repair` item with failed logs and affected files, including resource, validation and staging preflight failures. A legacy invalid resource draft returns a durable `nextCall` with `replace: true` and the complete saved draft; correct the indexed resource operation and repair decision without losing other decisions. Other failures require the appropriate candidate repair and saved decision before verifying again. A later failure reopens the same item without hiding any failed check. The native session supplies workflow coordinates. Legacy `result.json` remains a complete submission, not a partial merge.

`READY_TO_INSTALL` seals the reviewed artifact and rejects further draft saves. Installation requires the current verified source and artifact and promotes an inactive revision. `NO_UPDATE` uses zero model calls; `REVIEWED` finishes without an empty revision; `INSTALLED` returns the receipt. `resume` continues a preserved paused candidate and reopens a watchdog-paused focus with its previous blocker visible; intentional blockers remain blocked until explicitly resolved. Existing protocol-v3 records derive item states from their saved drafts without destructive migration.

Substantive candidate, decision, implementation and check-plan changes count as delivery; rephrased summaries, reasons and missing facts do not renew delivery. New observations count only as investigation activity. Each focus has separate inactivity and no-delivery recovery. Eight turns without delivery, or without any activity, produce a recovery hint; eight further unproductive turns block that focus and hand recovery to an available independent item with its own prior progress. The handoff refreshes the native handle and context epoch; ordinary work order remains model-selected. An unfocused recovery uses the same fallback, and exhaustion with no independent work still stalls. Previously seen candidate/draft states and changing observations alone do not extend delivery indefinitely. Native history, user constraints and the ledger remain available across focus changes; repeated read ranges are represented once in the model view. Native configuration and model selection remain unchanged.

Failed tool calls stay in Pi's native agent loop: the model receives the failure and issues a corrected or different call, never an automatic replay of potentially side-effecting work. At the no-delivery boundary, `toolUse` continuation gets at most two recovery continuations; three consecutive tool failures exhaust correction earlier. Delivery, focus changes and resume reset these counters. Provider retries remain Pi-owned, and final settlement still uses the existing bounded continuation before pausing.

The manager ships the common `wardrobe-update` and `wardrobe-maintain` skills. A preset may supply `skills/preset-policy/SKILL.md`. `guidance` with `skills: ["update", "maintain"]` creates thin delegates and archives previous skill text, including local changes to previously generated entries. Basic runtime loading runs automatically when Pi changes; concrete failures remain visible while independent work continues. `probe` checks the current candidate early. Final verification also runs new/edited tests, real native startup, and affected TUI rendering/reload checks without model calls. Explicit checks cover semantics generic probes cannot infer.

Each newly discovered upstream skill has a separate required adopt/adapt/defer decision and reason. Adopting the repository revision alone does not complete its capability review. This records the review; it does not prove the model's judgment or that an adopted skill is usable in Pi.

Before registering a newly installed revision, Wardrobe uses the installed Pi resource resolver to check that every selected resource is discoverable through package exports and filters. Directory selections become descendant filters over Pi’s exported resources; unexported helpers remain excluded. Missing exports fail installation with the affected package and path. This discovers paths without importing extensions or running package scripts; runtime behavior still needs affected checks.

Update/maintain validation also rejects newly broken literal local Markdown links in `SKILL.md`, including removed reference targets. Paths resolve from the skill directory. It skips code examples and existing unrelated broken links, and returns affected files and resolved paths to the model.

Native commands and the tool share the same engine. New workflows apply safe incoming changes across the complete review. Exact package staging revalidates registry metadata with `prefer-online` instead of trusting a stale packument; npm's artifact cache remains available. Program-owned lineage is restored before checks, while `manifest.piVersion` advances to the actual current Pi before the candidate digest is captured. Checks run in the actual materialized candidate package, with exact candidate dependencies and isolated HOME/Pi directories without provider credentials. Each isolated check agent links the staged `git` and `npm` dependency directories so package-resolution checks exercise the real artifacts; authentication files are never copied. Pi's real resource loader checks selected extensions; declared affected behavior checks supplement it. Successful earlier evidence is reused until its inputs or shared environment change. Installation registers the same stable artifact without rerunning scripts or changing defaults. Isolation is configuration isolation, not an operating-system sandbox.

Conflicts include ready-to-read upstream and local patches against the exact old base. All selected checks return their outcomes together; cancellation stops their process group and invalidates verification. The handoff identifies the installed Pi CLI and package roots explicitly. Baseline dependencies are read-only inputs, not proof that candidate package changes work. Resource discovery reports all missing selected exports together without importing extension code.

An open workflow resumes the same request and candidate. After installation, a new task starts from the selected installed revision in a fresh workspace; earlier candidates remain as evidence. A Pi version change also requires fresh preparation. Repeating a successful workflow install or unchanged draft save returns the original revision. Saved drafts must be edited through a new draft. Available presets, session switching and project startup defaults do not require first-use global configuration adoption.

The evidence index’s `releaseNotes` supplies the exact Pi changelog interval (also on `BLOCKED`), Git commit subjects and changed paths for each cached old/new range, and target npm package CHANGELOG/README documents. Git subjects are labelled as commit evidence, not published release notes. Missing or timed-out npm documents have explicit statuses and metadata/repository release channels. Optional downloads have a 15-second deadline, never run install scripts, and cache by registry, exact version and available artifact integrity. Start with these inputs; scanning entire partial Git caches can trigger unrelated blob downloads.

Source-wide/new-skill capability changes also provide exact text patches through `capabilities[].inputs`, fetching only absent blobs for changed text paths in one batch. Images and lock files are excluded from that optional text context. For a requested replacement, `lookup` with a package keyword returns npm candidates; `lookup` with an exact `npm:<name>@<version>` returns verified package documents and Pi declarations without installing it. The agent chooses its value and adaptation.
