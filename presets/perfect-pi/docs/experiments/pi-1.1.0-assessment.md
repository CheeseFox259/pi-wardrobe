# Pi 1.1.0 Maintenance Assessment

## Scope and Decision

Review Pi 1.1.0 (released 2026-10-07) against Perfect Pi's 1.0.4 baseline. The user installed 1.1.0 with the official managed installer (`curl -fsSL https://pi.dev/install.sh | sh`) before this turn; this maintenance did not install or replace the host runtime. The update broke `pi` startup, because `global/extensions/compaction-model.ts` resolves `FileSettingsStorage` through `scripts/pi-runtime.mjs` and the managed install layout was not a known runtime location. The layout gap was repaired, hardened and covered by regressions before the baseline advanced.

## Root Cause of the Startup Failure

`global/extensions/compaction-model.ts` cannot import `@earendil-works/pi-coding-agent` through standard ESM resolution, so it falls back to `detectPiRuntime()` in `scripts/pi-runtime.mjs`. Before this update that search covered `PI_GLOBAL_NODE_MODULES`, `<agent-dir>/npm/node_modules`, the Windows npm layouts, the npm global root, Node `execPath` prefixes, system lib directories and the local `node_modules`. The official managed install (`~/.pi/agent/install`, layout `releases-v1`) matched none of them, so the resolver returned `null` and the extension aborted with `Pi runtime not found`. Every Pi host command, including the launcher that loads the extension, failed.

The same release changed the dependency layout to siblings rather than nested packages: `releases/1.1.0/node_modules/@earendil-works/` holds `pi-coding-agent`, `pi-ai`, `pi-tui`, `pi-agent-core`, `pi-codemode`, `pi-mcp`, `chord` and `pi-telemetry`. Consumers that hard-coded `<pi-root>/node_modules/@earendil-works/pi-ai` had to learn both layouts.

## Release Impact

| Change | Affected consumer | Decision | Adaptation |
| --- | --- | --- | --- |
| Managed install `releases-v1` layout, flat `@earendil-works` siblings | `scripts/pi-runtime.mjs`, `scripts/check-sol-pi-contract.mjs`, `global/extensions/compaction-model.ts` (through the resolver) | Adopt | Managed layout is searched first, via `PI_MANAGED_INSTALL_ROOT` or `<agent-dir>/install`; `current-version` wins, retained releases are ordered newest first; `PATH` launcher symlinks are resolved; contract aliases accept nested and flat `pi-ai`/`pi-tui`/`pi-agent-core` |
| `pi update` keeps the previous release | `scripts/pi-runtime.mjs` | Adopt | Newest-first ordering prevents an upgrade from leaving extensions on the retained older runtime, even if `current-version` is missing |
| `--tools` accepts `+name`/`-name` modifier-only lists | `global/extensions/tools.ts`, `manifest.json:defaultSettings.defaultTools`, `scripts/ticket-worker.mjs`, skill-creator eval harness | No change required | The extension snapshots the runtime's resolved selection when any CLI tool flag is present, which is correct for both allowlist and modifier semantics. `defaultTools` semantics are unchanged. `ticket-worker.mjs` passes no tool flags; the eval harness keeps `--tools read --no-mcp --no-extensions --no-context-files --no-skills`, all still valid in 1.1.0 |
| `agent_settled` gains `aborted` | SoL-Pi adapter, `structured_output`, tmux ticket workers | Deferred | No managed extension consumes `agent_settled`. `structured_output` is a model-invoked tool, so a cancelled run cannot emit a structured result. Adopt only when the deferred tmux status stream needs to tell a cancelled run from a finished one |
| `durationMs` in the tool render context and `tool_execution_end`; `outputPad` widened to `!`, tool and summary output | Managed theme package `pi-cc-extensions`, `observe.mjs` | No change required | `pi-cc-extensions@0.9.5` already reads `durationMs` and `outputPad`; the fields are now guaranteed by the runtime. Perfect Pi owns no tool renderer for these fields |
| Codemode output item separators, async discovery helpers | Managed guidance and codemode callers | No change required | `AGENTS.md` and skill guidance already use the `==> text N/M <==` and `<console_output>` forms and await `searchTools()`/`describeTool()`/`describeNamespace()` |
| Program status reporting (OSC 7501, `PI_PROGRAM_STATUS`) | Interactive mode, `scripts/tmux-dashboard.mjs` observability | Deferred | Detection is terminal-side. No verified consumer need; the tmux dashboard reads worker stdout and exit codes, which a terminal escape sequence does not improve |
| `showExtensionSelector` reports program status | `question.ts`, `questionnaire.ts`, `compaction-model.ts`, extension test fixtures | Test fixture update | The interactive mode always provides `programStatus`; fixtures calling the selector must provide `programStatus.setBlocked` |
| Live `/mcp` manager, cancellable OAuth sign-in, shutdown token refresh | `global/extensions/mcp-settings.ts` | No change required | The extension registers `mcp-setup`, `mcp-key` and `mcp-project` and does not replace native `/mcp` |
| Provider cost, retry and context-estimate fixes | `scripts/session-usage.mjs` | No change required | Usage aggregation sums the `cost` object Pi reports and does not price tokens itself, so corrected costs and new keys flow through |
| `Claude Haiku 5.5`, GPT-6 Luna, llama.cpp decision models | `global/extensions/subagent-policy.ts`, `global/extensions/model-habits.ts` | Deferred | New model choices only. The subagent allowlist and habit corrections are per-model entries a user adds deliberately; no pinned model became invalid |
| Provider auth, Termux, Herdr, Bedrock, Radius fixes | None | Not applicable | No managed layer depends on these paths |

## Sources

- Official installed Pi 1.1.0 `CHANGELOG.md`, release section `[1.1.0]`, plus `docs/cli.md`, `docs/settings.md` and the installed `dist/` implementation (`core/settings-manager.js`, `core/sdk.js`, `core/agent-session.js`, `cli/args.js`, `modes/interactive/program-status-reporter.js`).
- Installed package: `@earendil-works/pi-coding-agent@1.1.0` at `~/.pi/agent/install/releases/1.1.0/node_modules`, layout `releases-v1`, launcher `~/.local/bin/pi` -> `~/.pi/agent/bin/pi`.
- Repository contracts: `scripts/check-pi-compatibility.mjs`, `scripts/check-sol-pi-contract.mjs`, `scripts/pi-runtime.mjs`, `pi-runtime.test.mjs`.

## Task-Owned Changes

- `scripts/pi-runtime.mjs`: managed-install discovery, `current-version` pointer, newest-first release ordering, `PATH` launcher resolution, explicit `agentDir: null` opt-out, and `resolvePiSubpackage()` as the single nested-or-hoisted layout seam.
- `scripts/check-sol-pi-contract.mjs`, `sol-pi.test.mjs`, `compaction-model.test.mjs`, `tools-runtime.test.mjs`: use `resolvePiSubpackage()` instead of repeating both candidate paths.
- `pi-runtime.test.mjs`: managed-layout, retained-release, subpackage-layout and host-isolation regressions; explicit `agentDir: null` in existing isolated fixtures.
- `manifest.json`: `piVersion` 1.0.4 -> 1.1.0.
- `habits.test.mjs`: restored the strict doctor exit-code assertion that was relaxed while the baseline was behind the installed runtime.
- `docs/pi-compatibility.md`, `docs/experiments/pi-1.1.0-assessment.md`, `skills/skill-creator/SKILL.md`, `skill-eval.test.mjs`: version-agnostic CLI tool isolation wording.

## Evidence

**Verified** on the installed 1.1.0 runtime, after the baseline advanced and managed resources were re-synced:

- `node scripts/check-pi-updates.mjs`: baseline 1.1.0, latest 1.1.0, no update available.
- `node scripts/check-pi-compatibility.mjs`: `ok: true`, `versionMatchesBaseline: true`, 10 required exports, the `FileSettingsStorage.withLock` bridge, 3 settings APIs and all 12 managed TypeScript extensions loaded with 0 errors.
- `node scripts/check-sol-pi-contract.mjs --json`: `ok: true`, git HEAD matches the pinned SoL-Pi ref, 7 modules and 12 exports verified against the hoisted 1.1.0 layout.
- `node --test *.test.mjs`: 254 tests pass, 0 fail.
- `node skill-audit.mjs`: passed, 0 errors.
- `node doctor.mjs`: `SYNCED`, exit 0, including `SYNCED pi runtime (1.1.0 installed; manifest pins 1.1.0)`, 8/8 packages present, 47/47 required skills, SoL-Pi `Pi compatibility VERIFIED`.
- `node setup.mjs --dry-run` reviewed before sync; the live sync is idempotent (a second run left every managed file's checksum unchanged) and preserved private settings: `perfectPiCompaction`, `defaultProvider`, `defaultModel`, `enabledModels`, `skills` and `packages` were untouched.
- Real user path on the managed install: `pi --mode rpc --no-session --offline` starts with no extension error, answers `get_state`, and `get_commands` registers `compaction-model`, `tools`, `mcp-setup`, `mcp-key`, `mcp-project`, `verify` and `research`. This is the path that failed before the fix. `--offline` keeps startup free of provider requests.

**Not run**: A live end-to-end `pi -t +codemode,-write --print` probe, which would require an external model request. The modifier path is verified from the installed `cli/args.js` -> `core/sdk.js` implementation and the in-runtime `defaultTools: ["+codemode"]` regressions. Terminal-side OSC 7501 program status, Termux clipboard, Herdr link handling, Windows reserved-port login fallback, live MCP OAuth cancellation and per-provider cost accuracy were not exercised.

**Blocked**: None.

**Not applicable**: Reinstalling the host runtime, changing provider credentials, and adopting new upstream models.

## Separate Drift Addressed Afterwards

Six managed npm packages were behind their pins and the `mattpocock/skills` source was ahead of its pin with 30 local overrides outstanding. Both lines were reconciled and verified in the same session; see `docs/experiments/packages-and-skills-update-assessment.md`.

## Restart

The host runtime changed, so `/reload` is not sufficient. Quit and restart `pi`, then run `node doctor.mjs` in this repository.
