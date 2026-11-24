> Wardrobe reviewed baseline: Pi 1.3.0. Runtime/extension installation uses native `pi update`; source maintenance follows `docs/wardrobe-maintenance.md`. The native manager, all enabled Full extensions, skill discovery and the composer widget were exercised in isolated Pi 1.3.0 fixtures. No account model requests were made. Earlier version sections below are historical.

# Pi Runtime Compatibility

Perfect Pi treats Pi updates as a continuing compatibility requirement, not an automatic environment upgrade.

## Version Policy

- `manifest.json:piVersion` is the reviewed baseline. Doctor continues to report a different installed version as `DRIFTED`.
- `node scripts/check-pi-updates.mjs` queries the official npm package's stable release and reports patch/minor/major updates. It changes no pins or resources.
- `node scripts/check-pi-compatibility.mjs` checks required Pi exports, settings APIs, the settings-storage bridge, and actual loading of every managed TypeScript extension. Version drift is reported separately from API compatibility.
- `node scripts/check-sol-pi-contract.mjs --json` verifies the maintained SoL-Pi source hashes and its imported module contracts.
- The host runtime may come from the official managed install (`~/.pi/agent/install`, `releases-v1` layout, selected by `current-version`) or from an npm installation. `scripts/pi-runtime.mjs` searches the managed layout first, then the agent and global npm layouts, and resolves the `pi` launcher through `PATH`. `PI_MANAGED_INSTALL_ROOT` and `PI_GLOBAL_NODE_MODULES` override discovery. Retained older releases are never selected ahead of the active one. `agentDir: null` disables host-directory discovery for isolated tests.

## Continuous Verification

`.github/workflows/pi-compatibility.yml` is a standalone-source workflow template for pull requests, main/master pushes, a daily schedule, and manual dispatch. GitHub does not execute it while it is nested under presets/perfect-pi in the parent repository; configuring a parent workflow is separate work. It installs Pi only in an isolated GitHub runner. Two jobs test the manifest baseline and npm's latest stable release against the same pinned SoL-Pi revision. Each runs the compatibility checks, regression suite and skill audit without provider credentials or remote model requests.

The workflow has read-only repository permissions. It does not create pull requests, move pins, publish packages, change local environments, or automatically accept a new major version. A failed latest-version job is a canary requiring investigation, not permission to suppress a failing test.

## Upgrade Procedure

1. Run the update check and read the candidate's official changelog, configuration, compaction and extension documentation.
2. Verify API contracts and lifecycle behavior against the candidate in an isolated runtime. Pay particular attention to session replacement, cancellation, trust, provider authentication, settings persistence and usage accounting.
3. Adapt every affected consumer and add regressions; search CLI tool filters, extension activation, settings locks, compaction and shutdown paths explicitly. Preserve local consent, budget, phase-boundary, guardrail and resource-ownership policies. Use `skills/maintain/references/integration.md` for new capabilities; connected servers and unchanged API exports alone are insufficient.
4. Run the regression suite, both contract checkers and skill audit. For terminal UI changes, exercise the actual selector/rendering paths, including cancellation and concurrent tools.
5. Advance `manifest.json:piVersion` only after review and evidence. Updating the live runtime or syncing managed resources requires separate approval. After installing a new Pi runtime, quit and restart the Pi process, then run doctor; `/reload` does not replace the running host runtime. After syncing only managed resources, use `/reload` and run doctor.

## Pi 1.0.0–1.3.0 maintenance review (2026-10-20)

Official release notes were compared with the installed 1.3.0 implementation, extension event types, tool selection, model/settings bridge and SoL consumers. This review keeps 1.3.0 as the verified baseline; it does not upgrade Pi or extension packages.

| Releases | Relevant change | Preset decision and evidence |
| --- | --- | --- |
| 1.0.0 | Leaner native codemode; image generation; fullscreen/header startup | Retain native codemode and additive defaults; disclose image recipes on demand instead of repeating the full API in every prompt. Existing native tool tests cover discovery. Image API requests remain untested. |
| 1.0.1 | Project MCP overrides; tool renderers; inline Anthropic tool changes | Preserve native project trust/overrides and renderer integration. No replacement MCP stack or custom model policy. |
| 1.0.2 | Per-thinking-level sampling | Native models.json ownership; no preset model configuration. |
| 1.0.3 | Azure provider rename; image paths; private output permissions; runtime-update restart | Document native migration; keep credentials unmodified. Tests cover isolated evaluator CLI flags and output handling; no Azure account request. |
| 1.0.4 | Tool patterns, no-mcp, image read, frozen codemode builtins, MCP shutdown | Existing CLI isolation/tool restrictions retained. Fused bash uses ctx.executeTool, preserving guards and tool restrictions. |
| 1.1.0 | Additive CLI tools; settlement abort marker; render timing; settings installation layout | Preserve native selection in tools.ts and current-release discovery. Usage reports use native costs rather than recalculating prices. |
| 1.2.0 | Custom before_agent_start events; themes validated at startup; reachesTools; namespace aliases; thinking omitted from summaries | Reviewed all enabled local handlers: none assumes a user prompt. Model habits apply to both run kinds. Native codemode remains responsible for MCP reachability. Pinned cc themes and full startup are verified. Adopt SoL's in-place observation projection and effective compaction settings. |
| 1.3.0 | Resume keeps active tools; prompt template empty arguments; malformed JSON validation; codemode worker bounds; model/cache/provider fixes; overlay ownership | Keep native APIs and overlay completion. Full runtime tests verify load/discovery, tool restrictions and settlement. Provider-specific fixes are inherited, not independently certified with account traffic. |

SoL source under vendor/sol-pi is a three-way merge of local fork 93fd67a, upstream base e1a586a and official 2195680. The adapter retains guarded fusion, current native model, consent/budget and phase gates. source.json pins inputs and hashes merged outputs. The contract checker validates this maintained source, not merely an installed ancestor. See docs/pi-native-capabilities.md for agent-facing use.

## Pi 1.1.0 Review

The reviewed baseline is Pi 1.1.0. Required API contracts, managed extension loading, the pinned SoL-Pi contract and repository regressions passed cleanly on the installed runtime. Evidence is recorded in `docs/experiments/pi-1.1.0-assessment.md`.

- The host runtime is now the official managed install (`releases-v1`): `releases/<version>/node_modules/@earendil-works/pi-coding-agent` with `@earendil-works/pi-ai`, `pi-tui` and `pi-agent-core` as siblings rather than nested dependencies. `scripts/pi-runtime.mjs` and `scripts/check-sol-pi-contract.mjs` resolve both layouts. A Pi upgrade changes this path; after installing a release, re-run doctor before trusting a resource sync.
- `pi update` keeps the new release and the one it updated from. `scripts/pi-runtime.mjs` follows `current-version` and orders retained releases newest first, so an upgrade does not leave extensions loading an older runtime.
- `--tools` accepts a list of only `+name`/`-name` entries to change the default selection instead of replacing it. Plain names and modifiers still cannot be mixed, and `--exclude-tools` remains the pattern-based denylist. `defaultTools` semantics are unchanged, so `manifest.json:defaultSettings.defaultTools` needs no migration. `global/extensions/tools.ts` snapshots the runtime's resolved selection when any CLI tool flag is present, so it stays correct under both allowlist and modifier semantics.
- `agent_settled` now carries `aborted`, and `tool_execution_end` and the tool render context carry `durationMs`; `outputPad` also applies to `!` command, tool and summary output. No managed extension consumes these fields. `structured_output` is a model-invoked tool, not a settled-event handler, so a cancelled run cannot emit a structured result. Adopt `aborted` only when an integration needs to distinguish a cancelled run, such as the deferred tmux worker status stream.
- `codemode` output items are now separated by `==> text N/M <==` markers with console output in one `<console_output>` block, and `searchTools()`/`describeTool()`/`describeNamespace()` are documented as async. Managed guidance already assumes the awaited form.
- `showExtensionSelector` reports program status through the interactive mode, so test fixtures that call it must provide `programStatus.setBlocked`. Managed selectors are unaffected at runtime.
- Provider-side fixes (prompt-length pricing tiers, Bedrock thinking level, `server_busy` retry, 3.5 characters per token context estimate) are native. `scripts/session-usage.mjs` aggregates the usage and cost object Pi reports and does not price tokens itself, so corrected costs flow through without a code change. Cost claims still require a measured scope.

## Pi 1.0.4 Review

The reviewed baseline is Pi 1.0.4. Required API contracts, managed extension loading, the pinned SoL-Pi contract and repository regressions passed cleanly on the installed runtime. Evidence is recorded in `docs/experiments/pi-1.0.4-assessment.md`.

- `--tools` and `--exclude-tools` now support `*` patterns (e.g. `'mcp__*'`, `'mcp__radius__*'`), and `--no-mcp` disables MCP for one run. `--tools` preserves MCP tools unless explicitly filtered with `mcp__`. The skill trigger and description-improvement subprocesses now explicitly disable MCP, user extensions and ambient project instructions; tool selection alone is not an isolation boundary.
- `tools.read()` on image files now provides an image block for `image()`, enhancing codemode visual workflows.
- QuickJS built-in prototypes are frozen before codemode execution, preventing prototype tampering (`Array.prototype.toJSON = ...`).
- MCP OAuth sign-in properly registers native OpenID Connect clients, fixing `invalid_redirect_uri` on compliant endpoints. MCP session shutdowns safely await server connections.
- Prompt rules cleanly omit tools hidden by `prepareLoadout`, avoiding phantom tool confusion.

## Pi 1.0.3 Review

The reviewed baseline is Pi 1.0.3. Required API contracts, managed extension loading, the pinned SoL-Pi contract and repository regressions passed on the installed runtime. These checks do not prove every upstream provider or terminal fix end to end. Evidence and untested paths are recorded in the repository-only `docs/experiments/pi-1.0.3-assessment.md`; setup does not copy that assessment to the agent directory.

- Azure users must migrate `azure-openai-responses` to `azure` in their provider configuration, including authentication, model definitions, `defaultProvider`, `enabledModels` and `modelThinkingLevels`. `AZURE_OPENAI_*` environment variables are unchanged. Resumed sessions using the old provider may fall back and lose prompt-cache reuse. No repository-owned Azure configuration needs migration; maintenance does not inspect or rewrite private credentials.
- Codemode `image()` now adds a temporary file path alongside the visual attachment. Use the reported path, not a guessed filename or extension. Saving can fail while the attachment remains available; confirm that a path was returned before copying. A temporary path is not a durable project asset. This capability does not authorize an image API request or change prototype's web image handoff policy.
- Pi-created output files use user-only permissions (0600 on POSIX) and exclusive creation. Do not relax permissions or disclose files to another user or service without authorization. SoL-Pi's `obs_recall` uses its own observation archive; it is not a native Pi output-file reader.
- `Home`/`End` move the editor cursor to the line boundaries. `Ctrl+Home`/`Ctrl+End` navigate the fullscreen transcript. No managed extension explicitly binds those keys; actual terminal behavior remains an upstream runtime concern.
- Pi adds recovery handling for cancelled OAuth refresh, a removed running installation and a disappearing terminal. If an on-disk runtime update causes codemode errors, restart Pi rather than relying on `/reload`.

## Compaction Model

This Wardrobe preset uses native Pi compaction and model selection. Configure models and authentication through Pi. Model policy adapters are excluded from the enabled resources; their source and compatibility canaries are retained as upstream maintenance references.
